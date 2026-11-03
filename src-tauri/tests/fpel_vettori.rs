// ─── tests/fpel_vettori.rs ────────────────────────────────────────
// Contratto FPEL studio↔motore (P389), metà del MOTORE.
//
// `vectors/fpel_v1.json`: per ogni caso l'albero che lo studio ricava
// dall'espressione (verificato da `src/ir/fpelVector.test.ts`), una riga e il
// risultato atteso. Qui l'albero si valuta in DUE modi — l'interprete
// (`expr::eval`) e l'espressione compilata (`Compiled`) — e tutti e due devono
// dare il risultato atteso; dal P391 anche la spiegazione pezzo per pezzo. Così un'espressione scritta nello studio fa nel
// motore ciò che il manuale promette, qualunque nodo la esegua.
//
//   cargo test --no-default-features --test fpel_vettori

use app_lib::engine::compiled::Compiled;
use app_lib::engine::expr::{eval, EvalContext, ExprNode};
use app_lib::engine::types::{Row, Value};
use std::collections::HashMap;

#[test]
fn contratto_fpel_studio_motore() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../vectors/fpel_v1.json");
    let vettore: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let casi = vettore["casi"].as_array().expect("casi");
    assert!(!casi.is_empty());
    let vars: HashMap<String, Value> = HashMap::new();
    let mut errori = Vec::new();

    for c in casi {
        let expr = c["expr"].as_str().unwrap();
        let ir: ExprNode = match serde_json::from_value(c["ir"].clone()) {
            Ok(n) => n,
            Err(e) => { errori.push(format!("{expr}: albero non leggibile dal motore: {e}")); continue }
        };
        let row = Row::from_json_object(c["row"].as_object().cloned().unwrap_or_default());
        let ctx = EvalContext::single(&row, &vars);
        let atteso = &c["expect"];

        let interprete = eval(&ir, &ctx).to_json();
        let compilato = Compiled::new(&ir).eval(&ctx).to_json();
        if &interprete != atteso {
            errori.push(format!("{expr}: interprete {interprete}, atteso {atteso}"));
        }
        if &compilato != atteso {
            errori.push(format!("{expr}: compilato {compilato}, atteso {atteso}"));
        }
        // P391: "spiega questo valore" deve arrivare allo stesso risultato.
        let spiegato = app_lib::engine::spiega::spiega(&ir, &ctx);
        if &spiegato["v"] != atteso {
            errori.push(format!("{expr}: spiegazione {}, atteso {atteso}", spiegato["v"]));
        }
    }
    assert!(errori.is_empty(), "{} casi su {} non tornano:\n{}", errori.len(), casi.len(), errori.join("\n"));
}
