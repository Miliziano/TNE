// ─── src-tauri/src/odbc.rs ────────────────────────────────────────
//
// ODBC (P344, fetta 1 = LETTURA): Oracle, Informix e ODBC generico.
//
// PERCHE' ODBC. `sqlx` non parla ne' Oracle ne' Informix; Informix non ha un
// driver Rust utilizzabile, quindi ODBC e' l'unica via, e per avere un solo
// percorso ci passa anche Oracle (decisione in HANDOFF.md, "Oracle e Informix").
// Il dialetto `odbc` (generico) apre qualunque altra sorgente ODBC (SQL Server,
// DB2, ...) con un DSN o una connection string.
//
// PREREQUISITI (sulla macchina che esegue, NON nell'artifact):
//   - gestore ODBC: su Windows c'e' gia'; su Linux/macOS il pacchetto unixODBC
//     (collegato DINAMICAMENTE: libodbc.so.2 / libodbc.2.dylib — scelta di
//     licenza, unixODBC e' LGPL);
//   - il driver del fornitore: Oracle Instant Client + pacchetto ODBC, IBM
//     Informix Client SDK (CSDK). Indicato per NOME (registrato in odbcinst.ini)
//     oppure per PERCORSO della libreria.
//
// MODELLO DI ESECUZIONE. `odbc-api` e' bloccante: ogni operazione gira in
// `spawn_blocking`, mai sul thread del runtime async. Le connessioni stanno in
// un piccolo pool per (lane, risorsa) — la stessa regola dei pool sqlx in
// engine/pool.rs: si aprono al primo uso e si chiudono in close_all().
//
// TIPI (stessa politica del lettore Postgres, source_db::pg_col_to_value):
//   - NUMERIC/DECIMAL → Decimal ESATTO (mai f64). Scala 0 e precisione <= 18 →
//     Int (gli identificativi Oracle sono NUMBER(10) e devono restare interi).
//     Oltre la portata di Decimal (28 cifre; Oracle arriva a 38) → Stringa con
//     il valore esatto: meglio una stringa giusta che un numero sbagliato.
//   - DATE → Date "YYYY-MM-DD"; TIMESTAMP → DateTime nella stessa forma del
//     lettore Postgres; TIME → Stringa.
//   - binari → come Postgres (testo se e' UTF-8, altrimenti `\x…`).
// Ogni cella si legge come TESTO (UTF-8 su Linux/macOS, UTF-16 su Windows) e si
// converte dal tipo dichiarato dal driver: nessuna perdita, nessun round-trip
// binario dipendente dal driver.

use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, Ordering};

use odbc_api::buffers::{ColumnarBuffer, TextColumn};
use odbc_api::parameter::{InputParameter, VarCharBox};
use odbc_api::{
    Bit, Connection, ConnectionOptions, Cursor, DataType, Environment, IntoParameter,
    Nullability, ResultSetMetadata,
};

use crate::engine::types::{Row, Value};

/// Dialetti serviti da ODBC.
pub fn is_odbc_dialect(dialect: &str) -> bool {
    matches!(dialect, "oracle" | "informix" | "odbc")
}

/// Nome del driver Informix registrato dall'installazione standard del CSDK.
const INFORMIX_DEFAULT_DRIVER: &str = "IBM INFORMIX ODBC DRIVER";

/// Lunghezza massima (in caratteri) di una cella di testo di cui il driver non
/// dichiara la dimensione (CLOB, TEXT, LVARCHAR lunghi). Oltre → errore esplicito
/// di troncamento, mai un valore tagliato in silenzio.
const LONG_TEXT_CHARS: usize = 64 * 1024;
/// Righe per lotto: tante se le colonne sono corte, poche se ce n'e' una lunga
/// (il buffer e' righe × larghezza massima).
const BATCH_ROWS_SHORT: usize = 1000;
const BATCH_ROWS_LONG: usize = 64;

