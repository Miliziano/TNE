// ─── src-tauri/src/engine/ordinamento.rs ──────────────────────────
//
// P398 — ORDER BY su più campi, ognuno con la sua direzione, per Aggregate e
// Window. Prima entrambi leggevano `orderBy` come UN nome di campo: il
// suggerimento del pannello "count DESC, region ASC" cercava un campo che si
// chiamava proprio così, non lo trovava e non ordinava niente, in silenzio.
//
// Sintassi (la scrive l'editor dello studio, src/components/OrderByEditor.tsx):
//   campo [ASC|DESC], campo [ASC|DESC], …
// Un campo senza direzione prende quella di `orderDir` (il vecchio menu
// della Window), altrimenti ASC. Un nome può contenere spazi
// ("conteggio dei movimenti DESC") e si può scrivere tra "…" o `…`.
//
// Confronto: numeri come numeri (Int e Decimal esatti), date e testo come
// testo; i null vanno in fondo in ASC e in testa in DESC (come prima).
// L'ordinamento è STABILE: a parità di chiavi resta l'ordine d'arrivo.

use std::cmp::Ordering;
use crate::engine::types::{Row, Value};

#[derive(Debug, Clone, PartialEq)]
pub struct Chiave {
    pub campo: String,
    pub desc:  bool,
}

/// Legge "a DESC, b, `c d` asc". `dir_predefinita`: "asc" | "desc".
pub fn chiavi(order_by: &str, dir_predefinita: &str) -> Vec<Chiave> {
    let pred_desc = dir_predefinita.trim().eq_ignore_ascii_case("desc");
    order_by.split(',').filter_map(|parte| {
        let p = parte.trim();
        if p.is_empty() { return None }
        let basso = p.to_ascii_lowercase();
        let (nome, desc) = if basso.ends_with(" desc") || basso.ends_with("\tdesc") {
            (&p[..p.len() - 4], true)
        } else if basso.ends_with(" asc") || basso.ends_with("\tasc") {
            (&p[..p.len() - 3], false)
        } else {
            (p, pred_desc)
        };
        let nome = nome.trim();
        let nome = ['"', '`', '\'']
            .iter()
            .find_map(|q| nome.strip_prefix(*q).and_then(|n| n.strip_suffix(*q)))
            .unwrap_or(nome);
        if nome.is_empty() { None } else { Some(Chiave { campo: nome.to_string(), desc }) }
    }).collect()
}

/// Confronto di due valori per l'ordinamento (null in fondo).
pub fn confronta(a: Option<&Value>, b: Option<&Value>) -> Ordering {
    let nullo = |v: Option<&Value>| matches!(v, None | Some(Value::Null));
    match (nullo(a), nullo(b)) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        _ => {}
    }
    let (x, y) = (a.unwrap(), b.unwrap());
    if let (Some(dx), Some(dy)) = (decimale(x), decimale(y)) {
        return dx.cmp(&dy);
    }
    match (x.as_f64_lossy(), y.as_f64_lossy()) {
        (Some(nx), Some(ny)) => nx.partial_cmp(&ny).unwrap_or(Ordering::Equal),
        _ => x.as_str_repr().cmp(&y.as_str_repr()),
    }
}

fn decimale(v: &Value) -> Option<rust_decimal::Decimal> {
    match v {
        Value::Int(i) => Some(rust_decimal::Decimal::from(*i)),
        Value::Decimal(d) => Some(*d),
        _ => None,
    }
}

/// Ordina le righe per le chiavi, in ordine. Stabile.
pub fn ordina(righe: &mut [Row], chiavi: &[Chiave]) {
    if chiavi.is_empty() { return }
    righe.sort_by(|a, b| {
        for k in chiavi {
            let o = confronta(a.get(&k.campo), b.get(&k.campo));
            let o = if k.desc { o.reverse() } else { o };
            if o != Ordering::Equal { return o }
        }
        Ordering::Equal
    });
}

/// Campi dell'ordinamento che non esistono nella prima riga: chi li ha scritti
/// male ordinerebbe per niente senza saperlo.
pub fn campi_assenti(righe: &[Row], chiavi: &[Chiave]) -> Vec<String> {
    let Some(prima) = righe.first() else { return Vec::new() };
    chiavi.iter().filter(|k| prima.get(&k.campo).is_none()).map(|k| k.campo.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn riga(r: &str, c: i64) -> Row {
        [("region".to_string(), Value::String(r.into())), ("count".to_string(), Value::Int(c))].into_iter().collect()
    }

    #[test]
    fn lettura() {
        assert_eq!(chiavi("count DESC, region ASC", "asc"), vec![
            Chiave { campo: "count".into(), desc: true }, Chiave { campo: "region".into(), desc: false }]);
        assert_eq!(chiavi("a, b desc", "desc"), vec![
            Chiave { campo: "a".into(), desc: true }, Chiave { campo: "b".into(), desc: true }]);
        assert_eq!(chiavi("conteggio dei movimenti desc, `x y`", "asc"), vec![
            Chiave { campo: "conteggio dei movimenti".into(), desc: true }, Chiave { campo: "x y".into(), desc: false }]);
        assert_eq!(chiavi("descrizione, ascissa", "asc")[0].campo, "descrizione", "desc/asc solo come parola finale");
        assert!(chiavi(" , ", "asc").is_empty());
    }

    #[test]
    fn piu_chiavi_e_stabile() {
        let mut r = vec![riga("N", 2), riga("S", 5), riga("C", 2), riga("A", 5)];
        ordina(&mut r, &chiavi("count DESC, region ASC", "asc"));
        let got: Vec<String> = r.iter().map(|x| x.get("region").unwrap().as_str_repr()).collect();
        assert_eq!(got, ["A", "S", "C", "N"]);
        // numeri come numeri, decimali esatti
        let d = |s: &str| Value::Decimal(s.parse().unwrap());
        assert_eq!(confronta(Some(&d("10.5")), Some(&Value::Int(9))), Ordering::Greater);
        assert_eq!(confronta(Some(&Value::Null), Some(&Value::Int(9))), Ordering::Greater);
        assert_eq!(campi_assenti(&r, &chiavi("count, conta", "asc")), vec!["conta".to_string()]);
    }
}
