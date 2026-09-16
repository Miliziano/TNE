// ─── src-tauri/src/signing/canonical.rs ───────────────────────────
// FORMA CANONICA DEL PIANO (gemello Rust di src/ir/canonicalPlan.ts).
// Deve produrre gli STESSI byte del lato TS: il test qui sotto lo
// verifica contro il vettore condiviso `vectors/canonical_plan_v1.json`.
//
// Regole (v1):
//   1) si toglie `run_id` alla RADICE (unico campo volatile del piano);
//   2) chiavi degli oggetti ordinate ricorsivamente (ASCII → byte order
//      = code point = ordine JS/UTF-16 per identificatori ASCII);
//   3) ordine degli array PRESERVATO;
//   4) JSON compatto, UTF-8.
// Numeri: v1 assume interi/stringhe/bool/null (niente float) → identici
// tra serde_json e JS. I float sono sconsigliati finché non si fissa una
// regola numerica condivisa (JCS/RFC 8785).

use serde_json::Value;
use sha2::{Digest, Sha256};

/// Serializzazione canonica di un qualsiasi valore JSON (chiavi ordinate,
/// ordine degli array preservato, compatto). Usata sia per il piano (senza
/// `run_id`) sia per il MANIFESTO firmato (che si canonicalizza tale e quale).
pub fn canonical_value(v: &Value) -> String {
    let mut s = String::new();
    write_value(v, &mut s);
    s
}

/// Stringa canonica del piano, senza `run_id`.
pub fn canonical_plan_string(plan: &Value) -> String {
    match plan {
        Value::Object(map) => {
            let mut m = map.clone();
            m.remove("run_id");
            canonical_value(&Value::Object(m))
        }
        other => canonical_value(other),
    }
}

fn write_value(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        // serde_json::to_string su una stringa produce l'escape JSON
        // (identico a JSON.stringify per i nostri dati: non-ASCII grezzo,
        // controlli come \n/\t/\u00xx, '/' non escapato).
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap()),
        Value::Array(a) => {
            out.push('[');
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort(); // deterministico anche se serde_json ha preserve_order
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap());
                out.push(':');
                write_value(&map[*k], out);
            }
            out.push('}');
        }
    }
}

/// planHash = "sha256:" + hex(sha256(byte canonici del piano)).
pub fn plan_hash(plan: &Value) -> String {
    let mut h = Sha256::new();
    h.update(canonical_plan_string(plan).as_bytes());
    format!("sha256:{:x}", h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vector() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors/canonical_plan_v1.json");
        let raw = std::fs::read_to_string(path).expect("vettore condiviso mancante");
        serde_json::from_str(&raw).expect("vettore condiviso non valido")
    }

    #[test]
    fn canonicale_coincide_col_vettore() {
        let v = vector();
        assert_eq!(canonical_plan_string(&v["plan"]), v["canonical"].as_str().unwrap());
    }

    #[test]
    fn plan_hash_coincide_col_vettore() {
        let v = vector();
        assert_eq!(plan_hash(&v["plan"]), v["sha256"].as_str().unwrap());
    }

    #[test]
    fn run_id_non_influisce() {
        let v = vector();
        let mut p = v["plan"].clone();
        p["run_id"] = Value::from("export-999");
        assert_eq!(plan_hash(&p), v["sha256"].as_str().unwrap());
    }
}