/// Unita' di testo del buffer: byte UTF-8, oppure UTF-16 su Windows.
#[cfg(not(windows))]
type Ch = u8;
#[cfg(windows)]
type Ch = u16;
/// Unita' da riservare per carattere (UTF-8 fino a 4 byte; UTF-16 fino a 2 unita').
#[cfg(not(windows))]
const TEXT_UNITS_PER_CHAR: usize = 4;
#[cfg(windows)]
const TEXT_UNITS_PER_CHAR: usize = 2;

#[cfg(not(windows))]
fn decode(units: &[u8]) -> String {
    String::from_utf8_lossy(units).into_owned()
}
#[cfg(windows)]
fn decode(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// Esadecimale (binario letto come testo) → byte. None se non e' esadecimale.
fn hex_to_bytes(h: &str) -> Option<Vec<u8>> {
    let h = h.trim();
    let h = h.strip_prefix("0x").or_else(|| h.strip_prefix("\\x")).unwrap_or(h);
    if h.len() % 2 != 0 {
        return None;
    }
    (0..h.len()).step_by(2).map(|i| u8::from_str_radix(h.get(i..i + 2)?, 16).ok()).collect()
}

// ─── Ambiente ODBC (uno per processo) ─────────────────────────────

fn env() -> Result<&'static Environment, String> {
    static ENV: OnceLock<Result<Environment, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        Environment::new().map_err(|e| format!("cannot initialise the ODBC driver manager: {e}"))
    })
    .as_ref()
    .map_err(|e| e.clone())
}

// ─── Connection string ────────────────────────────────────────────

/// Parametri di connessione, presi dalla risorsa (motore) o dalla richiesta
/// dello studio. Tutti i campi vuoti = non indicati.
#[derive(Clone, Debug, Default)]
pub struct OdbcTarget {
    pub dialect: String,
    pub host: String,
    pub port: Option<u16>,
    pub database: String,
    pub user: String,
    pub password: String,
    /// Oracle: nome del servizio (se vuoto si usa `database`).
    pub service_name: String,
    /// Informix: nome del server (DBSERVERNAME, es. `ol_informix`).
    pub db_server_name: String,
    /// Driver: nome registrato in odbcinst.ini oppure percorso della libreria.
    pub driver: String,
    /// DSN configurato sulla macchina (alternativa a driver + host).
    pub dsn: String,
    /// Connection string completa (vince su tutto il resto).
    pub connection_string: String,
    /// Parametri aggiuntivi `CHIAVE=valore;…` (es. `CLIENT_LOCALE=en_US.utf8`).
    pub extra: String,
}

/// Valore di un attributo della connection string: tra graffe se contiene
/// caratteri speciali (`;` separa gli attributi), con `}` raddoppiata.
fn attr(v: &str) -> String {
    if v.contains([';', '{', '}', '=']) || v != v.trim() {
        format!("{{{}}}", v.replace('}', "}}"))
    } else {
        v.to_string()
    }
}

fn has_key(conn_str: &str, key: &str) -> bool {
    conn_str
        .split(';')
        .any(|kv| kv.split('=').next().map(|k| k.trim().eq_ignore_ascii_case(key)).unwrap_or(false))
}

