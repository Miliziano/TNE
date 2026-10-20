// ─── src-tauri/src/odbc.rs ────────────────────────────────────────
//
// ODBC: Oracle, Informix e ODBC generico. P344 = lettura; P345 = scrittura
// (insert/update/delete/upsert/merge, DDL, pre/post SQL, chiave primaria);
// P347 = chiavi generate (master-detail) e gruppi transazionali nativi.
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
use odbc_api::handles::{Statement, StatementImpl};
use odbc_api::parameter::{InputParameter, VarCharArray, VarCharBox, WithDataType};
use odbc_api::{
    Bit, Connection, ConnectionOptions, Cursor, DataType, Environment, IntoParameter,
    Nullability, ParameterCollectionRef, Prepared, ResultSetMetadata,
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

/// Parametri ODBC dalla risorsa di un nodo (source_db, sink_db). Le chiavi sono
/// quelle della risorsa nello studio (P344): `odbcDriver`, non `driver`, che
/// nelle risorse vecchie e' un alias del dialetto.
pub fn target_from_spec(spec: &crate::engine::spec::Spec, dialect: &str, port: u16, user: &str) -> OdbcTarget {
    OdbcTarget {
        dialect:           dialect.to_string(),
        host:              spec.res_str_or("host", ""),
        port:              Some(port),
        database:          spec.res_str_or("database", ""),
        user:              user.to_string(),
        password:          spec.res_str_or("password", ""),
        service_name:      spec.res_str_or("serviceName", ""),
        db_server_name:    spec.res_str_or("dbServerName", ""),
        driver:            spec.res_str_or("odbcDriver", ""),
        dsn:               spec.res_str_or("dsn", ""),
        connection_string: spec.res_str_or("connectionString", ""),
        extra:             spec.res_str_or("odbcParams", ""),
    }
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
    dialect: String,
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
    /// P347: autocommit spento da `tx_begin` e non ancora chiuso da `tx_end`.
    /// Una connessione cosi' non torna MAI nel pool (porterebbe con se' una
    /// transazione aperta): al drop si chiude, e il driver fa rollback.
    in_tx: bool,
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
            if !self.broken && !self.in_tx && !self.inner.closed.load(Ordering::SeqCst) {
                if let Ok(mut idle) = self.inner.idle.lock() {
                    idle.push(c);
                    return;
                }
            }
            drop(c); // SQLDisconnect
        }
    }
}

/// Istruzioni eseguite a ogni nuova connessione, per dialetto (P345).
/// Oracle: separatore decimale e formati data FISSI, indipendenti dalla lingua
/// del client (NLS_LANG=ITALIAN_ITALY darebbe "1234,56" e date "18-OTT-26": i
/// numeri letti come testo non si convertirebbero piu').
fn session_init(dialect: &str) -> &'static [&'static str] {
    match dialect {
        "oracle" => &[
            "ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'",
            "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'",
            "ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF'",
        ],
        _ => &[],
    }
}

fn open(conn_str: &str, login_timeout: u32, dialect: &str) -> Result<Connection<'static>, String> {
    let env = env()?;
    let conn = env
        .connect_with_connection_string(
            conn_str,
            ConnectionOptions { login_timeout_sec: Some(login_timeout.max(1)), ..Default::default() },
        )
        .map_err(|e| explain("ODBC connection failed", e))?;
    for stmt in session_init(dialect) {
        // Non fatale: la connessione resta usabile; il motivo finisce nel log.
        if let Err(e) = conn.execute(stmt, (), None) {
            eprintln!("[odbc] session setup ignored ({stmt}): {e}");
        }
    }
    Ok(conn)
}

impl OdbcPool {
    /// Crea il pool aprendo SUBITO una connessione: un errore di connessione
    /// emerge qui (come per i pool sqlx), dove il retry "prima operazione" lo
    /// puo' ritentare.
    pub async fn connect(conn_str: String, max: u32, login_timeout: u64, dialect: &str) -> Result<OdbcPool, String> {
        let lt = login_timeout.min(u32::MAX as u64) as u32;
        let (cs, d) = (conn_str.clone(), dialect.to_string());
        let first = tokio::task::spawn_blocking(move || open(&cs, lt, &d))
            .await
            .map_err(|e| format!("ODBC connection task failed: {e}"))??;
        Ok(OdbcPool {
            inner: Arc::new(Inner {
                conn_str,
                dialect: dialect.to_string(),
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
                    None => return open(&inner.conn_str, inner.login_timeout, &inner.dialect),
                }
            }
        })
        .await
        .map_err(|e| format!("ODBC connection task failed: {e}"))??;
        Ok(PooledConn { conn: Some(conn), inner: self.inner.clone(), _permit: permit, broken: false, in_tx: false })
    }

