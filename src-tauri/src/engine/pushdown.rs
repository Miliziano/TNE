// ─── src-tauri/src/engine/pushdown.rs ─────────────────────────────
//
// P394 — FILTRO SPINTO NELLA QUERY. Quando un DB Input alimenta SOLO un
// Filter (e lo scarto del Filter non è collegato), lo studio copia le
// condizioni del Filter nella busta del DB Input (`spec.config.pushdown`).
// Qui le si traduce in una clausola WHERE, così il database restituisce
// solo le righe che servono invece di mandarle tutte al motore.
//
// LA REGOLA CHE TIENE TUTTO: il WHERE deve tenere ALMENO le righe che il
// Filter terrebbe. Mai una di meno. Il Filter resta al suo posto e lavora
// come prima: scarta ciò che il database ha lasciato passare in più. Così
// il risultato è identico per costruzione, e ciò che non si sa tradurre con
// certezza si lascia semplicemente al Filter:
//
//  · AND / OR sono monotoni: un pezzo che non si traduce diventa TRUE (si
//    spinge il resto). NOT no: si traduce solo se il pezzo sotto è ESATTO.
//  · Si confronta un campo con un valore, e il tipo della colonna (letto dal
//    database con `describe`, prima di eseguire) deve corrispondere al tipo
//    del valore: numero con numero, testo con testo, data con data. Un
//    campo che non è una colonna nota, un'espressione calcolata, un tipo
//    sconosciuto: non si spinge.
//  · Le differenze di semantica fra FPEL e SQL si trattano una per una:
//      null       `x != 5` in FPEL è vero se x è null → `(x <> ? OR x IS NULL)`
//      testo      collation case-insensitive (MySQL) o padding (CHAR): `=`
//                 tiene di più (va bene), `!=` e `<` no → solo `=` / LIKE /
//                 IN; `!=` solo su PostgreSQL con colonne text/varchar
//      decimali   i numeri si legano come Decimal esatto (mai via f64)
//      date       DATE con 'AAAA-MM-GG' (CAST esplicito); TIMESTAMP solo con
//                 una data, e `>` diventa `>=` (FPEL confronta i testi); con
//                 fuso orario (timestamptz) mai
//  · I valori si LEGANO come parametri: nessun testo dell'utente entra
//    nell'SQL.
//
// Se il database rifiuta la query spinta prima di dare righe, il DB Input
// riparte con la query originale (v. source_db.rs): spingere è
// un'ottimizzazione, mai un rischio per il run.

use std::collections::HashMap;
use serde::Deserialize;
use crate::engine::expr::{BinaryOperator, ExprNode, LiteralValue, UnaryOperator};
use crate::engine::types::Value;

// ─── Config (dallo studio) ────────────────────────────────────────

#[derive(Debug, Deserialize, Clone, Default)]
pub struct PushdownCfg {
    /// Etichetta del Filter, per il log.
    #[serde(default)]
    pub filter: String,
    #[serde(default)]
    pub conditions: Vec<Condizione>,
    #[serde(default = "d_exclude")]
    pub null_behavior: String,
    #[serde(default = "d_true")]
    pub case_sensitive: bool,
}
fn d_exclude() -> String { "exclude".into() }
fn d_true() -> bool { true }

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Condizione {
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub clauses: Vec<Clausola>,
    #[serde(default)]
    pub expr: Option<ExprNode>,
}

#[derive(Debug, Deserialize, Clone, Default)]
pub struct Clausola {
    #[serde(default)]
    pub field: String,
    #[serde(default)]
    pub operator: String,
    #[serde(default)]
    pub value: String,
    #[serde(default = "d_and")]
    pub logic: String,
}
fn d_and() -> String { "AND".into() }

// ─── Dialetti e colonne ───────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Dialetto { Pg, My, Lite }

impl Dialetto {
    pub fn da(nome: &str) -> Option<Self> {
        match nome {
            d if d.starts_with("postgres") => Some(Dialetto::Pg),
            "mysql" | "mariadb" => Some(Dialetto::My),
            "sqlite" => Some(Dialetto::Lite),
            _ => None,
        }
    }
    pub fn quota(self, nome: &str) -> String {
        match self {
            Dialetto::My => format!("`{}`", nome.replace('`', "``")),
            _ => format!("\"{}\"", nome.replace('"', "\"\"")),
        }
    }
}

