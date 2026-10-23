// ─── src-tauri/src/engine/field_mapping.rs ──────────────────────────
//
// Regole comuni dei pannelli di mapping dei campi (tipo + trasformazione):
// source_file (P357) ed explode (P360). Una sola implementazione, così lo
// stesso tipo dichiarato nello studio produce lo stesso valore ovunque.
//
// TRASFORMAZIONI del testo: trim | uppercase | lowercase | nullify_empty.
// Legacy (vecchi pannelli): to_int, to_float, to_date, to_bool, to_string
// valgono come il tipo corrispondente.
//
// TIPI (src/types/fieldTypes.ts): string, integer, decimal, number,
// boolean, date, datetime, object, any.

use std::collections::HashMap;
use crate::engine::types::{Row, Value};

/// Applica una trasformazione al testo. None = il valore diventa null.
pub fn transform_text(s: &str, t: &str) -> Option<String> {
    match t {
        "trim"          => Some(s.trim().to_string()),
        "uppercase"     => Some(s.to_uppercase()),
        "lowercase"     => Some(s.to_lowercase()),
        "nullify_empty" => if s.trim().is_empty() { None } else { Some(s.to_string()) },
        _               => Some(s.to_string()),
    }
}

/// Le trasformazioni-conversione (legacy) valgono come tipo.
pub fn effective_type<'a>(ty: &'a str, transform: &str) -> &'a str {
    match transform {
        "to_int" | "to_integer"   => "integer",
        "to_float" | "to_decimal" => "decimal",
        "to_date"                 => "date",
        "to_bool" | "to_boolean"  => "boolean",
        "to_string"               => "string",
        _ => ty,
    }
}

/// true se la trasformazione cambia il testo (le legacy to_* no: sono tipi).
pub fn is_text_transform(t: &str) -> bool {
    matches!(t, "trim" | "uppercase" | "lowercase" | "nullify_empty")
}

/// Il valore è già del tipo dichiarato? (`any` e il tipo vuoto: sempre.)
pub fn matches_type(v: &Value, ty: &str) -> bool {
    match (ty, v) {
        ("" | "any", _)                                   => true,
        (_, Value::Null)                                  => true,
        ("string", Value::String(_))                      => true,
        ("integer", Value::Int(_))                        => true,
        ("decimal", Value::Decimal(_))                    => true,
        ("number", Value::Int(_) | Value::Float(_) | Value::Decimal(_)) => true,
        ("boolean", Value::Bool(_))                       => true,
        ("date", Value::Date(_))                          => true,
        ("datetime", Value::DateTime(_))                  => true,
        ("object", Value::Object(_))                      => true,
        _ => false,
    }
}

/// Testo → valore del tipo dichiarato. Testo vuoto → Some(Null).
/// None = il testo non è convertibile in quel tipo.
pub fn try_coerce(raw: &str, ty: &str) -> Option<Value> {
    let t = raw.trim();
    if t.is_empty() { return Some(Value::Null) }

    match ty {
        "integer" => t.parse::<i64>().ok().map(Value::Int),
        "float"   => t.parse::<f64>().ok().map(Value::Float),
        "decimal" => t.parse::<rust_decimal::Decimal>().ok().map(Value::Decimal),
        // `number` (alias del TMap): intero se lo è, altrimenti virgola mobile.
        "number"  => t.parse::<i64>().map(Value::Int).ok()
                      .or_else(|| t.parse::<f64>().ok().map(Value::Float)),
        "boolean" => match t.to_lowercase().as_str() {
            "true"  | "1" | "si" | "sì" | "yes" | "y" | "t" => Some(Value::Bool(true)),
            "false" | "0" | "no" | "n"  | "f"               => Some(Value::Bool(false)),
            _ => None,
        },
        "date" | "datetime" => Some(Value::String(t.to_string())),  // il motore parsa on-demand
        "object" => Some(serde_json::from_str::<serde_json::Value>(t)
            .map(Value::Object).unwrap_or(Value::String(t.to_string()))),
        _ => Some(Value::String(t.to_string())),   // string, any, sconosciuto
    }
}

/// Come `try_coerce`, ma un testo non convertibile diventa null.
pub fn coerce(raw: &str, ty: &str) -> Value {
    try_coerce(raw, ty).unwrap_or(Value::Null)
}

// ─── Mapping dei campi (explode P360, sink_file P361) ──────────────
//
// [{ sourceField, outputName, type, transform, include }] come lo salvano
// i pannelli. Escono SOLO i campi inclusi, col nome logico, trasformati e
// convertiti al tipo. Un valore non convertibile resta com'è e si conta:
// chi chiama lo dice nel log (`warnings`), invece di un null silenzioso.

#[derive(serde::Deserialize, Clone, Debug)]
pub struct MapField {
    #[serde(default, rename = "sourceField")]
    pub source:    String,
    #[serde(default, rename = "outputName")]
    pub name:      String,
    #[serde(default, rename = "type")]
    pub ty:        String,
    #[serde(default)]
    pub transform: String,
    #[serde(default = "si")]
    pub include:   bool,
}

fn si() -> bool { true }

impl MapField {
    /// Campo letto: `sourceField`, o il nome logico per i campi aggiunti a mano.
    pub fn key(&self) -> &str { if self.source.is_empty() { &self.name } else { &self.source } }
    /// Nome in uscita: il nome logico, o il campo letto se è vuoto.
    pub fn out(&self) -> &str { if self.name.is_empty() { &self.source } else { &self.name } }
}

