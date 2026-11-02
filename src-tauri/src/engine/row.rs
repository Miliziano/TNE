// ─── src-tauri/src/engine/row.rs ──────────────────────────────────
// La riga del motore con SCHEMA CONDIVISO (P385, voce A di
// docs/STUDIO-motore-prestazioni.md; regole in §6).
//
// Prima: `Row(HashMap<String, Value>)` — ogni riga portava i nomi dei suoi
// campi, copiati in ogni riga e a ogni nodo, e ogni lettura calcolava un hash.
// Ora: la riga è (schema condiviso, valori). Lo schema è l'elenco dei nomi,
// immutabile, condiviso da tutte le righe con la stessa forma (un `Arc`).
// Copiare una riga copia i valori e incrementa un contatore, non i nomi.
//
// Cosa NON cambia (regole del 2 novembre):
//   - l'interfaccia è per NOME: get/set/remove/iter come prima. Le posizioni
//     restano dentro questo file e non escono mai (né verso i nodi, né verso
//     SQL, CSV, JSON);
//   - lo schema non è un contratto: descrive i campi che la riga HA. Se un nodo
//     aggiunge o toglie un campo nasce uno schema derivato (in cache, quindi le
//     righe che cambiano forma allo stesso modo lo condividono);
//   - campo assente = `None` da `get`, come prima. Nessun errore per forma.
//
// Differenza voluta: l'ordine dei campi è quello di inserimento (prima era
// l'ordine casuale di una HashMap). Chi ha bisogno di un ordine diverso lo
// chiede esplicitamente, come faceva già (vedi `to_json_object_sorted`).

use super::types::Value;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

/// Oltre questi campi la ricerca per nome usa un indice invece di scorrere.
const INDEX_FROM: usize = 12;
/// Tetto alle transizioni tenute in cache per schema: con righe di forma molto
/// variabile (JSON con chiavi sempre diverse) gli schemi nuovi non si tengono,
/// così la memoria non cresce. Più lento in quel caso, mai sbagliato.
const MAX_TRANSITIONS: usize = 256;

pub struct Schema {
    names: Vec<String>,
    index: Option<HashMap<String, usize, ahash::RandomState>>,
    /// nome aggiunto → schema derivato
    added: RwLock<HashMap<String, Arc<Schema>, ahash::RandomState>>,
    /// posizione tolta → schema derivato
    removed: RwLock<HashMap<usize, Arc<Schema>, ahash::RandomState>>,
}

impl std::fmt::Debug for Schema {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.names.iter()).finish()
    }
}

impl Schema {
    pub fn new(names: Vec<String>) -> Arc<Schema> {
        let index = (names.len() >= INDEX_FROM).then(|| {
            let mut m: HashMap<String, usize, ahash::RandomState> = HashMap::default();
            // a parità di nome vale la PRIMA posizione: i nomi in uno schema
            // sono comunque unici (lo garantisce chi lo costruisce)
            for (i, n) in names.iter().enumerate().rev() {
                m.insert(n.clone(), i);
            }
            m
        });
        Arc::new(Schema { names, index, added: RwLock::default(), removed: RwLock::default() })
    }

    fn empty() -> Arc<Schema> {
        static EMPTY: OnceLock<Arc<Schema>> = OnceLock::new();
        EMPTY.get_or_init(|| Schema::new(Vec::new())).clone()
    }

    pub fn names(&self) -> &[String] {
        &self.names
    }

    pub fn len(&self) -> usize {
        self.names.len()
    }

    /// Posizione del campo, se c'è.
    pub fn position(&self, name: &str) -> Option<usize> {
        match &self.index {
            Some(m) => m.get(name).copied(),
            None => self.names.iter().position(|n| n == name),
        }
    }