/// Costruisce la connection string ODBC. Precedenza: connection string
/// completa → DSN → driver + parametri del dialetto.
pub fn connection_string(t: &OdbcTarget) -> Result<String, String> {
    let mut cs = String::new();
    let credentials = |cs: &mut String| {
        if !t.user.is_empty() && !has_key(cs, "UID") {
            cs.push_str(&format!("UID={};", attr(&t.user)));
        }
        if !t.password.is_empty() && !has_key(cs, "PWD") {
            cs.push_str(&format!("PWD={};", attr(&t.password)));
        }
    };

    if !t.connection_string.trim().is_empty() {
        cs.push_str(t.connection_string.trim());
        if !cs.ends_with(';') {
            cs.push(';');
        }
        credentials(&mut cs);
    } else if !t.dsn.trim().is_empty() {
        cs.push_str(&format!("DSN={};", attr(t.dsn.trim())));
        credentials(&mut cs);
    } else {
        let driver = match (t.dialect.as_str(), t.driver.trim()) {
            (_, d) if !d.is_empty() => d.to_string(),
            ("informix", _) => INFORMIX_DEFAULT_DRIVER.to_string(),
            ("oracle", _) => {
                return Err("Oracle via ODBC: specify the ODBC driver — the name registered in \
                            odbcinst.ini (e.g. \"Oracle 23 ODBC driver\") or the path of the \
                            library (libsqora.so) — or a DSN"
                    .to_string())
            }
            _ => {
                return Err("generic ODBC: specify a DSN, a connection string, or a driver with \
                            its parameters"
                    .to_string())
            }
        };
        cs.push_str(&format!("Driver={{{}}};", driver.replace('}', "}}")));
        match t.dialect.as_str() {
            "oracle" => {
                let service = if t.service_name.is_empty() { &t.database } else { &t.service_name };
                let host = if t.host.is_empty() { "localhost" } else { &t.host };
                // EZConnect: host:porta/servizio (non serve un tnsnames.ora).
                cs.push_str(&format!("DBQ={};", attr(&format!("{}:{}/{}", host, t.port.unwrap_or(1521), service))));
            }
            "informix" => {
                if !t.host.is_empty() {
                    cs.push_str(&format!("Host={};", attr(&t.host)));
                }
                cs.push_str(&format!("Service={};", t.port.unwrap_or(9088)));
                if !t.db_server_name.is_empty() {
                    cs.push_str(&format!("Server={};", attr(&t.db_server_name)));
                }
                if !t.database.is_empty() {
                    cs.push_str(&format!("Database={};", attr(&t.database)));
                }
                cs.push_str("Protocol=onsoctcp;");
            }
            _ => {}
        }
        credentials(&mut cs);
    }

    let extra = t.extra.trim();
    if !extra.is_empty() {
        cs.push_str(extra);
        if !cs.ends_with(';') {
            cs.push(';');
        }
    }
    Ok(cs)
}

/// Rende leggibile un errore ODBC, con il suggerimento giusto per i casi
/// d'installazione piu' comuni.
fn explain(context: &str, e: impl std::fmt::Display) -> String {
    let msg = e.to_string();
    let hint = if msg.contains("Can't open lib") || msg.contains("file not found") {
        " — the ODBC driver library cannot be loaded: check that the vendor driver is \
         installed and, if you give its NAME, that odbcinst.ini points to the full path of \
         the library (or give the path directly)"
    } else if msg.contains("Data source name not found") || msg.contains("IM002") {
        " — driver or DSN not found: check the name in odbcinst.ini / odbc.ini (odbcinst -q -d \
         lists the drivers)"
    } else {
        ""
    };
    format!("{context}: {msg}{hint}")
}

// ─── Pool di connessioni ──────────────────────────────────────────

struct Inner {
    conn_str: String,
    login_timeout: u32,
    idle: Mutex<Vec<Connection<'static>>>,
    sem: Arc<tokio::sync::Semaphore>,
    closed: AtomicBool,
}

/// Pool di connessioni ODBC per (lane, risorsa). Clone = clone di Arc.
#[derive(Clone)]
pub struct OdbcPool {
    inner: Arc<Inner>,
}

/// Connessione presa in prestito dal pool. Al drop torna fra le libere (se il
/// pool non e' chiuso e la connessione non e' stata segnata come guasta).
pub struct PooledConn {
    conn: Option<Connection<'static>>,
    inner: Arc<Inner>,
    _permit: tokio::sync::OwnedSemaphorePermit,
    broken: bool,
}

impl PooledConn {
    pub fn conn(&self) -> &Connection<'static> {
        self.conn.as_ref().expect("connessione presente fino al drop")
    }
    /// Dopo un errore la connessione potrebbe essere in uno stato incerto:
    /// non la si rimette nel pool.
    pub fn mark_broken(&mut self) {
        self.broken = true;
    }
}

impl Drop for PooledConn {
    fn drop(&mut self) {
        if let Some(c) = self.conn.take() {
            if !self.broken && !self.inner.closed.load(Ordering::SeqCst) {
                if let Ok(mut idle) = self.inner.idle.lock() {
                    idle.push(c);
                    return;
                }
            }
            drop(c); // SQLDisconnect
        }
    }
}