    /// P347: un pool separato di UNA connessione verso lo stesso database, fuori
    /// dal semaforo di questo. Serve alla DDL di un membro transazionale: va
    /// eseguita fuori dalla transazione (Oracle fa COMMIT implicito sulla DDL) e
    /// non deve attendere una connessione libera che il gruppo potrebbe tenere.
    pub async fn sibling(&self) -> Result<OdbcPool, String> {
        OdbcPool::connect(self.inner.conn_str.clone(), 1, self.inner.login_timeout as u64, &self.inner.dialect).await
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
            let comma = decimal_comma(t);
            let t = comma.as_deref().unwrap_or(t);
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
            let comma = decimal_comma(t);
            comma.as_deref().unwrap_or(t).parse::<f64>().map(Value::Float).unwrap_or_else(|_| Value::String(text.to_string()))
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

/// Numero scritto con la VIRGOLA decimale ("1234,56", sessione in lingua
/// italiana): → "1234.56". Solo se c'e' esattamente una virgola e nessun punto,
/// cosi' non si confonde mai con un separatore delle migliaia.
fn decimal_comma(t: &str) -> Option<String> {
    let ok = t.matches(',').count() == 1
        && !t.contains('.')
        && t.chars().all(|c| c.is_ascii_digit() || c == ',' || c == '-' || c == '+' || c == 'e' || c == 'E');
    ok.then(|| t.replace(',', "."))
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
    on_batch: impl FnMut(&[ColumnMeta], Vec<Row>) -> bool,
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
    let Some(cursor) = cursor else {
        return Ok(Vec::new()); // istruzione senza risultato
    };
    read_cursor(cursor, on_batch)
}

/// Legge un cursore qualunque (query o catalogo ODBC) a lotti, convertendo le
/// celle come `read_rows`.
fn read_cursor<C: Cursor>(
    mut cursor: C,
    mut on_batch: impl FnMut(&[ColumnMeta], Vec<Row>) -> bool,
) -> Result<Vec<ColumnMeta>, String> {
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
    dialect: String,
    query: String,
    max_rows: Option<usize>,
    timeout: Option<u64>,
) -> Result<Vec<serde_json::Value>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open(&conn_str, timeout.unwrap_or(30) as u32, &dialect)?;
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
pub async fn describe_json(conn_str: String, dialect: String, query: String) -> Result<Vec<(String, String, bool)>, String> {
    tokio::task::spawn_blocking(move || {
        let conn = open(&conn_str, 10, &dialect)?;
        let cols = describe_query(&conn, &query)?;
        Ok(cols.into_iter().map(|c| (c.name, type_name(&c.data_type), c.nullable)).collect())
    })
    .await
    .map_err(|e| format!("ODBC task failed: {e}"))?
}


// ─── Scrittura (P345) ─────────────────────────────────────────────
//
// Stessa semantica degli altri database (lib.rs, pg/mysql/sqlite_write_pool):
// una istruzione per riga, `onConstraintError` = stop | skip | (altro: conta
// l'errore e prosegue), nomi validati da `sqlsafe`, valori sempre legati.
// Differenze dovute ai dialetti, dichiarate:
//   - UPSERT: niente "ON CONFLICT" portabile → UPDATE sulle chiavi e, se non
//     ha toccato righe, INSERT. Funziona con qualunque driver ODBC.
//   - MERGE: su Oracle e' un MERGE vero (condizione personalizzata ammessa);
//     su Informix e ODBC generico vale come UPSERT sulle chiavi (una condizione
//     personalizzata e' rifiutata con un errore esplicito).
//   - chiavi generate (master-detail) e transazioni di gruppo: non ancora.
// Le istruzioni preparate si riusano per tutta la scrittura (una per forma SQL).

/// Valore JSON (riga da scrivere) → parametro ODBC tipizzato. Date e timestamp
/// in forma ISO si legano come DATE/TIMESTAMP veri: niente conversione
/// testo→data affidata al formato di sessione del server.
/// Precisione e scala di un decimale scritto in testo ("-0012.340" → 5, 3).
fn decimal_precision_scale(d: &str) -> (usize, i16) {
    let t = d.trim().trim_start_matches(['-', '+']);
    let (int, frac) = t.split_once('.').unwrap_or((t, ""));
    let int = int.trim_start_matches('0');
    let scale = frac.len();
    ((int.len() + scale).max(1), scale as i16)
}

fn json_param(v: &serde_json::Value) -> Box<dyn InputParameter> {
    use chrono::{Datelike, Timelike};
    use serde_json::Value as J;
    // P346: Decimal esatto come testo con tipo SQL DECIMAL(p,s): il driver
    // lo converte senza passare da f64 (Oracle: NLS_NUMERIC_CHARACTERS='.,'
    // impostato in session_init).
    if let Some(d) = crate::json_decimal(v) {
        let (p, s) = decimal_precision_scale(d);
        return Box::new(WithDataType {
            value: d.to_string().into_parameter(),
            data_type: DataType::Decimal { precision: p, scale: s },
        });
    }
    // P350: lotto JSON della stored procedure → testo
    if let Some(t) = crate::json_raw(v) {
        return Box::new(t.to_string().into_parameter());
    }
    match v {
        J::Null => Box::new(VarCharBox::null()),
        J::Bool(b) => Box::new(Bit::from_bool(*b)),
        J::Number(n) => {
            if let Some(i) = n.as_i64() {
                Box::new(i)
            } else if let Some(f) = n.as_f64() {
                Box::new(f)
            } else {
                Box::new(n.to_string().into_parameter())
            }
        }
        J::String(s) => {
            let t = s.trim();
            if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%d %H:%M:%S%.f")
                .or_else(|_| chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S%.f"))
            {
                return Box::new(WithDataType {
                    value: odbc_api::sys::Timestamp {
                        year: dt.year() as i16,
                        month: dt.month() as u16,
                        day: dt.day() as u16,
                        hour: dt.hour() as u16,
                        minute: dt.minute() as u16,
                        second: dt.second() as u16,
                        fraction: dt.nanosecond() % 1_000_000_000,
                    },
                    data_type: DataType::Timestamp { precision: 6 },
                });
            }
            if t.len() == 10 {
                if let Ok(d) = chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d") {
                    return Box::new(WithDataType {
                        value: odbc_api::sys::Date { year: d.year() as i16, month: d.month() as u16, day: d.day() as u16 },
                        data_type: DataType::Date,
                    });
                }
            }
            Box::new(s.clone().into_parameter())
        }
        other => Box::new(other.to_string().into_parameter()),
    }
}

/// Lunghezza massima del testo di una chiave generata letta da un parametro di uscita.
const OUT_KEY_LEN: usize = 128;

/// Parametri d'ingresso in numero variabile + UN parametro di uscita in coda.
/// Le tuple di odbc-api (che reggono `Out`) hanno arita' fissa: qui servono N
/// ingressi, quanti sono le colonne della riga.
struct InputsAndOut<'a> {
    inputs: &'a [Box<dyn InputParameter>],
    out: &'a mut VarCharArray<OUT_KEY_LEN>,
}

unsafe impl ParameterCollectionRef for InputsAndOut<'_> {
    fn parameter_set_size(&self) -> usize {
        1
    }