/// Categoria di una colonna, dal nome del tipo che dà il database.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cat {
    Int,
    Num,
    /// text/varchar (PostgreSQL: confronti esatti).
    Text,
    /// testo con regole proprie (CHAR con padding, citext, collation MySQL):
    /// `=` tiene di più, quindi solo `=`/LIKE/IN.
    TextLoose,
    Date,
    Timestamp,
    Bool,
    /// Testo ordinato come FPEL (SQLite: confronto BINARY, date in testo).
    TextOrdered,
    Other,
}

pub fn categoria(d: Dialetto, tipo: &str) -> Cat {
    let t = tipo.to_uppercase();
    let t = t.trim();
    match d {
        Dialetto::Pg => match t {
            "INT2" | "INT4" | "INT8" | "SMALLINT" | "INTEGER" | "BIGINT" => Cat::Int,
            "NUMERIC" | "DECIMAL" | "FLOAT4" | "FLOAT8" | "REAL" | "DOUBLE PRECISION" => Cat::Num,
            "TEXT" | "VARCHAR" | "CHARACTER VARYING" | "NAME" => Cat::Text,
            "BPCHAR" | "CHAR" | "CHARACTER" | "CITEXT" => Cat::TextLoose,
            "DATE" => Cat::Date,
            "TIMESTAMP" => Cat::Timestamp,
            "BOOL" | "BOOLEAN" => Cat::Bool,
            _ => Cat::Other,
        },
        Dialetto::My => {
            let base = t.trim_end_matches(" UNSIGNED");
            match base {
                "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" => Cat::Int,
                "DECIMAL" | "NUMERIC" | "FLOAT" | "DOUBLE" | "REAL" => Cat::Num,
                "CHAR" | "VARCHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" => Cat::TextLoose,
                "DATE" => Cat::Date,
                "DATETIME" | "TIMESTAMP" => Cat::Timestamp,
                "BOOLEAN" | "BOOL" => Cat::Bool,
                _ => Cat::Other,
            }
        }
        // SQLite: regole di affinità sul tipo dichiarato.
        Dialetto::Lite => {
            if t.contains("INT") { Cat::Int }
            else if t.contains("CHAR") || t.contains("CLOB") || t.contains("TEXT") { Cat::TextOrdered }
            else if t.contains("REAL") || t.contains("FLOA") || t.contains("DOUB") || t.contains("NUMERIC") || t.contains("DECIMAL") { Cat::Num }
            else if t.contains("DATE") || t.contains("TIME") { Cat::TextOrdered }
            else { Cat::Other }
        }
    }
}

// ─── Traduzione ───────────────────────────────────────────────────

/// Risultato di un pezzo: nessun vincolo (lo controlla solo il Filter) o
/// un pezzo di SQL; `esatto` = tiene esattamente le righe che FPEL tiene.
#[derive(Debug, Clone)]
enum T {
    Vero,
    Sql { sql: String, esatto: bool },
}

pub struct Spinta {
    pub where_sql: String,
    pub binds:     Vec<Value>,
    /// Il WHERE tiene esattamente le righe del Filter (altrimenti un
    /// sopra-insieme, che il Filter rifinisce).
    pub esatto:    bool,
}

struct Traduttore<'a> {
    d:         Dialetto,
    colonne:   &'a HashMap<String, Cat>,
    variabili: &'a HashMap<String, Value>,
    binds:     Vec<Value>,
    /// Numero del primo segnaposto (PostgreSQL: `$n`).
    primo:     usize,
}