fn open(conn_str: &str, login_timeout: u32) -> Result<Connection<'static>, String> {
    let env = env()?;
    env.connect_with_connection_string(
        conn_str,
        ConnectionOptions { login_timeout_sec: Some(login_timeout.max(1)), ..Default::default() },
    )
    .map_err(|e| explain("ODBC connection failed", e))
}

impl OdbcPool {
    /// Crea il pool aprendo SUBITO una connessione: un errore di connessione
    /// emerge qui (come per i pool sqlx), dove il retry "prima operazione" lo
    /// puo' ritentare.
    pub async fn connect(conn_str: String, max: u32, login_timeout: u64) -> Result<OdbcPool, String> {
        let lt = login_timeout.min(u32::MAX as u64) as u32;
        let cs = conn_str.clone();
        let first = tokio::task::spawn_blocking(move || open(&cs, lt))
            .await
            .map_err(|e| format!("ODBC connection task failed: {e}"))??;
        Ok(OdbcPool {
            inner: Arc::new(Inner {
                conn_str,
                login_timeout: lt,
                idle: Mutex::new(vec![first]),
                sem: Arc::new(tokio::sync::Semaphore::new(max.max(1) as usize)),
                closed: AtomicBool::new(false),
            }),
        })
    }

    /// Prende una connessione (libera o nuova). Attende se sono tutte in uso.
    pub async fn acquire(&self) -> Result<PooledConn, String> {
        let permit = self
            .inner
            .sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "ODBC pool closed".to_string())?;
        let inner = self.inner.clone();
        let conn = tokio::task::spawn_blocking(move || -> Result<Connection<'static>, String> {
            loop {
                let c = inner.idle.lock().map_err(|_| "ODBC pool poisoned".to_string())?.pop();
                match c {
                    // Una connessione rimasta ferma puo' essere caduta (timeout
                    // del server, rete): si verifica prima di riusarla.
                    Some(c) if !c.is_dead().unwrap_or(true) => return Ok(c),
                    Some(dead) => drop(dead),
                    None => return open(&inner.conn_str, inner.login_timeout),
                }
            }
        })
        .await
        .map_err(|e| format!("ODBC connection task failed: {e}"))??;
        Ok(PooledConn { conn: Some(conn), inner: self.inner.clone(), _permit: permit, broken: false })
    }

    /// Chiude le connessioni libere; quelle in uso si chiudono al rilascio.
    pub async fn close(&self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        self.inner.sem.close();
        let idle: Vec<Connection<'static>> = match self.inner.idle.lock() {
            Ok(mut v) => v.drain(..).collect(),
            Err(_) => Vec::new(),
        };
        let _ = tokio::task::spawn_blocking(move || drop(idle)).await;
    }
}

// ─── Parametri (R8) ───────────────────────────────────────────────

/// Valori da legare ai `?`, tipizzati quanto basta perche' il server li
/// confronti con le colonne senza conversioni ambigue. Decimal, date e JSON
/// viaggiano come testo esatto (mai f64).
pub fn bind_params(values: &[Value]) -> Vec<Box<dyn InputParameter>> {
    values
        .iter()
        .map(|v| -> Box<dyn InputParameter> {
            match v {
                Value::Null => Box::new(VarCharBox::null()),
                Value::Bool(b) => Box::new(Bit::from_bool(*b)),
                Value::Int(i) => Box::new(*i),
                Value::Float(f) => Box::new(*f),
                Value::Decimal(d) => Box::new(d.to_string().into_parameter()),
                Value::String(s) | Value::Date(s) | Value::DateTime(s) => Box::new(s.clone().into_parameter()),
                Value::Object(j) => Box::new(j.to_string().into_parameter()),
            }
        })
        .collect()
}

// ─── Lettura ──────────────────────────────────────────────────────

/// Descrizione di una colonna del risultato.
#[derive(Clone, Debug)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: DataType,
    #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
    pub nullable: bool,
}