/// I campi inclusi del mapping. Vuoto = nessun mapping (tutti i campi).
#[derive(Default)]
pub struct FieldMapping {
    pub fields: Vec<MapField>,
    /// campo d'uscita → (valori non convertibili, tipo voluto)
    failed: HashMap<String, (u64, String)>,
}

impl FieldMapping {
    pub fn parse(raw: &str) -> Result<FieldMapping, String> {
        if raw.trim().is_empty() { return Ok(FieldMapping::default()) }
        let all: Vec<MapField> = serde_json::from_str(raw)
            .map_err(|e| format!("invalid field mapping: {}", e))?;
        Ok(FieldMapping {
            fields: all.into_iter().filter(|f| f.include && !f.key().is_empty()).collect(),
            failed: HashMap::new(),
        })
    }

    pub fn is_empty(&self) -> bool { self.fields.is_empty() }

    /// I nomi d'uscita, nell'ordine del mapping.
    pub fn columns(&self) -> Vec<String> { self.fields.iter().map(|f| f.out().to_string()).collect() }

    /// Riga → riga d'uscita (senza mapping: invariata).
    pub fn apply(&mut self, row: Row) -> Row {
        if self.fields.is_empty() { return row }
        let mut out = Row::new();
        for i in 0..self.fields.len() {
            let v = match row.get(self.fields[i].key()) {
                None | Some(Value::Null) => Value::Null,
                Some(v) => self.map_value(v, i),
            };
            out.set(self.fields[i].out().to_string(), v);
        }
        out
    }

    fn map_value(&mut self, v: &Value, i: usize) -> Value {
        let f = &self.fields[i];
        let ty = effective_type(&f.ty, &f.transform);
        let text_t = is_text_transform(&f.transform);
        // Già del tipo giusto e niente da trasformare: resta com'è.
        if !text_t && matches_type(v, ty) { return v.clone() }

        let Some(text) = transform_text(&v.as_str_repr(), &f.transform) else { return Value::Null };
        let target = if ty.is_empty() || ty == "any" { "string" } else { ty };
        match try_coerce(&text, target) {
            Some(x) => x,
            None => {
                let e = self.failed.entry(f.out().to_string()).or_insert((0, target.to_string()));
                e.0 += 1;
                if text_t { Value::String(text) } else { v.clone() }
            }
        }
    }

    /// Un messaggio per campo con valori non convertibili, in ordine di nome.
    pub fn warnings(&self) -> Vec<String> {
        let mut keys: Vec<&String> = self.failed.keys().collect();
        keys.sort();
        keys.into_iter().map(|k| {
            let (n, ty) = &self.failed[k];
            format!("field '{}': {} value(s) could not be converted to {} and were kept as they are", k, n, ty)
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversioni() {
        assert_eq!(coerce(" 12 ", "integer"), Value::Int(12));
        assert_eq!(coerce("12", "number"), Value::Int(12));
        assert_eq!(coerce("1.5", "number"), Value::Float(1.5));
        assert_eq!(coerce("sì", "boolean"), Value::Bool(true));
        assert_eq!(coerce("", "integer"), Value::Null);
        assert_eq!(try_coerce("abc", "integer"), None);
        assert_eq!(coerce("abc", "integer"), Value::Null);
        assert_eq!(effective_type("string", "to_int"), "integer");
        assert_eq!(effective_type("decimal", ""), "decimal");
        assert!(matches_type(&Value::Float(1.0), "number"));
        assert!(!matches_type(&Value::String("1".into()), "integer"));
        assert_eq!(transform_text("  ", "nullify_empty"), None);
        assert_eq!(transform_text(" a ", "trim").as_deref(), Some("a"));
    }

    fn riga(campi: &[(&str, Value)]) -> Row {
        let mut r = Row::new();
        for (k, v) in campi { r.set(k.to_string(), v.clone()) }
        r
    }

    #[test]
    fn mapping_seleziona_rinomina_converte() {
        let mut m = FieldMapping::parse(r#"[
            {"sourceField":"id","outputName":"codice","type":"integer","transform":"","include":true},
            {"sourceField":"nome","outputName":"nome","type":"string","transform":"uppercase","include":true},
            {"sourceField":"note","outputName":"note","type":"string","transform":"","include":false},
            {"sourceField":"","outputName":"extra","type":"string","transform":"","include":true},
            {"sourceField":"qta","outputName":"qta","type":"integer","transform":"","include":true}
        ]"#).unwrap();
        assert_eq!(m.columns(), vec!["codice", "nome", "extra", "qta"]);
        let out = m.apply(riga(&[
            ("id", Value::String("7".into())),
            ("nome", Value::String("ada".into())),
            ("note", Value::String("x".into())),
            ("qta", Value::String("tre".into())),
        ]));
        assert_eq!(out.fields().count(), 4);
        assert_eq!(out.get("codice"), Some(&Value::Int(7)));
        assert_eq!(out.get("nome"), Some(&Value::String("ADA".into())));
        assert_eq!(out.get("extra"), Some(&Value::Null));
        // non convertibile: resta com'è e si conta
        assert_eq!(out.get("qta"), Some(&Value::String("tre".into())));
        assert_eq!(m.warnings().len(), 1);
        assert!(m.warnings()[0].starts_with("field 'qta': 1 value(s)"));
    }

    #[test]
    fn mapping_vuoto_lascia_tutto() {
        let mut m = FieldMapping::parse("").unwrap();
        assert!(m.is_empty());
        let out = m.apply(riga(&[("a", Value::Int(1))]));
        assert_eq!(out.get("a"), Some(&Value::Int(1)));
        assert_eq!(out.fields().count(), 1);
        assert!(FieldMapping::parse("{non json").is_err());
    }
}