    /// Schema con `name` aggiunto in coda. Il nome si copia solo la prima
    /// volta: poi la transizione è in cache e si cerca per `&str`.
    fn with_added(self: &Arc<Self>, name: &str) -> Arc<Schema> {
        if let Some(s) = self.added.read().ok().and_then(|m| m.get(name).cloned()) {
            return s;
        }
        let mut names = Vec::with_capacity(self.names.len() + 1);
        names.extend(self.names.iter().cloned());
        names.push(name.to_string());
        let s = Schema::new(names);
        if let Ok(mut m) = self.added.write() {
            if m.len() < MAX_TRANSITIONS {
                return m.entry(name.to_string()).or_insert(s).clone();
            }
        }
        s
    }

    fn with_removed(self: &Arc<Self>, pos: usize) -> Arc<Schema> {
        if let Some(s) = self.removed.read().ok().and_then(|m| m.get(&pos).cloned()) {
            return s;
        }
        let mut names = self.names.clone();
        names.remove(pos);
        let s = Schema::new(names);
        if let Ok(mut m) = self.removed.write() {
            if m.len() < MAX_TRANSITIONS {
                return m.entry(pos).or_insert(s).clone();
            }
        }
        s
    }
}

/// Una riga: schema condiviso + un valore per ogni nome dello schema.
#[derive(Clone)]
pub struct Row {
    schema: Arc<Schema>,
    values: Vec<Value>,
}

impl Default for Row {
    fn default() -> Self {
        Row::new()
    }
}

impl std::fmt::Debug for Row {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_map().entries(self.iter()).finish()
    }
}

impl Row {
    pub fn new() -> Self {
        Row { schema: Schema::empty(), values: Vec::new() }
    }

    /// Riga da uno schema già pronto (le sorgenti lo costruiscono una volta).
    /// `values` deve avere un valore per ogni nome dello schema.
    pub fn from_parts(schema: Arc<Schema>, values: Vec<Value>) -> Self {
        debug_assert_eq!(schema.len(), values.len());
        Row { schema, values }
    }

    pub fn schema(&self) -> &Arc<Schema> {
        &self.schema
    }