#[cfg_attr(not(feature = "desktop"), allow(dead_code))] // usata dai comandi dello studio
/// Nome SQL standard del tipo, con precisione/scala dove contano. E' quello che
/// vede lo studio (`db_type`): lo mappa a un tipo logico come per gli altri DB.
pub fn type_name(dt: &DataType) -> String {
    let len = |l: &Option<NonZeroUsize>| l.map(|n| format!("({})", n)).unwrap_or_default();
    match dt {
        DataType::Unknown => "UNKNOWN".into(),
        DataType::Char { length } => format!("CHAR{}", len(length)),
        DataType::WChar { length } => format!("NCHAR{}", len(length)),
        DataType::Varchar { length } => format!("VARCHAR{}", len(length)),
        DataType::WVarchar { length } => format!("NVARCHAR{}", len(length)),
        DataType::LongVarchar { .. } => "LONGVARCHAR".into(),
        DataType::WLongVarchar { .. } => "NLONGVARCHAR".into(),
        DataType::Numeric { precision, scale } => format!("NUMERIC({},{})", precision, scale),
        DataType::Decimal { precision, scale } => format!("DECIMAL({},{})", precision, scale),
        DataType::Integer => "INTEGER".into(),
        DataType::SmallInt => "SMALLINT".into(),
        DataType::TinyInt => "TINYINT".into(),
        DataType::BigInt => "BIGINT".into(),
        DataType::Float { precision: 0 } => "FLOAT".into(),
        DataType::Float { precision } => format!("FLOAT({})", precision),
        DataType::Real => "REAL".into(),
        DataType::Double => "DOUBLE".into(),
        DataType::Bit => "BIT".into(),
        DataType::Date => "DATE".into(),
        DataType::Time { .. } => "TIME".into(),
        DataType::Timestamp { .. } => "TIMESTAMP".into(),
        DataType::Binary { length } => format!("BINARY{}", len(length)),
        DataType::Varbinary { length } => format!("VARBINARY{}", len(length)),
        DataType::LongVarbinary { .. } => "LONGVARBINARY".into(),
        DataType::Other { data_type, .. } => format!("OTHER({})", data_type.0),
    }
}

fn is_binary(dt: &DataType) -> bool {
    matches!(dt, DataType::Binary { .. } | DataType::Varbinary { .. } | DataType::LongVarbinary { .. })
}

/// Larghezza massima (caratteri per il testo, byte per i binari) da riservare
/// nel buffer; `true` se e' una colonna "lunga" (dimensione ignota o enorme).
fn width(dt: &DataType) -> (usize, bool) {
    let sized = |l: &Option<NonZeroUsize>| match l {
        Some(n) if n.get() <= LONG_TEXT_CHARS => (n.get(), false),
        _ => (LONG_TEXT_CHARS, true),
    };
    match dt {
        DataType::Char { length }
        | DataType::WChar { length }
        | DataType::Varchar { length }
        | DataType::WVarchar { length }
        | DataType::Binary { length }
        | DataType::Varbinary { length } => sized(length),
        DataType::Numeric { precision, .. } | DataType::Decimal { precision, .. } => (precision + 3, false),
        DataType::Integer | DataType::SmallInt | DataType::TinyInt | DataType::BigInt => (24, false),
        DataType::Float { .. } | DataType::Real | DataType::Double => (40, false),
        DataType::Bit => (8, false),
        DataType::Date => (16, false),
        DataType::Time { .. } => (32, false),
        DataType::Timestamp { .. } => (40, false),
        _ => (LONG_TEXT_CHARS, true),
    }
}

fn describe<C: ResultSetMetadata>(cur: &mut C) -> Result<Vec<ColumnMeta>, String> {
    let n = cur.num_result_cols().map_err(|e| explain("ODBC metadata", e))?;
    let mut out = Vec::with_capacity(n.max(0) as usize);
    for i in 1..=n.max(0) as u16 {
        let name = cur.col_name(i).map_err(|e| explain("ODBC column name", e))?;
        let data_type = cur.col_data_type(i).map_err(|e| explain("ODBC column type", e))?;
        let nullable = !matches!(cur.col_nullability(i), Ok(Nullability::NoNulls));
        out.push(ColumnMeta {
            name: if name.is_empty() { format!("col_{}", i - 1) } else { name },
            data_type,
            nullable,
        });
    }
    Ok(out)
}