impl Traduttore<'_> {
    fn segnaposto(&mut self, v: Value) -> String {
        self.binds.push(v);
        match self.d {
            Dialetto::Pg => format!("${}", self.primo + self.binds.len() - 1),
            _ => "?".to_string(),
        }
    }

    fn colonna(&self, e: &ExprNode) -> Option<(String, Cat)> {
        let nome = match e {
            ExprNode::DirectFieldRef { field } => field,
            ExprNode::FieldRef { field, input } if !input.starts_with("__") => field,
            _ => return None,
        };
        let cat = *self.colonne.get(nome)?;
        if cat == Cat::Other { return None }
        Some((nome.clone(), cat))
    }

    /// Un valore noto prima di eseguire: letterale o variabile di lane.
    fn valore(&self, e: &ExprNode) -> Option<Value> {
        match e {
            ExprNode::Literal { value } => Some(match value {
                LiteralValue::Null      => Value::Null,
                LiteralValue::Bool(b)   => Value::Bool(*b),
                LiteralValue::Int(i)    => Value::Int(*i),
                LiteralValue::Float(f)  => Value::Float(*f),
                LiteralValue::String(s) => Value::String(s.clone()),
            }),
            ExprNode::FunctionCall { name, args } if name.eq_ignore_ascii_case("var") => {
                let nome = match args.first()? {
                    ExprNode::Literal { value: LiteralValue::String(s) } => s,
                    _ => return None,
                };
                // Come FPEL: una variabile che non c'è vale null.
                Some(self.variabili.get(nome).cloned().unwrap_or(Value::Null))
            }
            _ => None,
        }
    }

    fn espressione(&mut self, e: &ExprNode) -> T {
        match e {
            ExprNode::Literal { value: LiteralValue::Bool(true) } => T::Sql { sql: "1=1".into(), esatto: true },
            ExprNode::BinaryOp { op: BinaryOperator::And, left, right } => {
                let (a, b) = (self.espressione(left), self.espressione(right));
                match (a, b) {
                    (T::Vero, T::Vero) => T::Vero,
                    (T::Sql { sql, .. }, T::Vero) | (T::Vero, T::Sql { sql, .. }) => T::Sql { sql, esatto: false },
                    (T::Sql { sql: x, esatto: ex }, T::Sql { sql: y, esatto: ey }) =>
                        T::Sql { sql: format!("({x} AND {y})"), esatto: ex && ey },
                }
            }
            ExprNode::BinaryOp { op: BinaryOperator::Or, left, right } => {
                // Un ramo senza vincolo rende senza vincolo tutto l'OR: i
                // segnaposto eventualmente già aggiunti dall'altro ramo vanno tolti.
                let segno = self.binds.len();
                match (self.espressione(left), self.espressione(right)) {
                    (T::Sql { sql: x, esatto: ex }, T::Sql { sql: y, esatto: ey }) =>
                        T::Sql { sql: format!("({x} OR {y})"), esatto: ex && ey },
                    _ => { self.binds.truncate(segno); T::Vero }
                }
            }
            ExprNode::UnaryOp { op: UnaryOperator::Not, expr } => {
                let segno = self.binds.len();
                match self.espressione(expr) {
                    // NOT di un sopra-insieme sarebbe un sotto-insieme: solo se esatto.
                    // COALESCE: in FPEL `!(x > 5)` con x null è vero.
                    T::Sql { sql, esatto: true } => T::Sql { sql: format!("NOT COALESCE({sql}, FALSE)"), esatto: true },
                    _ => { self.binds.truncate(segno); T::Vero }
                }
            }
            ExprNode::IsNull { expr } => match self.colonna(expr) {
                Some((c, _)) => T::Sql { sql: format!("{} IS NULL", self.d.quota(&c)), esatto: true },
                None => T::Vero,
            },
            ExprNode::IsNotNull { expr } => match self.colonna(expr) {
                Some((c, _)) => T::Sql { sql: format!("{} IS NOT NULL", self.d.quota(&c)), esatto: true },
                None => T::Vero,
            },
            ExprNode::BinaryOp { op, left, right } => {
                use BinaryOperator::*;
                if !matches!(op, Eq | Ne | Lt | Lte | Gt | Gte) { return T::Vero }
                // campo OP valore, oppure valore OP campo (si gira l'operatore)
                if let (Some(col), Some(v)) = (self.colonna(left), self.valore(right)) {
                    return self.confronto(col, op.clone(), v);
                }
                if let (Some(v), Some(col)) = (self.valore(left), self.colonna(right)) {
                    let girato = match op { Lt => Gt, Lte => Gte, Gt => Lt, Gte => Lte, o => o.clone() };
                    return self.confronto(col, girato, v);
                }
                T::Vero
            }
            ExprNode::FunctionCall { name, args } => self.funzione(name, args),
            // Un campo booleano da solo: vero se vale true.
            e => match self.colonna(e) {
                Some((c, Cat::Bool)) => T::Sql { sql: format!("{} IS TRUE", self.d.quota(&c)), esatto: true },
                _ => T::Vero,
            },
        }
    }

    fn confronto(&mut self, (col, cat): (String, Cat), op: BinaryOperator, v: Value) -> T {
        use BinaryOperator::*;
        let q = self.d.quota(&col);
        // Con null: `==` è IS NULL, `!=` IS NOT NULL, gli altri sono sempre falsi.
        if matches!(v, Value::Null) {
            return match op {
                Eq => T::Sql { sql: format!("{q} IS NULL"), esatto: true },
                Ne => T::Sql { sql: format!("{q} IS NOT NULL"), esatto: true },
                _  => T::Sql { sql: "1=0".into(), esatto: true },
            };
        }
        let simbolo = match op { Eq => "=", Ne => "<>", Lt => "<", Lte => "<=", Gt => ">", Gte => ">=", _ => return T::Vero };
        // `x != v` in FPEL tiene anche le righe con x null.
        let con_null = |s: String| if op == Ne { format!("({s} OR {q} IS NULL)") } else { s };

        match cat {
            Cat::Int | Cat::Num => {
                let Some(dec) = decimale(&v) else { return T::Vero };
                let b = self.legame_numero(dec, &v);
                let p = self.segnaposto(b);
                T::Sql { sql: con_null(format!("{q} {simbolo} {p}")), esatto: true }
            }
            Cat::Text | Cat::TextLoose => {
                let Value::String(s) = v else { return T::Vero };
                match op {
                    Eq => {
                        let p = self.segnaposto(Value::String(s));
                        T::Sql { sql: format!("{q} = {p}"), esatto: cat == Cat::Text }
                    }
                    Ne if cat == Cat::Text && self.d == Dialetto::Pg => {
                        let p = self.segnaposto(Value::String(s));
                        T::Sql { sql: con_null(format!("{q} <> {p}")), esatto: true }
                    }
                    _ => T::Vero,
                }
            }
            Cat::TextOrdered => {
                // SQLite: testo contro testo, confronto BINARY = quello di FPEL.
                let Value::String(s) = v else { return T::Vero };
                let p = self.segnaposto(Value::String(s));
                T::Sql { sql: con_null(format!("{q} {simbolo} {p}")), esatto: true }
            }
            Cat::Date => {
                let Some(giorno) = data(&v) else { return T::Vero };
                let p = self.segnaposto(Value::String(giorno));
                T::Sql { sql: con_null(format!("{q} {simbolo} CAST({p} AS DATE)")), esatto: true }
            }
            Cat::Timestamp => {
                // FPEL confronta i testi: "2024-01-01 00:00:00" > "2024-01-01" è
                // vero già a mezzanotte → `>` diventa `>=`; `<=` tiene di più
                // (la mezzanotte), va bene; `=`/`!=` non hanno un equivalente.
                let Some(giorno) = data(&v) else { return T::Vero };
                let (s, esatto) = match op { Gt => (">=", false), Gte => (">=", true), Lt => ("<", true), Lte => ("<=", false), _ => return T::Vero };
                let p = self.segnaposto(Value::String(giorno));
                T::Sql { sql: format!("{q} {s} CAST({p} AS DATE)"), esatto }
            }
            Cat::Bool => {
                let Value::Bool(b) = v else { return T::Vero };
                match op {
                    Eq | Ne => {
                        let p = self.segnaposto(Value::Bool(b));
                        T::Sql { sql: con_null(format!("{q} {simbolo} {p}")), esatto: true }
                    }
                    _ => T::Vero,
                }
            }
            Cat::Other => T::Vero,
        }
    }

    /// Un numero si lega esatto: Decimal su PostgreSQL e MySQL; su SQLite
    /// (che non ha NUMERIC) intero o float come è scritto.
    fn legame_numero(&self, dec: rust_decimal::Decimal, originale: &Value) -> Value {
        match self.d {
            Dialetto::Lite => match originale { Value::Int(_) | Value::Float(_) => originale.clone(), _ => Value::Decimal(dec) },
            _ => Value::Decimal(dec),
        }
    }

    fn funzione(&mut self, name: &str, args: &[ExprNode]) -> T {
        // like(campo, "modello"), contains/starts_with/ends_with(campo, "testo")
        let (Some(c), Some(v)) = (args.first(), args.get(1)) else { return T::Vero };
        let Some((col, cat)) = self.colonna(c) else { return T::Vero };
        if !matches!(cat, Cat::Text | Cat::TextLoose | Cat::TextOrdered) { return T::Vero }
        let Some(Value::String(s)) = self.valore(v) else { return T::Vero };
        // Niente caratteri speciali di LIKE nel testo cercato, niente escape:
        // così il modello vuol dire la stessa cosa in tutti i dialetti.
        let modello = match name {
            "like" if !s.contains('\\') => s,
            "contains"    if semplice(&s) => format!("%{s}%"),
            "starts_with" if semplice(&s) => format!("{s}%"),
            "ends_with"   if semplice(&s) => format!("%{s}"),
            _ => return T::Vero,
        };
        let q = self.d.quota(&col);
        let p = self.segnaposto(Value::String(modello));
        // Esatto solo dove LIKE distingue le maiuscole (PostgreSQL, text).
        T::Sql { sql: format!("{q} LIKE {p}"), esatto: self.d == Dialetto::Pg && cat == Cat::Text }
    }

    // ── modalità visual del Filter ──
    fn visuale(&mut self, clausole: &[Clausola], case_sensitive: bool) -> T {
        if clausole.is_empty() { return T::Vero }
        // Il connettore sta sulla clausola PRECEDENTE, valutazione da sinistra.
        let mut acc = self.clausola(&clausole[0], case_sensitive);
        for i in 1..clausole.len() {
            let segno = self.binds.len();
            let cur = self.clausola(&clausole[i], case_sensitive);
            acc = if clausole[i - 1].logic == "OR" {
                match (acc, cur) {
                    (T::Sql { sql: x, esatto: ex }, T::Sql { sql: y, esatto: ey }) => T::Sql { sql: format!("({x} OR {y})"), esatto: ex && ey },
                    _ => { self.binds.truncate(segno); T::Vero }
                }
            } else {
                match (acc, cur) {
                    (T::Vero, T::Vero) => T::Vero,
                    (T::Sql { sql, .. }, T::Vero) | (T::Vero, T::Sql { sql, .. }) => T::Sql { sql, esatto: false },
                    (T::Sql { sql: x, esatto: ex }, T::Sql { sql: y, esatto: ey }) => T::Sql { sql: format!("({x} AND {y})"), esatto: ex && ey },
                }
            };
        }
        acc
    }

    fn clausola(&mut self, c: &Clausola, case_sensitive: bool) -> T {
        let Some(cat) = self.colonne.get(&c.field).copied().filter(|k| *k != Cat::Other) else { return T::Vero };
        let q = self.d.quota(&c.field);
        match c.operator.as_str() {
            "is_null"  => T::Sql { sql: format!("{q} IS NULL"), esatto: true },
            "not_null" => T::Sql { sql: format!("{q} IS NOT NULL"), esatto: true },
            // Confronti numerici del Filter: in f64 (filter.rs `cmp`). Sugli
            // interi coincide con SQL; sui decimali no (oltre 15 cifre) → solo Int.
            op @ (">" | ">=" | "<" | "<=") if cat == Cat::Int => {
                let Some(n) = c.value.trim().parse::<f64>().ok().and_then(rust_decimal::Decimal::from_f64_retain_safe) else { return T::Vero };
                let p = self.segnaposto(Value::Decimal(n));
                T::Sql { sql: format!("{q} {op} {p}"), esatto: true }
            }
            // `==` confronta i TESTI dei valori: se i testi sono uguali lo sono
            // anche i valori, quindi `=` in SQL tiene almeno quelle righe.
            "==" if case_sensitive && matches!(cat, Cat::Text | Cat::TextLoose | Cat::TextOrdered) => {
                let p = self.segnaposto(Value::String(c.value.clone()));
                T::Sql { sql: format!("{q} = {p}"), esatto: self.d == Dialetto::Pg && cat == Cat::Text }
            }
            "in" if case_sensitive && matches!(cat, Cat::Text | Cat::TextLoose | Cat::TextOrdered) => {
                let voci: Vec<String> = c.value.split(',').map(|s| s.trim().to_string()).collect();
                let ps: Vec<String> = voci.into_iter().map(|v| self.segnaposto(Value::String(v))).collect();
                T::Sql { sql: format!("{q} IN ({})", ps.join(", ")), esatto: self.d == Dialetto::Pg && cat == Cat::Text }
            }
            op @ ("contains" | "starts" | "ends") if case_sensitive && matches!(cat, Cat::Text | Cat::TextLoose | Cat::TextOrdered) && semplice(&c.value) && !c.value.is_empty() => {
                let m = match op { "contains" => format!("%{}%", c.value), "starts" => format!("{}%", c.value), _ => format!("%{}", c.value) };
                let p = self.segnaposto(Value::String(m));
                T::Sql { sql: format!("{q} LIKE {p}"), esatto: self.d == Dialetto::Pg && cat == Cat::Text }
            }
            _ => T::Vero,
        }
    }
}

