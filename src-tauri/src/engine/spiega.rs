// ─── src-tauri/src/engine/spiega.rs ───────────────────────────────
// "Spiega questo valore" (P391): il calcolo di un'espressione FPEL su una
// riga, pezzo per pezzo.
//
// Il risultato ha la STESSA forma dell'albero dell'espressione: per ogni nodo
// il valore calcolato (`v`) e i figli nello stesso ordine dell'albero (`c`);
// un figlio che non è stato valutato (il ramo di un `case` dopo quello scelto,
// gli argomenti di `coalesce` dopo il primo non nullo, il corpo di una
// funzione `x -> …`) è `null`. Lo studio mette accanto a ogni pezzo il testo
// dell'espressione (lo ricava dallo stesso albero) e mostra il calcolo.
//
// A calcolare è l'INTERPRETE del motore (`expr::eval`), che dà lo stesso
// risultato dell'espressione compilata usata nei run (lo verificano il test
// di equivalenza di `compiled.rs` e il contratto `tests/fpel_vettori.rs`).
// Serve allo studio, mai ai run: il costo (ogni pezzo si valuta di nuovo) non
// conta.

use serde_json::{json, Value as J};
use crate::engine::expr::{as_lambda, eval, is_hof, is_truthy, EvalContext, ExprNode};
use crate::engine::types::Value;

/// Calcolo di `e` sulla riga di `ctx`, pezzo per pezzo (v. testa del file).
pub fn spiega(e: &ExprNode, ctx: &EvalContext) -> J {
    let v = eval(e, ctx);
    let figli: Vec<J> = match e {
        ExprNode::Literal { .. } | ExprNode::FieldRef { .. } | ExprNode::DirectFieldRef { .. } => vec![],
        ExprNode::BinaryOp { left, right, .. } => vec![spiega(left, ctx), spiega(right, ctx)],
        ExprNode::UnaryOp { expr, .. }
        | ExprNode::Cast { expr, .. }
        | ExprNode::FieldAccess { expr, .. }
        | ExprNode::IsNull { expr }
        | ExprNode::IsNotNull { expr } => vec![spiega(expr, ctx)],
        ExprNode::FunctionCall { name, args } => {
            if name == "lambda" || name == "lambda_arg" {
                // la funzione `x -> …` e il suo parametro: niente da scomporre
                vec![]
            } else if is_hof(name) && args.get(1).and_then(as_lambda).is_some() {
                // l'elenco sì, il corpo no (si applica a ogni elemento)
                let mut c = vec![spiega(&args[0], ctx), J::Null];
                c.extend(args.iter().skip(2).map(|a| spiega(a, ctx)));
                c
            } else if name == "decode_map" {
                // la chiave e il ripiego; la tabella è una costante lunga
                let mut c = vec![args.first().map(|a| spiega(a, ctx)).unwrap_or(J::Null), J::Null];
                c.extend(args.iter().skip(2).map(|a| spiega(a, ctx)));
                c
            } else {
                args.iter().map(|a| spiega(a, ctx)).collect()
            }
        }
        ExprNode::CaseWhen { branches, default } => {
            // [cond1, valore1, cond2, valore2, …, default]: solo ciò che il
            // motore valuta davvero, fino al primo ramo vero.
            let mut c = Vec::new();
            let mut scelto = false;
            for b in branches {
                if scelto { c.push(J::Null); c.push(J::Null); continue }
                let cond = spiega(&b.condition, ctx);
                let vera = is_truthy(&eval(&b.condition, ctx));
                c.push(cond);
                if vera { c.push(spiega(&b.value, ctx)); scelto = true } else { c.push(J::Null) }
            }
            if default.is_some() {
                c.push(match (scelto, default) {
                    (false, Some(d)) => spiega(d, ctx),
                    _ => J::Null,
                });
            }
            c
        }
        ExprNode::Coalesce { args } => {
            let mut c = Vec::new();
            let mut trovato = false;
            for a in args {
                if trovato { c.push(J::Null); continue }
                c.push(spiega(a, ctx));
                trovato = !matches!(eval(a, ctx), Value::Null);
            }
            c
        }
    };
    json!({ "v": v.to_json(), "c": figli })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::types::Row;
    use std::collections::HashMap;

    fn albero(j: J) -> ExprNode { serde_json::from_value(j).unwrap() }

    #[test]
    fn stessa_forma_dell_albero_e_rami_non_valutati() {
        let row: Row = [("qta".to_string(), Value::Int(3)), ("prezzo".to_string(), Value::Int(4))].into_iter().collect();
        let vars = HashMap::new();
        let ctx = EvalContext::single(&row, &vars);
        let f = |n: &str| json!({"kind": "DirectFieldRef", "field": n});
        // case when qta > 2 then qta * prezzo else 0 end
        let e = albero(json!({"kind": "CaseWhen", "branches": [
            {"condition": {"kind": "BinaryOp", "op": "GT", "left": f("qta"), "right": {"kind": "Literal", "value": 2}},
             "value": {"kind": "BinaryOp", "op": "MUL", "left": f("qta"), "right": f("prezzo")}}],
            "default": {"kind": "Literal", "value": 0}}));
        let s = spiega(&e, &ctx);
        assert_eq!(s["v"], json!(12));
        assert_eq!(s["c"][0]["v"], json!(true));
        assert_eq!(s["c"][1]["c"][1]["v"], json!(4));
        assert_eq!(s["c"][2], J::Null, "il default non è stato valutato");
        // coalesce: dopo il primo non nullo, niente
        let c = albero(json!({"kind": "Coalesce", "args": [f("manca"), f("qta"), f("prezzo")]}));
        let s = spiega(&c, &ctx);
        assert_eq!(s["v"], json!(3));
        assert_eq!(s["c"][0]["v"], J::Null);
        assert_eq!(s["c"][2], J::Null);
    }

    /// Il comando che usa lo studio: albero e righe in JSON, calcolo in JSON.
    #[tokio::test]
    async fn comando_fpel_explain() {
        let expr = r#"{"kind":"BinaryOp","op":"MUL","left":{"kind":"FieldRef","input":"row","field":"q"},"right":{"kind":"Literal","value":2}}"#;
        let out = crate::engine::fpel_explain(expr.into(), r#"{"row":{"q":21}}"#.into(), None, None).await.unwrap();
        let j: J = serde_json::from_str(&out).unwrap();
        assert_eq!(j["v"], json!(42));
        assert_eq!(j["c"][0]["v"], json!(21));
        assert!(crate::engine::fpel_explain("{".into(), "{}".into(), None, None).await.is_err());
        assert!(crate::engine::fpel_explain(expr.into(), r#"{"row": 3}"#.into(), None, None).await.is_err());
    }
}