    unsafe fn bind_parameters_to(&mut self, stmt: &mut impl Statement) -> Result<(), odbc_api::Error> {
        for (i, p) in self.inputs.iter().enumerate() {
            p.assert_completness();
            unsafe { stmt.bind_input_parameter(i as u16 + 1, p) }.into_result(stmt)?;
        }
        let n = self.inputs.len() as u16 + 1;
        unsafe { stmt.bind_parameter(n, odbc_api::sys::ParamType::Output, self.out) }.into_result(stmt)
    }
}

/// Valore di chiave come JSON: intero se lo e', altrimenti testo.
fn key_json(t: &str) -> serde_json::Value {
    match t.parse::<i64>() {
        Ok(i) => serde_json::json!(i),
        Err(_) => serde_json::json!(t),
    }
}

/// Istruzioni preparate riusate per tutta la scrittura (una per forma SQL).
struct Exec<'c> {
    conn: &'c Connection<'static>,
    cache: std::collections::HashMap<String, Prepared<StatementImpl<'c>>>,
}

impl<'c> Exec<'c> {
    fn new(conn: &'c Connection<'static>) -> Self {
        Exec { conn, cache: std::collections::HashMap::new() }
    }

    fn prepared(&mut self, sql: &str) -> Result<&mut Prepared<StatementImpl<'c>>, String> {
        if !self.cache.contains_key(sql) {
            let p = self.conn.prepare(sql).map_err(|e| e.to_string())?;
            self.cache.insert(sql.to_string(), p);
        }
        Ok(self.cache.get_mut(sql).expect("appena inserita"))
    }

    /// Esegue e restituisce le righe toccate (None se il driver non lo dice).
    fn run(&mut self, sql: &str, binds: &[&serde_json::Value]) -> Result<Option<usize>, String> {
        let params: Vec<Box<dyn InputParameter>> = binds.iter().map(|v| json_param(v)).collect();
        let st = self.prepared(sql)?;
        {
            let _cursor = st.execute(params.as_slice()).map_err(|e| e.to_string())?;
        }
        st.row_count().map_err(|e| e.to_string())
    }

    /// Esegue con un parametro di USCITA in coda (testo): Oracle
    /// `BEGIN INSERT … RETURNING col INTO ?; END;`.
    fn run_with_out(&mut self, sql: &str, binds: &[&serde_json::Value]) -> Result<Option<String>, String> {
        let params: Vec<Box<dyn InputParameter>> = binds.iter().map(|v| json_param(v)).collect();
        let mut out = VarCharArray::<OUT_KEY_LEN>::NULL;
        let st = self.prepared(sql)?;
        {
            let _cursor = st
                .execute(InputsAndOut { inputs: params.as_slice(), out: &mut out })
                .map_err(|e| e.to_string())?;
        }
        Ok(out.as_bytes().map(|b| String::from_utf8_lossy(b).trim().to_string()))
    }

    /// Prima colonna della prima riga, come testo (None se nessuna riga o NULL).
    fn scalar_text(&mut self, sql: &str, binds: &[&serde_json::Value]) -> Result<Option<String>, String> {
        let params: Vec<Box<dyn InputParameter>> = binds.iter().map(|v| json_param(v)).collect();
        let st = self.prepared(sql)?;
        match st.execute(params.as_slice()).map_err(|e| e.to_string())? {
            Some(mut cur) => match cur.next_row().map_err(|e| e.to_string())? {
                Some(mut row) => {
                    let mut buf = Vec::new();
                    let present = row.get_text(1, &mut buf).map_err(|e| e.to_string())?;
                    Ok(if present { Some(String::from_utf8_lossy(&buf).trim().to_string()) } else { None })
                }
                None => Ok(None),
            },
            None => Ok(None),
        }
    }

    /// Vero se la SELECT restituisce almeno una riga.
    fn exists(&mut self, sql: &str, binds: &[&serde_json::Value]) -> Result<bool, String> {
        let params: Vec<Box<dyn InputParameter>> = binds.iter().map(|v| json_param(v)).collect();
        let st = self.prepared(sql)?;
        match st.execute(params.as_slice()).map_err(|e| e.to_string())? {
            Some(mut cur) => Ok(cur.next_row().map_err(|e| e.to_string())?.is_some()),
            None => Ok(false),
        }
    }
}

/// Dati di una scrittura, posseduti (passano nel thread bloccante).
struct WriteJob {
    tbl: String,
    dialect: String,
    mode: String,
    keys: Vec<String>,
    rows: Vec<serde_json::Value>,
    columns: Option<Vec<String>>,
    exclude: Option<Vec<String>>,
    column_functions: Option<Vec<crate::DbColumnFunction>>,
    merge_condition: Option<String>,
    pre_sql: Option<String>,
    post_sql: Option<String>,
    batch_size: usize,
    on_error: String,
    /// P347: colonna della chiave da restituire per ogni riga scritta (master-detail).
    returning: Option<String>,
    /// P349: operatori e AND/OR delle chiavi (solo UPDATE e DELETE).
    key_conditions: Option<Vec<crate::DbKeyCondition>>,
    /// P350: SQL personalizzato / stored procedure (un'istruzione per riga).
    custom: Option<crate::CustomSql>,
}

/// Esito di un `WriteJob::run`.
struct WriteOutcome {
    written: usize,
    skipped: usize,
    errors: usize,
    batches: usize,
    keys: Vec<serde_json::Value>,
}