/// Testo senza i caratteri speciali di LIKE.
fn semplice(s: &str) -> bool { !s.contains(['%', '_', '\\']) }

/// Valore numerico esatto di un letterale (testo escluso: confrontare un
/// numero con un testo in FPEL e in SQL non va allo stesso modo).
fn decimale(v: &Value) -> Option<rust_decimal::Decimal> {
    match v {
        Value::Int(i) => Some(rust_decimal::Decimal::from(*i)),
        Value::Decimal(d) => Some(*d),
        Value::Float(f) if f.is_finite() => rust_decimal::Decimal::from_f64_retain_safe(*f),
        _ => None,
    }
}

/// 'AAAA-MM-GG' valida (come la scrive FPEL per un valore Date).
fn data(v: &Value) -> Option<String> {
    let s = match v { Value::String(s) | Value::Date(s) => s, _ => return None };
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().filter(|_| s.len() == 10).map(|_| s.clone())
}

/// Conversione f64 → Decimal che dà il numero "come è scritto" (0.1 → 0.1).
trait DaF64 { fn from_f64_retain_safe(f: f64) -> Option<rust_decimal::Decimal>; }
impl DaF64 for rust_decimal::Decimal {
    fn from_f64_retain_safe(f: f64) -> Option<rust_decimal::Decimal> {
        use std::str::FromStr;
        if !f.is_finite() { return None }
        rust_decimal::Decimal::from_str(&format!("{f}")).ok()
    }
}

