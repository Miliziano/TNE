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

use crate::engine::types::Value;

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
}