fn dialect_label(d: &str) -> &'static str {
    match d { "oracle" => "Oracle", "informix" => "Informix", _ => "generic ODBC" }
}

/// Esegue un blocco di istruzioni separate da `;` (pre/post SQL, DDL).
fn exec_block(conn: &Connection<'static>, sql: &str, label: &str) -> Result<(), String> {
    for stmt in sql.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
        conn.execute(stmt, (), None).map_err(|e| {
            if label.is_empty() { e.to_string() } else { format!("{} failed: {}", label, e) }
        })?;
    }
    Ok(())
}

impl WriteJob {
    fn values_of<'a>(&self, fields: &'a [(String, serde_json::Value)], names: &[String]) -> Result<Vec<&'a serde_json::Value>, String> {
        names.iter()
            .map(|k| fields.iter().find(|(f, _)| f == k).map(|(_, v)| v)
                .ok_or_else(|| format!("key field '{}' is missing in the row", k)))
            .collect()
    }

    fn where_keys(&self) -> String {
        self.keys.iter().map(|k| format!("{} = ?", k)).collect::<Vec<_>>().join(" AND ")
    }

    fn insert(&self, ex: &mut Exec, fields: &[(String, serde_json::Value)]) -> Result<(), String> {
        let plan = crate::build_column_plan(fields, &self.column_functions, crate::PlaceholderStyle::Question, 1);
        let cols = plan.iter().map(|p| p.column_sql.as_str()).collect::<Vec<_>>().join(", ");
        let vals = plan.iter().map(|p| p.value_sql.as_str()).collect::<Vec<_>>().join(", ");
        let binds: Vec<&serde_json::Value> = plan.iter().filter_map(|p| p.bind_value).collect();
        ex.run(&format!("INSERT INTO {} ({}) VALUES ({})", self.tbl, cols, vals), &binds).map(|_| ())
    }

    /// UPDATE sulle chiavi; restituisce le righe toccate (None = il driver non lo dice).
    /// `with_conditions`: operatori e AND/OR del mapping (modalita' UPDATE, P349);
    /// l'upsert identifica la riga sempre con `=` sulle chiavi.
    fn update(&self, ex: &mut Exec, fields: &[(String, serde_json::Value)], set: &[(String, serde_json::Value)], with_conditions: bool) -> Result<Option<usize>, String> {
        let plan = crate::build_column_plan(set, &self.column_functions, crate::PlaceholderStyle::Question, 1);
        let sets = plan.iter().map(|p| format!("{} = {}", p.column_sql, p.value_sql)).collect::<Vec<_>>().join(", ");
        let mut binds: Vec<&serde_json::Value> = plan.iter().filter_map(|p| p.bind_value).collect();
        let where_c = if with_conditions {
            let (w, b) = self.where_conditions(fields)?;
            binds.extend(b);
            w
        } else {
            binds.extend(self.values_of(fields, &self.keys)?);
            self.where_keys()
        };
        ex.run(&format!("UPDATE {} SET {} WHERE {}", self.tbl, sets, where_c), &binds)
    }

    /// WHERE con operatori, AND/OR e funzioni di colonna (P349).
    fn where_conditions<'f>(&self, fields: &'f [(String, serde_json::Value)]) -> Result<(String, Vec<&'f serde_json::Value>), String> {
        crate::where_plan(&self.keys, &self.key_conditions, fields, &self.column_functions,
            crate::PlaceholderStyle::Question, 1, &|k: &str| k.to_string())
    }

    /// Valore della colonna chiave gia' presente (non NULL) nella riga.
    fn key_in_row(&self, fields: &[(String, serde_json::Value)]) -> Option<serde_json::Value> {
        let ret = self.returning.as_deref()?;
        // P349: se la chiave la calcola una funzione (sequenza) il valore della
        // riga non e' quello scritto: va letto dal database.
        if self.column_functions.iter().flatten().any(|f| f.column == ret) {
            return None;
        }
        let v = fields.iter().find(|(k, _)| k == ret).map(|(_, v)| v)?;
        if v.is_null() {
            return None;
        }
        Some(match crate::json_decimal(v) {
            Some(d) => key_json(d),
            None => v.clone(),
        })
    }

    /// INSERT che restituisce la chiave (P347). Se la riga porta gia' il valore
    /// della colonna chiave lo si usa; altrimenti lo genera il DB e lo si legge
    /// nel modo del dialetto: Oracle `RETURNING … INTO` in un blocco PL/SQL con
    /// parametro di uscita; Informix `DBINFO('sqlca.sqlerrd1')` (SERIAL) o
    /// `DBINFO('bigserial')`; ODBC generico: non esiste un modo portabile.
    fn insert_returning(&self, ex: &mut Exec, fields: &[(String, serde_json::Value)]) -> Result<serde_json::Value, String> {
        let ret = self.returning.as_deref().unwrap_or_default();
        if let Some(k) = self.key_in_row(fields) {
            self.insert(ex, fields)?;
            return Ok(k);
        }
        match self.dialect.as_str() {
            "oracle" => {
                let plan = crate::build_column_plan(fields, &self.column_functions, crate::PlaceholderStyle::Question, 1);
                let cols = plan.iter().map(|p| p.column_sql.as_str()).collect::<Vec<_>>().join(", ");
                let vals = plan.iter().map(|p| p.value_sql.as_str()).collect::<Vec<_>>().join(", ");
                let binds: Vec<&serde_json::Value> = plan.iter().filter_map(|p| p.bind_value).collect();
                let sql = format!("BEGIN INSERT INTO {} ({}) VALUES ({}) RETURNING {} INTO ?; END;", self.tbl, cols, vals, ret);
                Ok(ex.run_with_out(&sql, &binds)?.map(|t| key_json(&t)).unwrap_or(serde_json::Value::Null))
            }
            "informix" => {
                self.insert(ex, fields)?;
                let serial = ex.scalar_text("SELECT DBINFO('sqlca.sqlerrd1') FROM systables WHERE tabid = 1", &[])?;
                let key = match serial.as_deref() {
                    Some(s) if s != "0" => Some(s.to_string()),
                    _ => ex.scalar_text("SELECT DBINFO('bigserial') FROM systables WHERE tabid = 1", &[])?,
                };
                Ok(key.filter(|s| s != "0").map(|t| key_json(&t)).unwrap_or(serde_json::Value::Null))
            }
            _ => Err(format!(
                "generated keys: generic ODBC has no portable way to read a key generated by the database{}. \
                 Put the value of '{}' in the row, or use the Oracle or Informix dialect",
                self.column_functions.iter().flatten().find(|f| f.column == ret)
                    .map(|f| format!(" (here by {})", f.expr)).unwrap_or_default(),
                ret
            )),
        }
    }

    /// Chiave di una riga esistente, letta sulle colonne chiave (upsert che ha aggiornato).
    fn key_by_keys(&self, ex: &mut Exec, fields: &[(String, serde_json::Value)]) -> Result<serde_json::Value, String> {
        if let Some(k) = self.key_in_row(fields) {
            return Ok(k);
        }
        let ret = self.returning.as_deref().unwrap_or_default();
        let kv = self.values_of(fields, &self.keys)?;
        Ok(ex
            .scalar_text(&format!("SELECT {} FROM {} WHERE {}", ret, self.tbl, self.where_keys()), &kv)?
            .map(|t| key_json(&t))
            .unwrap_or(serde_json::Value::Null))
    }

    /// UPSERT portabile: UPDATE sulle chiavi, INSERT se non ha toccato righe.
    /// Con `returning` restituisce la chiave della riga (aggiornata o inserita).
    fn upsert(&self, ex: &mut Exec, fields: &[(String, serde_json::Value)]) -> Result<Option<serde_json::Value>, String> {
        if self.keys.is_empty() {
            return Err("UPSERT needs at least one key column".to_string());
        }
        // P349: la chiave restituita (master-detail) non si riscrive sull'upsert
        let set: Vec<(String, serde_json::Value)> = fields.iter()
            .filter(|(k, _)| !self.keys.contains(k) && Some(k.as_str()) != self.returning.as_deref())
            .cloned().collect();
        let found = if set.is_empty() {
            let kv = self.values_of(fields, &self.keys)?;
            ex.exists(&format!("SELECT 1 FROM {} WHERE {}", self.tbl, self.where_keys()), &kv)?
        } else {
            match self.update(ex, fields, &set, false)? {
                Some(n) => n > 0,
                None => {
                    let kv = self.values_of(fields, &self.keys)?;
                    ex.exists(&format!("SELECT 1 FROM {} WHERE {}", self.tbl, self.where_keys()), &kv)?
                }
            }
        };
        match (found, self.returning.is_some()) {
            (true, false) => Ok(None),
            (true, true) => self.key_by_keys(ex, fields).map(Some),
            (false, false) => self.insert(ex, fields).map(|_| None),
            (false, true) => self.insert_returning(ex, fields).map(Some),
        }
    }

    fn oracle_merge(&self, ex: &mut Exec, fields: &[(String, serde_json::Value)]) -> Result<(), String> {
        let m = crate::merge_parts(fields, &self.keys, &self.column_functions, &self.merge_condition, crate::PlaceholderStyle::Question)?;
        let matched = if m.update_set.is_empty() { String::new() } else { format!(" WHEN MATCHED THEN UPDATE SET {}", m.update_set) };
        let sql = format!(
            "MERGE INTO {} target USING (SELECT {} FROM DUAL) source ON ({}){} WHEN NOT MATCHED THEN INSERT ({}) VALUES ({})",
            self.tbl, m.source_select, m.on, matched, m.insert_cols, m.insert_vals
        );
        ex.run(&sql, &m.binds).map(|_| ())
    }

    /// Scrive una riga; con `returning` (insert/upsert) restituisce la sua chiave.
    fn write_row(&self, ex: &mut Exec, fields: &[(String, serde_json::Value)]) -> Result<Option<serde_json::Value>, String> {
        match self.mode.as_str() {
            "insert" | "truncate_insert" if self.returning.is_some() => self.insert_returning(ex, fields).map(Some),
            "insert" | "truncate_insert" => self.insert(ex, fields).map(|_| None),
            "update" => {
                let set: Vec<(String, serde_json::Value)> = fields.iter().filter(|(k, _)| !self.keys.contains(k)).cloned().collect();
                self.update(ex, fields, &set, true).map(|_| None)
            }
            "delete" => {
                let (where_c, binds) = self.where_conditions(fields)?;
                ex.run(&format!("DELETE FROM {} WHERE {}", self.tbl, where_c), &binds).map(|_| None)
            }
            "upsert" => self.upsert(ex, fields),
            "merge" if self.dialect == "oracle" => self.oracle_merge(ex, fields).map(|_| None),
            "merge" => self.upsert(ex, fields).map(|_| None),
            m => Err(format!("unknown write mode '{}'", m)),
        }
    }

    fn run(&self, conn: &Connection<'static>) -> Result<WriteOutcome, String> {
        if let Some(pre) = self.pre_sql.as_deref().filter(|s| !s.trim().is_empty()) {
            exec_block(conn, pre, "Pre-SQL")?;
        }
        if self.mode == "truncate_insert" {
            exec_block(conn, &format!("TRUNCATE TABLE {}", self.tbl), "TRUNCATE")?;
        }
        let mut ex = Exec::new(conn);
        let (mut written, mut skipped, mut errors, mut batches) = (0usize, 0usize, 0usize, 0usize);
        let mut keys: Vec<serde_json::Value> = Vec::new();
        for chunk in self.rows.chunks(self.batch_size.max(1)) {
            batches += 1;
            for row in chunk {
                // P350: SQL personalizzato: `{campo}` legati dai campi della riga
                if let Some(cs) = &self.custom {
                    let binds = cs.binds(row, crate::PlaceholderStyle::Question)?;
                    match ex.run(cs.text(crate::PlaceholderStyle::Question), &binds) {
                        Ok(_) => written += 1,
                        Err(e) => match self.on_error.as_str() {
                            "skip" => skipped += 1,
                            "stop" => return Err(format!("SinkDB row error: {}", e)),
                            _ => errors += 1,
                        },
                    }
                    continue;
                }
                let fields = crate::extract_row_data(row, &self.columns, &self.exclude);
                crate::sqlsafe::check_fields(&fields, &self.dialect)?;
                if fields.is_empty() {
                    skipped += 1;
                    continue;
                }
                match self.write_row(&mut ex, &fields) {
                    Ok(key) => {
                        written += 1;
                        if let Some(k) = key { keys.push(k); }
                    }
                    Err(e) => match self.on_error.as_str() {
                        "skip" => skipped += 1,
                        "stop" => return Err(format!("SinkDB row error: {}", e)),
                        _ => errors += 1,
                    },
                }
            }
        }
        drop(ex);
        if let Some(post) = self.post_sql.as_deref().filter(|s| !s.trim().is_empty()) {
            exec_block(conn, post, "Post-SQL")?;
        }
        Ok(WriteOutcome { written, skipped, errors, batches, keys })
    }
}