/// Traduce le condizioni del Filter in un WHERE. `Err(motivo)` = non si
/// spinge niente (il motivo va nel log del nodo).
pub fn traduci(
    cfg: &PushdownCfg,
    d: Dialetto,
    colonne: &HashMap<String, Cat>,
    variabili: &HashMap<String, Value>,
    primo_segnaposto: usize,
) -> Result<Spinta, String> {
    if cfg.conditions.is_empty() { return Err("the filter has no conditions".into()) }
    let mut t = Traduttore { d, colonne, variabili, binds: Vec::new(), primo: primo_segnaposto };
    // La riga esce dal Filter se una qualunque condizione è vera: OR.
    let mut parti: Vec<(String, bool)> = Vec::new();
    for c in &cfg.conditions {
        let r = match c.mode.as_str() {
            "code" => match &c.expr { Some(e) => t.espressione(e), None => T::Vero },
            "visual" if cfg.null_behavior == "exclude" => t.visuale(&c.clauses, cfg.case_sensitive),
            _ => T::Vero,
        };
        match r {
            T::Sql { sql, esatto } => parti.push((sql, esatto)),
            T::Vero => return Err("a condition cannot be expressed in SQL with the same meaning".into()),
        }
    }
    let esatto = parti.iter().all(|(_, e)| *e);
    let where_sql = if parti.len() == 1 { parti.remove(0).0 } else {
        parti.into_iter().map(|(s, _)| s).collect::<Vec<_>>().join(" OR ")
    };
    Ok(Spinta { where_sql, binds: t.binds, esatto })
}