    // ── Lettura ──────────────────────────────────────────────────

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.schema.position(key).map(|i| &self.values[i])
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        let i = self.schema.position(key)?;
        Some(&mut self.values[i])
    }

    pub fn has(&self, key: &str) -> bool {
        self.schema.position(key).is_some()
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.has(key)
    }

    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// Coppie (nome, valore) nell'ordine di inserimento.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.schema.names.iter().zip(self.values.iter())
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&String, &mut Value)> {
        self.schema.names.iter().zip(self.values.iter_mut())
    }

    /// Itera su tutte le coppie (campo, valore). Alias storico di `iter`.
    pub fn fields(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.iter()
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.schema.names.iter()
    }

    pub fn values(&self) -> impl Iterator<Item = &Value> {
        self.values.iter()
    }

    // ── Scrittura ────────────────────────────────────────────────

    /// Imposta un campo: lo sovrascrive se c'è, altrimenti lo aggiunge in coda
    /// (schema derivato, condiviso dalle righe che cambiano forma allo stesso modo).
    pub fn insert(&mut self, key: String, value: Value) -> Option<Value> {
        self.insert_str(&key, value)
    }

    /// Come `insert` ma col nome in prestito: nel caso comune (campo già
    /// presente, o forma già vista) non alloca nulla. È la via dei nodi caldi.
    pub fn insert_str(&mut self, key: &str, value: Value) -> Option<Value> {
        match self.schema.position(key) {
            Some(i) => Some(std::mem::replace(&mut self.values[i], value)),
            None => {
                self.schema = self.schema.with_added(key);
                self.values.push(value);
                None
            }
        }
    }

    pub fn set(&mut self, key: String, value: Value) {
        self.insert_str(&key, value);
    }

    pub fn set_str(&mut self, key: &str, value: Value) {
        self.insert_str(key, value);
    }

    /// Imposta il campo solo se non c'è già (era `entry(k).or_insert(v)`).
    pub fn set_if_absent(&mut self, key: String, value: Value) {
        if !self.has(&key) {
            self.insert(key, value);
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let i = self.schema.position(key)?;
        self.schema = self.schema.with_removed(i);
        Some(self.values.remove(i))
    }

    /// Tiene solo i campi per cui `keep` è vero.
    pub fn retain(&mut self, mut keep: impl FnMut(&String, &Value) -> bool) {
        let drop: Vec<String> = self.iter().filter(|(k, v)| !keep(k, v)).map(|(k, _)| k.clone()).collect();
        for k in drop {
            self.remove(&k);
        }
    }

    // ── Conversioni ──────────────────────────────────────────────

    pub fn from_json_object(obj: serde_json::Map<String, serde_json::Value>) -> Self {
        obj.into_iter().map(|(k, v)| (k, Value::from_json(v))).collect()
    }

    pub fn to_json_object(&self) -> serde_json::Value {
        let map: serde_json::Map<String, serde_json::Value> = self.iter()
            .map(|(k, v)| (k.clone(), v.to_json()))
            .collect();
        serde_json::Value::Object(map)
    }

    /// Come to_json_object, per la scrittura su database (Decimal esatti,
    /// vedi `Value::to_write_json`).
    pub fn to_write_json_object(&self) -> serde_json::Value {
        let map: serde_json::Map<String, serde_json::Value> = self.iter()
            .map(|(k, v)| (k.clone(), v.to_write_json()))
            .collect();
        serde_json::Value::Object(map)
    }

    /// Come to_json_object ma con le chiavi ordinate: output stabile per log,
    /// serializer e file.
    pub fn to_json_object_sorted(&self) -> serde_json::Value {
        let mut pairs: Vec<(&String, &Value)> = self.iter().collect();
        pairs.sort_by(|a, b| a.0.cmp(b.0));
        let map: serde_json::Map<String, serde_json::Value> = pairs.into_iter()
            .map(|(k, v)| (k.clone(), v.to_json()))
            .collect();
        serde_json::Value::Object(map)
    }

    /// Proietta solo le colonne richieste (column pruning a runtime).
    pub fn project(&self, columns: &[String]) -> Self {
        columns.iter()
            .filter_map(|col| self.get(col).map(|v| (col.clone(), v.clone())))
            .collect()
    }
}

impl FromIterator<(String, Value)> for Row {
    fn from_iter<I: IntoIterator<Item = (String, Value)>>(iter: I) -> Self {
        let mut row = Row::new();
        let iter = iter.into_iter();
        row.values.reserve(iter.size_hint().0);
        for (k, v) in iter {
            row.insert(k, v);
        }
        row
    }
}

impl IntoIterator for Row {
    type Item = (String, Value);
    type IntoIter = std::iter::Zip<std::vec::IntoIter<String>, std::vec::IntoIter<Value>>;
    fn into_iter(self) -> Self::IntoIter {
        let names = self.schema.names.clone();
        names.into_iter().zip(self.values)
    }
}

impl<'a> IntoIterator for &'a Row {
    type Item = (&'a String, &'a Value);
    type IntoIter = std::iter::Zip<std::slice::Iter<'a, String>, std::slice::Iter<'a, Value>>;
    fn into_iter(self) -> Self::IntoIter {
        self.schema.names.iter().zip(self.values.iter())
    }
}

impl Serialize for Row {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(self.len()))?;
        for (k, v) in self.iter() {
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

impl<'de> Deserialize<'de> for Row {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        // L'ordine delle chiavi del JSON diventa l'ordine dei campi.
        let m: indexmap_like::OrderedMap = Deserialize::deserialize(d)?;
        Ok(m.0.into_iter().collect())
    }
}

/// Mappa che conserva l'ordine delle chiavi in deserializzazione, senza
/// dipendenze in più (serde_json qui ha `preserve_order`, ma Row si
/// deserializza anche da altri formati).
mod indexmap_like {
    use super::Value;
    use serde::de::{MapAccess, Visitor};
    use serde::{Deserialize, Deserializer};