/// Controlla la richiesta e la trasforma nel lavoro da eseguire sul thread bloccante.
fn job_from_req(req: &crate::DbWriteRequest) -> Result<WriteJob, String> {
    let dialect = req.connection.dialect.clone();
    let tbl = crate::qualified_table(req);
    let keys = req.key_fields.clone().unwrap_or_default();
    if req.custom_sql.is_none() {
        crate::sqlsafe::check_names(&tbl, &keys, req.columns.as_deref(), req.returning_column.as_deref(), &dialect)?;
    }
    crate::check_write_mode(&req.mode, &dialect)?;
    crate::check_key_conditions(&req.mode, &req.key_conditions)?;
    // come Postgres (use_returning): la chiave si restituisce solo per insert/upsert
    let returning = req.returning_column.clone()
        .filter(|_| matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert"));
    let custom_merge = req.mode == "merge"
        && req.merge_condition.as_deref().map(|c| !c.trim().is_empty()).unwrap_or(false);
    if custom_merge && dialect != "oracle" {
        return Err(format!(
            "a custom MERGE ON condition is supported on Oracle and PostgreSQL; on {} MERGE works on the key columns (leave the condition empty)",
            dialect_label(&dialect)));
    }
    Ok(WriteJob {
        tbl, dialect, mode: req.mode.clone(), keys,
        rows: req.rows.clone(),
        columns: req.columns.clone(),
        exclude: req.exclude_columns.clone(),
        column_functions: req.column_functions.clone(),
        merge_condition: req.merge_condition.clone(),
        pre_sql: req.pre_sql.clone(),
        post_sql: req.post_sql.clone(),
        batch_size: req.batch_size,
        on_error: req.on_constraint_error.clone(),
        returning,
        key_conditions: req.key_conditions.clone(),
        custom: req.custom_sql.clone(),
    })
}

fn write_result(o: WriteOutcome, start: std::time::Instant) -> crate::DbWriteResult {
    crate::DbWriteResult {
        rows_written: o.written,
        rows_skipped: o.skipped,
        rows_errors: o.errors,
        batches: o.batches,
        elapsed_ms: start.elapsed().as_millis(),
        generated_keys: o.keys,
    }
}

/// Scrittura di un lotto di righe via ODBC (sink_db e comando db_write).
pub async fn write(pool: &OdbcPool, req: &crate::DbWriteRequest, start: std::time::Instant) -> Result<crate::DbWriteResult, String> {
    let job = job_from_req(req)?;
    let conn = pool.acquire().await?;
    let res = tokio::task::spawn_blocking(move || job.run(conn.conn()))
        .await
        .map_err(|e| format!("ODBC write task failed: {e}"))?;
    Ok(write_result(res?, start))
}

// ─── Transazioni (P347) ───────────────────────────────────────────
//
// Gruppo transazionale NATIVO su una risorsa ODBC: una connessione presa dal
// pool con autocommit spento, condivisa dai membri (lock), chiusa a fine lane
// da engine/txregistry.rs con COMMIT o ROLLBACK (regola tutto-o-niente). XA
// (two-phase commit) su ODBC non c'e': lo rifiuta il registro.
// Niente savepoint per lotto (Postgres li usa perche' un errore avvelena la
// transazione): Oracle e Informix annullano la sola istruzione fallita, e un
// membro fallito fa comunque annullare tutto il gruppo.

/// Connessione transazionale condivisa dai membri di un gruppo.
pub type TxConn = Arc<tokio::sync::Mutex<PooledConn>>;

/// Prende una connessione e spegne l'autocommit: da qui si e' in transazione.
pub async fn tx_begin(pool: &OdbcPool) -> Result<TxConn, String> {
    let conn = pool.acquire().await?;
    let conn = tokio::task::spawn_blocking(move || -> Result<PooledConn, String> {
        let mut conn = conn;
        if let Err(e) = conn.conn().set_autocommit(false) {
            conn.mark_broken();
            return Err(format!("BEGIN (autocommit off) failed: {e}"));
        }
        conn.in_tx = true;
        Ok(conn)
    })
    .await
    .map_err(|e| format!("ODBC task failed: {e}"))??;
    Ok(Arc::new(tokio::sync::Mutex::new(conn)))
}

/// COMMIT o ROLLBACK, poi autocommit di nuovo acceso: solo cosi' la
/// connessione torna nel pool (altrimenti si chiude).
pub async fn tx_end(conn: TxConn, commit: bool) -> Result<(), String> {
    let mut guard = conn.lock_owned().await;
    tokio::task::spawn_blocking(move || {
        let r = {
            let c = guard.conn();
            if commit { c.commit() } else { c.rollback() }
        };
        match r {
            Ok(()) => {
                if guard.conn().set_autocommit(true).is_ok() {
                    guard.in_tx = false;
                }
                Ok(())
            }
            Err(e) => Err(format!("{} failed: {}", if commit { "COMMIT" } else { "ROLLBACK" }, e)),
        }
    })
    .await
    .map_err(|e| format!("ODBC task failed: {e}"))?
}

/// SQL dell'autore (pre/post SQL) dentro la transazione.
pub async fn tx_exec(conn: &TxConn, sql: String, label: String) -> Result<(), String> {
    let guard = conn.clone().lock_owned().await;
    tokio::task::spawn_blocking(move || exec_block(guard.conn(), &sql, &label))
        .await
        .map_err(|e| format!("ODBC task failed: {e}"))?
}

/// Scrittura dentro la transazione (la richiesta non porta pre/post SQL: li
/// esegue il chiamante una volta sola).
pub async fn tx_write(conn: &TxConn, req: &crate::DbWriteRequest, start: std::time::Instant) -> Result<crate::DbWriteResult, String> {
    let job = job_from_req(req)?;
    let guard = conn.clone().lock_owned().await;
    let res = tokio::task::spawn_blocking(move || job.run(guard.conn()))
        .await
        .map_err(|e| format!("ODBC write task failed: {e}"))?;
    Ok(write_result(res?, start))
}

/// Esegue SQL scritto dall'autore (pre/post SQL, DDL) su una connessione del pool.
pub async fn exec_sql(pool: &OdbcPool, sql: String, label: String) -> Result<(), String> {
    let conn = pool.acquire().await?;
    tokio::task::spawn_blocking(move || exec_block(conn.conn(), &sql, &label))
        .await
        .map_err(|e| format!("ODBC task failed: {e}"))?
}

/// Vero se la tabella esiste: una SELECT che non legge righe va a buon fine
/// (portabile su qualunque DB, a differenza di IF [NOT] EXISTS).
pub async fn table_exists(pool: &OdbcPool, tbl: String) -> Result<bool, String> {
    let conn = pool.acquire().await?;
    tokio::task::spawn_blocking(move || Ok(conn.conn().execute(&format!("SELECT 1 FROM {} WHERE 1 = 0", tbl), (), None).is_ok()))
        .await
        .map_err(|e| format!("ODBC task failed: {e}"))?
}

#[cfg_attr(not(feature = "desktop"), allow(dead_code))] // usata dai comandi dello studio
/// Chiave primaria della tabella dal catalogo ODBC (SQLPrimaryKeys): (nome del
/// vincolo, colonne nell'ordine della chiave). I DB salvano i nomi in maiuscolo
/// (Oracle) o minuscolo (Informix, PostgreSQL): si prova il nome com'e', poi
/// nelle due forme.
pub async fn primary_key(conn_str: String, dialect: String, schema: Option<String>, table: String)
    -> Result<Option<(String, Vec<String>)>, String>
{
    tokio::task::spawn_blocking(move || {
        let conn = open(&conn_str, 10, &dialect)?;
        let schema = schema.filter(|s| !s.is_empty() && s != "public");
        let variants = [table.clone(), table.to_uppercase(), table.to_lowercase()];
        for t in variants.iter() {
            let sch = schema.as_ref().map(|s| if t == &table { s.clone() } else if t.chars().any(|c| c.is_uppercase()) { s.to_uppercase() } else { s.to_lowercase() });
            let mut stmt = conn.preallocate().map_err(|e| explain("ODBC statement", e))?;
            let cur = stmt.primary_keys_cursor(None, sch.as_deref(), t).map_err(|e| explain("ODBC primary keys", e))?;
            let mut found: Vec<(i64, String, String)> = Vec::new();
            read_cursor(cur, |cols, rows| {
                let idx = |n: &str| cols.iter().find(|c| c.name.eq_ignore_ascii_case(n)).map(|c| c.name.clone());
                let (col, seq, pk) = (idx("COLUMN_NAME"), idx("KEY_SEQ"), idx("PK_NAME"));
                for r in rows {
                    let get = |k: &Option<String>| k.as_ref().and_then(|k| r.0.get(k)).map(|v| v.as_str_repr()).unwrap_or_default();
                    found.push((get(&seq).parse().unwrap_or(0), get(&col), get(&pk)));
                }
                true
            })?;
            if !found.is_empty() {
                found.sort_by_key(|f| f.0);
                let name = found.iter().map(|f| f.2.clone()).find(|n| !n.is_empty()).unwrap_or_else(|| format!("{}_pkey", table));
                return Ok(Some((name, found.into_iter().map(|f| f.1).collect())));
            }
        }
        Ok(None)
    })
    .await
    .map_err(|e| format!("ODBC task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimale_marcato_esatto() {
        use crate::engine::types::Value;
        let d: rust_decimal::Decimal = "123456789012345678.1234567891".parse().unwrap();
        let j = Value::Decimal(d).to_write_json();
        assert_eq!(crate::json_decimal(&j), Some("123456789012345678.1234567891"));
        let s: rust_decimal::Decimal = "12.50".parse().unwrap();
        assert_eq!(crate::json_decimal(&Value::Decimal(s).to_write_json()), Some("12.50"));
        // per il frontend resta un numero JSON
        assert!(Value::Decimal(s).to_json().is_number());
        // un oggetto qualunque non è un decimale
        assert_eq!(crate::json_decimal(&serde_json::json!({"$fp_decimal": "1", "x": 2})), None);
        assert_eq!(crate::json_decimal(&serde_json::json!("12.50")), None);
        assert_eq!(decimal_precision_scale("-0012.340"), (5, 3));
        assert_eq!(decimal_precision_scale("0.00000001"), (8, 8));
        assert_eq!(decimal_precision_scale("0"), (1, 0));
        assert_eq!(decimal_precision_scale("123456789012345678.1234567891"), (28, 10));
    }

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
        // sessione in lingua italiana: virgola decimale
        assert_eq!(cell_value(&dec(10, 2), "1234,56"), Value::Decimal("1234.56".parse().unwrap()));
        assert_eq!(cell_value(&DataType::Double, "0,5"), Value::Float(0.5));
        // ma mai interpretare i separatori delle migliaia
        assert_eq!(cell_value(&DataType::Double, "1,234.5"), Value::String("1,234.5".into()));
    }
}

#[cfg(test)]
mod tests_live {
    // Collaudi su database VERI, saltati di default (P347). Si lanciano con la
    // connection string nell'ambiente:
    //   FP_ODBC_TEST="…"     cargo test --lib tests_live -- --ignored   (qualunque DB: parametro di uscita, Postgres)
    //   FP_ORACLE_TEST="…"   cargo test --lib tests_live -- --ignored   (Oracle: chiave generata, MERGE, transazione)
    //   FP_INFORMIX_TEST="…" cargo test --lib tests_live -- --ignored   (Informix: chiave SERIAL, transazione)
    // Usano la tabella di prova FP_COLLAUDO_K (creata e cancellata dal test).
    use super::*;

    fn job(dialect: &str, mode: &str, rows: Vec<serde_json::Value>, returning: Option<&str>) -> WriteJob {
        WriteJob {
            tbl: "fp_collaudo_k".into(), dialect: dialect.into(), mode: mode.into(),
            keys: vec!["id".into()], rows,
            columns: None, exclude: None, column_functions: None, merge_condition: None,
            pre_sql: None, post_sql: None, batch_size: 100, on_error: "stop".into(),
            returning: returning.map(String::from), key_conditions: None, custom: None,
        }
    }

    /// Chiavi generate, MERGE e rollback di una transazione sul dialetto dato.
    fn collaudo(cs: &str, dialect: &str, create: &str) {
        let conn = open(cs, 10, dialect).unwrap();
        let _ = conn.execute("DROP TABLE fp_collaudo_k", (), None);
        conn.execute(create, (), None).unwrap();
        let rows = vec![serde_json::json!({"nome": "a"}), serde_json::json!({"nome": "b"})];
        let out = job(dialect, "insert", rows, Some("id")).run(&conn).unwrap();
        assert_eq!(out.written, 2);
        let k: Vec<i64> = out.keys.iter().map(|v| v.as_i64().expect("chiave intera")).collect();
        assert!(k.len() == 2 && k[0] > 0 && k[1] > k[0], "chiavi {:?}", k);
        // MERGE (Oracle: nativo; Informix: = upsert) sulla prima riga + una nuova con chiave esplicita
        let m = vec![serde_json::json!({"id": k[0], "nome": "z"}), serde_json::json!({"id": 1000, "nome": "n"})];
        job(dialect, "merge", m, None).run(&conn).unwrap();
        let mut ex = Exec::new(&conn);
        let first = serde_json::json!(k[0]);
        assert_eq!(ex.scalar_text("SELECT nome FROM fp_collaudo_k WHERE id = ?", &[&first]).unwrap().as_deref(), Some("z"));
        assert_eq!(ex.scalar_text("SELECT COUNT(*) FROM fp_collaudo_k", &[]).unwrap().as_deref(), Some("3"));
        drop(ex);
        // transazione annullata: la riga non resta
        conn.set_autocommit(false).unwrap();
        job(dialect, "insert", vec![serde_json::json!({"id": 2000, "nome": "tx"})], None).run(&conn).unwrap();
        conn.rollback().unwrap();
        conn.set_autocommit(true).unwrap();
        let mut ex = Exec::new(&conn);
        assert_eq!(ex.scalar_text("SELECT COUNT(*) FROM fp_collaudo_k", &[]).unwrap().as_deref(), Some("3"));
        drop(ex);
        conn.execute("DROP TABLE fp_collaudo_k", (), None).unwrap();
    }

    #[test]
    #[ignore]
    fn oracle_vero() {
        let Ok(cs) = std::env::var("FP_ORACLE_TEST") else { return };
        collaudo(&cs, "oracle", "CREATE TABLE fp_collaudo_k (id NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, nome VARCHAR2(30))");
    }

    #[test]
    #[ignore]
    fn informix_vero() {
        let Ok(cs) = std::env::var("FP_INFORMIX_TEST") else { return };
        collaudo(&cs, "informix", "CREATE TABLE fp_collaudo_k (id SERIAL PRIMARY KEY, nome VARCHAR(30))");
    }

    #[test]
    #[ignore]
    fn parametro_di_uscita() {
        let Ok(cs) = std::env::var("FP_ODBC_TEST") else { return };
        let conn = open(&cs, 5, "odbc").unwrap();
        let mut ex = Exec::new(&conn);
        let a = serde_json::json!(7);
        let b = serde_json::json!("x");
        let out = ex.run_with_out("{call fp_out(?, ?, ?)}", &[&a, &b]).unwrap();
        assert_eq!(out.as_deref(), Some("70-x"));
        let s = ex.scalar_text("SELECT 40 + ?", &[&a]).unwrap();
        assert_eq!(s.as_deref(), Some("47"));
    }
}