/// Testo di una cella → Value secondo il tipo dichiarato dal driver.
pub fn cell_value(dt: &DataType, text: &str) -> Value {
    let t = text.trim();
    match dt {
        DataType::Integer | DataType::SmallInt | DataType::TinyInt | DataType::BigInt => {
            t.parse::<i64>().map(Value::Int).unwrap_or_else(|_| Value::String(text.to_string()))
        }
        DataType::Numeric { precision, scale } | DataType::Decimal { precision, scale } => {
            if *scale == 0 && *precision <= 18 {
                if let Ok(i) = t.parse::<i64>() {
                    return Value::Int(i);
                }
            }
            // `from_str_exact` rifiuta cio' che andrebbe arrotondato (oltre 28
            // cifre): in quel caso il testo esatto, mai un numero sbagliato.
            match rust_decimal::Decimal::from_str_exact(t) {
                Ok(d) => Value::Decimal(d),
                Err(_) => Value::String(text.to_string()),
            }
        }
        DataType::Float { .. } | DataType::Real | DataType::Double => {
            t.parse::<f64>().map(Value::Float).unwrap_or_else(|_| Value::String(text.to_string()))
        }
        DataType::Bit => match t {
            "1" | "t" | "T" | "true" | "TRUE" | "True" | "y" | "Y" => Value::Bool(true),
            "0" | "f" | "F" | "false" | "FALSE" | "False" | "n" | "N" => Value::Bool(false),
            _ => Value::String(text.to_string()),
        },
        DataType::Date => match chrono::NaiveDate::parse_from_str(t.get(..10).unwrap_or(t), "%Y-%m-%d") {
            Ok(d) => Value::Date(d.to_string()),
            Err(_) => Value::String(text.to_string()),
        },
        DataType::Timestamp { .. } => {
            match chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S%.f")
                .or_else(|_| chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S%.f"))
            {
                Ok(dt) => Value::DateTime(dt.to_string()),
                Err(_) => match chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d") {
                    Ok(d) => Value::DateTime(d.and_hms_opt(0, 0, 0).unwrap_or_default().to_string()),
                    Err(_) => Value::String(text.to_string()),
                },
            }
        }
        _ => Value::String(text.to_string()),
    }
}

/// Binario → come il lettore Postgres (testo se UTF-8 senza NUL, altrimenti `\x…`).
fn bytes_value(b: &[u8]) -> Value {
    match std::str::from_utf8(b) {
        Ok(s) if !s.contains('\u{0}') => Value::String(s.to_string()),
        _ => {
            let mut out = String::with_capacity(2 + b.len() * 2);
            out.push_str("\\x");
            for byte in b {
                out.push_str(&format!("{:02x}", byte));
            }
            Value::String(out)
        }
    }
}