    pub struct OrderedMap(pub Vec<(String, Value)>);

    impl<'de> Deserialize<'de> for OrderedMap {
        fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
            struct V;
            impl<'de> Visitor<'de> for V {
                type Value = OrderedMap;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("una mappa campo → valore")
                }
                fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<OrderedMap, A::Error> {
                    let mut out = Vec::with_capacity(a.size_hint().unwrap_or(0));
                    while let Some((k, v)) = a.next_entry::<String, Value>()? {
                        out.push((k, v));
                    }
                    Ok(OrderedMap(out))
                }
            }
            d.deserialize_map(V)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(pairs: &[(&str, i64)]) -> Row {
        pairs.iter().map(|(k, v)| (k.to_string(), Value::Int(*v))).collect()
    }

    #[test]
    fn stessa_interfaccia_per_nome() {
        let mut a = r(&[("id", 1), ("qty", 2)]);
        assert_eq!(a.get("qty"), Some(&Value::Int(2)));
        assert_eq!(a.get("assente"), None);
        assert_eq!(a.insert("qty".into(), Value::Int(5)), Some(Value::Int(2)));
        a.set("nuovo".into(), Value::Null);
        assert_eq!(a.keys().cloned().collect::<Vec<_>>(), vec!["id", "qty", "nuovo"]);
        assert_eq!(a.remove("id"), Some(Value::Int(1)));
        assert_eq!(a.get("id"), None);
        assert_eq!(a.get("qty"), Some(&Value::Int(5)), "le posizioni si spostano, i nomi no");
        assert_eq!(a.len(), 2);
        a.set_if_absent("qty".into(), Value::Int(9));
        assert_eq!(a.get("qty"), Some(&Value::Int(5)));
    }

    #[test]
    fn righe_della_stessa_forma_condividono_lo_schema() {
        let a = r(&[("id", 1), ("qty", 2)]);
        let b = r(&[("id", 3), ("qty", 4)]);
        assert!(Arc::ptr_eq(a.schema(), b.schema()));
        let mut c = a.clone();
        c.set("x".into(), Value::Null);
        let mut d = b.clone();
        d.set("x".into(), Value::Null);
        assert!(Arc::ptr_eq(c.schema(), d.schema()), "stessa trasformazione → stesso schema derivato");
        assert!(!Arc::ptr_eq(a.schema(), c.schema()));
    }

    #[test]
    fn forme_diverse_restano_corrette() {
        // stesso nome in posizioni diverse: la lettura per nome non si confonde
        let a = r(&[("a", 1), ("b", 2)]);
        let b = r(&[("b", 20), ("a", 10)]);
        assert_eq!(a.get("a"), Some(&Value::Int(1)));
        assert_eq!(b.get("a"), Some(&Value::Int(10)));
        // molti campi: indice
        let many: Row = (0..40).map(|i| (format!("c{i}"), Value::Int(i))).collect();
        assert_eq!(many.get("c33"), Some(&Value::Int(33)));
        // forme molto variabili: oltre il tetto della cache, sempre corrette
        for i in 0..1000 {
            let mut x = Row::new();
            x.set(format!("k{i}"), Value::Int(i));
            assert_eq!(x.get(&format!("k{i}")), Some(&Value::Int(i)));
        }
    }

    #[test]
    fn serde_come_una_mappa() {
        let a = r(&[("z", 1), ("a", 2)]);
        let s = serde_json::to_string(&a).unwrap();
        let v = serde_json::to_string(&Value::Int(1)).unwrap();
        assert!(s.starts_with(&format!("{{\"z\":{v}")), "una mappa, nell'ordine dei campi: {s}");
        let b: Row = serde_json::from_str(&s).unwrap();
        assert_eq!(b.keys().cloned().collect::<Vec<_>>(), vec!["z", "a"]);
        assert_eq!(b.get("a"), Some(&Value::Int(2)));
    }
}