/// La query sorta (ORDER BY fuori da parentesi e stringhe)? Avvolgerla in un
/// SELECT esterno non garantirebbe più l'ordine (MySQL lo scarta).
pub fn ordina(sql: &str) -> bool {
    let mut profondita = 0i32;
    let mut in_stringa: Option<char> = None;
    let basso = sql.to_lowercase();
    let b = basso.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let c = b[i] as char;
        match in_stringa {
            Some(q) => { if c == q { in_stringa = None } }
            None => match c {
                '\'' | '"' | '`' => in_stringa = Some(c),
                '(' => profondita += 1,
                ')' => profondita -= 1,
                'o' if profondita == 0 && basso[i..].starts_with("order")
                    && (i == 0 || !(b[i - 1] as char).is_alphanumeric() && b[i - 1] != b'_') => {
                    let resto = basso[i + 5..].trim_start();
                    if resto.starts_with("by") { return true }
                }
                _ => {}
            },
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cfg(conds: serde_json::Value) -> PushdownCfg {
        serde_json::from_value(json!({ "filter": "f", "conditions": conds })).unwrap()
    }
    fn code(e: serde_json::Value) -> serde_json::Value { json!({ "mode": "code", "expr": e }) }
    fn f(n: &str) -> serde_json::Value { json!({ "kind": "DirectFieldRef", "field": n }) }
    fn lit(v: serde_json::Value) -> serde_json::Value { json!({ "kind": "Literal", "value": v }) }
    fn bin(op: &str, l: serde_json::Value, r: serde_json::Value) -> serde_json::Value { json!({ "kind": "BinaryOp", "op": op, "left": l, "right": r }) }
    fn colonne(d: Dialetto, c: &[(&str, &str)]) -> HashMap<String, Cat> {
        c.iter().map(|(n, t)| (n.to_string(), categoria(d, t))).collect()
    }

    #[test]
    fn confronti_e_segnaposto() {
        let col = colonne(Dialetto::Pg, &[("qta", "INT4"), ("nome", "TEXT"), ("giorno", "DATE"), ("ts", "TIMESTAMP"), ("x", "JSONB")]);
        let vars = HashMap::from([("soglia".to_string(), Value::Int(5))]);
        let c = cfg(json!([code(bin("AND",
            bin("GT", f("qta"), json!({"kind":"FunctionCall","name":"var","args":[lit(json!("soglia"))]})),
            bin("NE", f("nome"), lit(json!("x")))))]));
        let s = traduci(&c, Dialetto::Pg, &col, &vars, 3).unwrap();
        assert_eq!(s.where_sql, "(\"qta\" > $3 AND (\"nome\" <> $4 OR \"nome\" IS NULL))");
        assert_eq!(s.binds, vec![Value::Decimal(5.into()), Value::String("x".into())]);
        assert!(s.esatto);

        // 10 < qta: si gira; data con CAST; timestamp: > diventa >= (non esatto)
        let c = cfg(json!([code(bin("AND", bin("LT", lit(json!(10)), f("qta")),
            bin("AND", bin("GTE", f("giorno"), lit(json!("2024-01-31"))), bin("GT", f("ts"), lit(json!("2024-02-01"))))))]));
        let s = traduci(&c, Dialetto::Pg, &col, &vars, 1).unwrap();
        assert_eq!(s.where_sql, "(\"qta\" > $1 AND (\"giorno\" >= CAST($2 AS DATE) AND \"ts\" >= CAST($3 AS DATE)))");
        assert!(!s.esatto);
    }

    #[test]
    fn cio_che_non_si_traduce_resta_al_filter() {
        let col = colonne(Dialetto::My, &[("qta", "INT"), ("nome", "VARCHAR"), ("x", "JSON")]);
        let vars = HashMap::new();
        // AND: il pezzo non traducibile si lascia al Filter (sopra-insieme)
        let c = cfg(json!([code(bin("AND", bin("GT", f("qta"), lit(json!(1))), bin("GT", f("nome"), lit(json!("m")))))]));
        let s = traduci(&c, Dialetto::My, &col, &vars, 1).unwrap();
        assert_eq!(s.where_sql, "`qta` > ?");
        assert!(!s.esatto);
        // OR con un ramo non traducibile: niente da spingere, e nessun segnaposto rimasto
        let c = cfg(json!([code(bin("OR", bin("GT", f("qta"), lit(json!(1))), bin("EQ", f("x"), lit(json!("a")))))]));
        assert!(traduci(&c, Dialetto::My, &col, &vars, 1).is_err());
        // MySQL: `!=` su testo no (collation), `=` sì ma non esatto
        let c = cfg(json!([code(bin("NE", f("nome"), lit(json!("a"))))]));
        assert!(traduci(&c, Dialetto::My, &col, &vars, 1).is_err());
        let c = cfg(json!([code(bin("EQ", f("nome"), lit(json!("a"))))]));
        let s = traduci(&c, Dialetto::My, &col, &vars, 1).unwrap();
        assert!(!s.esatto && s.where_sql == "`nome` = ?");
        // numero contro testo: no
        let c = cfg(json!([code(bin("GT", f("qta"), lit(json!("10"))))]));
        assert!(traduci(&c, Dialetto::My, &col, &vars, 1).is_err());
        // NOT di un pezzo non esatto: no; di uno esatto sì, con COALESCE
        let c = cfg(json!([code(json!({"kind":"UnaryOp","op":"NOT","expr": bin("EQ", f("nome"), lit(json!("a")))}))]));
        assert!(traduci(&c, Dialetto::My, &col, &vars, 1).is_err());
        let c = cfg(json!([code(json!({"kind":"UnaryOp","op":"NOT","expr": bin("GT", f("qta"), lit(json!(3)))}))]));
        assert_eq!(traduci(&c, Dialetto::My, &col, &vars, 1).unwrap().where_sql, "NOT COALESCE(`qta` > ?, FALSE)");
        // campo che non è una colonna nota: no
        let c = cfg(json!([code(bin("GT", f("manca"), lit(json!(1))))]));
        assert!(traduci(&c, Dialetto::My, &col, &vars, 1).is_err());
    }

    #[test]
    fn piu_condizioni_in_or_e_visual() {
        let col = colonne(Dialetto::Lite, &[("qta", "INTEGER"), ("nome", "TEXT"), ("prezzo", "NUMERIC")]);
        let vars = HashMap::new();
        let c: PushdownCfg = serde_json::from_value(json!({ "conditions": [
            { "mode": "visual", "clauses": [
                { "field": "qta", "operator": ">", "value": "2", "logic": "OR" },
                { "field": "nome", "operator": "starts", "value": "A", "logic": "AND" }] },
            code(bin("EQ", f("nome"), lit(json!("zz")))),
        ], "case_sensitive": true })).unwrap();
        let s = traduci(&c, Dialetto::Lite, &col, &vars, 1).unwrap();
        assert_eq!(s.where_sql, "(\"qta\" > ? OR \"nome\" LIKE ?) OR \"nome\" = ?");
        assert_eq!(s.binds[1], Value::String("A%".into()));
        // visual su decimali: confronto f64 nel Filter → non si spinge
        let c: PushdownCfg = serde_json::from_value(json!({ "conditions": [
            { "mode": "visual", "clauses": [{ "field": "prezzo", "operator": ">", "value": "2" }] }] })).unwrap();
        assert!(traduci(&c, Dialetto::Lite, &col, &vars, 1).is_err());
        // template: no
        let c: PushdownCfg = serde_json::from_value(json!({ "conditions": [{ "mode": "template" }] })).unwrap();
        assert!(traduci(&c, Dialetto::Lite, &col, &vars, 1).is_err());
    }

    #[test]
    fn order_by_rilevato() {
        assert!(ordina("select * from t ORDER BY a"));
        assert!(ordina("select * from t order\n by a desc limit 3"));
        assert!(!ordina("select * from (select * from t order by a) s"));
        assert!(!ordina("select 'order by' as x from t"));
        assert!(!ordina("select reorder_by from t"));
    }
}