/// Esegue `query` e consegna le righe a lotti a `on_batch`; se `on_batch`
/// ritorna `false` la lettura si ferma (valle chiusa, run annullato, tetto
/// di righe raggiunto). Bloccante: va chiamata dentro `spawn_blocking`.
pub fn read_rows(
    conn: &Connection<'static>,
    query: &str,
    params: &[Value],
    query_timeout: Option<u64>,
    mut on_batch: impl FnMut(&[ColumnMeta], Vec<Row>) -> bool,
) -> Result<Vec<ColumnMeta>, String> {
    let mut stmt = conn.preallocate().map_err(|e| explain("ODBC statement", e))?;
    if let Some(t) = query_timeout.filter(|t| *t > 0) {
        // Non tutti i driver lo supportano: un rifiuto non e' fatale.
        let _ = stmt.set_query_timeout_sec(t.min(usize::MAX as u64) as usize);
    }
    let binds = bind_params(params);
    let cursor = stmt
        .execute(query, binds.as_slice())
        .map_err(|e| explain("ODBC query failed", e))?;
    let Some(mut cursor) = cursor else {
        return Ok(Vec::new()); // istruzione senza risultato
    };
    let cols = describe(&mut cursor)?;
    if cols.is_empty() {
        return Ok(cols);
    }

    // Un buffer di TESTO per colonna (UTF-8; UTF-16 su Windows, dove il testo
    // "stretto" sarebbe nella code page di sistema). I binari arrivano come
    // esadecimale (conversione SQL_C_CHAR standard ODBC) e si ricompongono.
    let mut any_long = false;
    let widths: Vec<usize> = cols
        .iter()
        .map(|c| {
            let (w, long) = width(&c.data_type);
            any_long |= long;
            let chars = if is_binary(&c.data_type) { w * 2 } else { w };
            chars * TEXT_UNITS_PER_CHAR
        })
        .collect();
    let batch_rows = if any_long { BATCH_ROWS_LONG } else { BATCH_ROWS_SHORT };
    let columns: Vec<(u16, TextColumn<Ch>)> = widths
        .iter()
        .enumerate()
        .map(|(i, w)| Ok(((i + 1) as u16, TextColumn::<Ch>::try_new(batch_rows, *w)
            .map_err(|e| format!("ODBC buffer for column {}: {:?}", cols[i].name, e))?)))
        .collect::<Result<_, String>>()?;
    let buffer = ColumnarBuffer::new(columns);
    let mut block = cursor.bind_buffer(buffer).map_err(|e| explain("ODBC bind", e))?;

    loop {
        let fetched = block.fetch_with_truncation_check(true).map_err(|e| {
            let m = e.to_string();
            if m.to_lowercase().contains("truncat") {
                format!(
                    "ODBC: a value is longer than the read buffer ({} characters for columns \
                     of undeclared size, e.g. CLOB/TEXT): {}",
                    LONG_TEXT_CHARS, m
                )
            } else {
                explain("ODBC fetch", m)
            }
        })?;
        let Some(batch) = fetched else { break };
        let n = batch.num_rows();
        let mut rows: Vec<Row> = (0..n).map(|_| Row::new()).collect();
        for (ci, meta) in cols.iter().enumerate() {
            let col = batch.column(ci);
            let bin = is_binary(&meta.data_type);
            for (r, row) in rows.iter_mut().enumerate() {
                let v = match col.get(r) {
                    None => Value::Null,
                    Some(units) => {
                        let text = decode(units);
                        if bin {
                            match hex_to_bytes(&text) {
                                Some(b) => bytes_value(&b),
                                None => Value::String(text),
                            }
                        } else {
                            cell_value(&meta.data_type, &text)
                        }
                    }
                };
                row.set(meta.name.clone(), v);
            }
        }
        if !on_batch(&cols, rows) {
            break;
        }
    }
    Ok(cols)
}

#[cfg_attr(not(feature = "desktop"), allow(dead_code))] // usata dai comandi dello studio
/// Colonne che `query` restituirebbe, SENZA eseguirla (SQLPrepare + descrizione).
/// Se il driver non sa descrivere prima di eseguire, si esegue leggendo zero righe.
pub fn describe_query(conn: &Connection<'static>, query: &str) -> Result<Vec<ColumnMeta>, String> {
    let mut prepared = conn.prepare(query).map_err(|e| explain("ODBC prepare", e))?;
    let cols = describe(&mut prepared)?;
    if !cols.is_empty() {
        return Ok(cols);
    }
    drop(prepared);
    let mut out = Vec::new();
    read_rows(conn, query, &[], None, |c, _| {
        out = c.to_vec();
        false
    })
    .map(|c| if out.is_empty() { c } else { out })
}

// ─── Comandi dello studio (anteprima, schema, test) ───────────────

#[cfg_attr(not(feature = "desktop"), allow(dead_code))] // usata dai comandi dello studio
/// Esegue una query e restituisce al massimo `max_rows` righe come oggetti JSON,
/// con LO STESSO convertitore del nodo source_db (l'anteprima e' fedele al run).
pub async fn query_json(
    conn_str: String,
    query: String,
    max_rows: Option<usize>,
    timeout: Option<u64>,
) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open(&conn_str, timeout.unwrap_or(30) as u32)?;
        let cap = max_rows.unwrap_or(usize::MAX);
        let mut out: Vec<serde_json::Value> = Vec::new();
        read_rows(&conn, &query, &[], timeout, |cols, rows| {
            for row in rows {
                if out.len() >= cap {
                    return false;
                }
                let mut obj = serde_json::Map::new();
                for c in cols {
                    let v = row.0.get(&c.name).cloned().unwrap_or(Value::Null);
                    obj.insert(c.name.clone(), serde_json::to_value(v).unwrap_or(serde_json::Value::Null));
                }
                out.push(serde_json::Value::Object(obj));
            }
            out.len() < cap
        })?;
        Ok(out)
    })
    .await
    .map_err(|e| format!("ODBC task failed: {e}"))?
}

#[cfg_attr(not(feature = "desktop"), allow(dead_code))] // usata dai comandi dello studio
/// Colonne di una query (per "Rileva schema" nello studio).
pub async fn describe_json(conn_str: String, query: String) -> Result<Vec<(String, String, bool)>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open(&conn_str, 10)?;
        let cols = describe_query(&conn, &query)?;
        Ok(cols.into_iter().map(|c| (c.name, type_name(&c.data_type), c.nullable)).collect())
    })
    .await
    .map_err(|e| format!("ODBC task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(dialect: &str) -> OdbcTarget {
        OdbcTarget { dialect: dialect.into(), user: "scott".into(), password: "ti;ger}".into(), ..Default::default() }
    }

    #[test]
    fn connection_string_per_dialetto() {
        let mut o = t("oracle");
        assert!(connection_string(&o).unwrap_err().contains("driver"));
        o.driver = "Oracle 23 ODBC driver".into();
        o.host = "db1".into();
        o.service_name = "FREEPDB1".into();
        assert_eq!(
            connection_string(&o).unwrap(),
            "Driver={Oracle 23 ODBC driver};DBQ=db1:1521/FREEPDB1;UID=scott;PWD={ti;ger}}};"
        );

        let mut i = t("informix");
        i.host = "ifx".into();
        i.db_server_name = "ol_informix".into();
        i.database = "stores".into();
        i.extra = "CLIENT_LOCALE=en_US.utf8".into();
        assert_eq!(
            connection_string(&i).unwrap(),
            "Driver={IBM INFORMIX ODBC DRIVER};Host=ifx;Service=9088;Server=ol_informix;\
             Database=stores;Protocol=onsoctcp;UID=scott;PWD={ti;ger}}};CLIENT_LOCALE=en_US.utf8;"
        );

        let mut d = t("odbc");
        assert!(connection_string(&d).is_err());
        d.dsn = "MIODSN".into();
        assert_eq!(connection_string(&d).unwrap(), "DSN=MIODSN;UID=scott;PWD={ti;ger}}};");

        // connection string completa: vince, e le credenziali non si duplicano
        d.connection_string = "Driver=/opt/x.so;Server=h;UID=altro".into();
        assert_eq!(connection_string(&d).unwrap(), "Driver=/opt/x.so;Server=h;UID=altro;PWD={ti;ger}}};");
    }

    #[test]
    fn conversione_celle() {
        let dec = |p, s| DataType::Decimal { precision: p, scale: s };
        assert_eq!(cell_value(&dec(10, 0), "42"), Value::Int(42));
        assert_eq!(cell_value(&dec(18, 4), "1234.5600"), Value::Decimal("1234.5600".parse().unwrap()));
        // oltre la portata di Decimal: stringa esatta, mai un numero arrotondato
        assert_eq!(
            cell_value(&dec(38, 10), "12345678901234567890.0123456789"),
            Value::String("12345678901234567890.0123456789".into())
        );
        assert_eq!(cell_value(&DataType::Double, "3.5e300"), Value::Float(3.5e300));
        assert_eq!(cell_value(&DataType::Bit, "1"), Value::Bool(true));
        assert_eq!(cell_value(&DataType::Date, "2000-02-29"), Value::Date("2000-02-29".into()));
        assert_eq!(
            cell_value(&DataType::Timestamp { precision: 6 }, "2026-10-18 09:30:15.250000"),
            Value::DateTime("2026-10-18 09:30:15.250".into())
        );
        assert_eq!(cell_value(&DataType::BigInt, "-9223372036854775808"), Value::Int(i64::MIN));
    }
}
