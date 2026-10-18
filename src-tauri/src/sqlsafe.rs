// ─── src-tauri/src/sqlsafe.rs ─────────────────────────────────────
// SQL dinamico sotto sqlx 0.9 (P338).
//
// sqlx 0.9 accetta come SQL solo stringhe `&'static str` oppure stringhe
// dichiarate "verificate" con `AssertSqlSafe`. Qui c'e' l'UNICO posto dove il
// motore fa quella dichiarazione, con due nomi che dicono PERCHE' l'SQL e' sicuro:
//
//  - `autore(..)`  SQL scritto dall'AUTORE DEL PIANO: la query di source_db, il
//                  pre/post SQL, le funzioni di colonna, la DDL del mapping. Il
//                  piano e' firmato e verificato prima dell'esecuzione (P318/P333)
//                  e chi lo scrive puo' gia', per progetto, eseguire SQL
//                  arbitrario: non e' un dato in ingresso.
//  - `composto(..)` SQL composto dal motore in cui gli IDENTIFICATORI sono stati
//                  validati qui sotto e i VALORI viaggiano come parametri legati.
//
// 🐞 Chiuso (P338): senza mapping delle colonne, `sink_db` usa come nomi di colonna
// le CHIAVI DELLE RIGHE — cioe' i dati (l'intestazione di un CSV, le chiavi di un
// JSON). In PostgreSQL e SQLite finivano nell'SQL senza virgolette, in MySQL tra
// backtick senza escape: un'intestazione costruita apposta poteva iniettare SQL.
// Ora ogni nome di tabella/colonna/chiave passa da `check_*` prima di entrare
// nell'SQL. Le regole NON cambiano la semantica dei nomi validi:
//  - PostgreSQL/SQLite: identificatore semplice (lettera o `_`, poi lettere,
//    cifre, `_`, `$`; lettere accentate ammesse) oppure gia' tra virgolette
//    doppie con le virgolette interne raddoppiate. I nomi con spazi o simboli non
//    funzionavano neanche prima (SQL non valido): ora l'errore e' esplicito.
//  - MySQL: i nomi vanno gia' tra backtick, quindi sono ammessi spazi e simboli;
//    vietati solo backtick e carattere NUL (gli unici che escono dal backtick).

use sqlx::AssertSqlSafe;

/// SQL scritto dall'autore del piano (firmato). Vedi l'intestazione del modulo.
pub(crate) fn autore(sql: impl Into<String>) -> AssertSqlSafe<String> {
    AssertSqlSafe(sql.into())
}

/// SQL composto dal motore: identificatori validati con `check_*`, valori legati.
pub(crate) fn composto(sql: impl Into<String>) -> AssertSqlSafe<String> {
    AssertSqlSafe(sql.into())
}

/// Letterale stringa SQL tra apici singoli (apici interni raddoppiati).
pub(crate) fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn is_mysql(dialect: &str) -> bool {
    dialect == "mysql"
}

/// Identificatore semplice o gia' quotato con virgolette doppie (PG/SQLite).
fn plain_or_quoted(name: &str) -> bool {
    if name.len() >= 2 && name.starts_with('"') && name.ends_with('"') {
        let inner = &name[1..name.len() - 1];
        // dentro le virgolette ogni `"` deve essere raddoppiata
        return !inner.is_empty() && !inner.contains('\0') && inner.replace("\"\"", "").find('"').is_none();
    }
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

/// Nome di colonna (o di chiave) che finira' nell'SQL.
pub(crate) fn check_ident(name: &str, dialect: &str) -> Result<(), String> {
    let ok = if is_mysql(dialect) {
        !name.is_empty() && !name.contains('`') && !name.contains('\0')
    } else {
        plain_or_quoted(name)
    };
    if ok {
        Ok(())
    } else {
        Err(format!(
            "invalid column/key name {:?}: use letters, digits and _ (or map the field to a valid column in the sink mapping)",
            name
        ))
    }
}

/// Nome di tabella, eventualmente qualificato `schema.tabella`.
pub(crate) fn check_table(qualified: &str, dialect: &str) -> Result<(), String> {
    let ok = if is_mysql(dialect) {
        !qualified.is_empty() && !qualified.contains('`') && !qualified.contains('\0')
    } else {
        // al piu' schema.tabella; le parti si validano singolarmente
        let parts = split_qualified(qualified);
        !parts.is_empty() && parts.len() <= 2 && parts.iter().all(|p| plain_or_quoted(p))
    };
    if ok { Ok(()) } else { Err(format!("invalid table name {:?}", qualified)) }
}

/// Divide `schema.tabella` sul punto, rispettando i nomi tra virgolette.
fn split_qualified(s: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    for c in s.chars() {
        match c {
            '"' => { in_q = !in_q; cur.push(c); }
            '.' if !in_q => { parts.push(std::mem::take(&mut cur)); }
            _ => cur.push(c),
        }
    }
    parts.push(cur);
    parts
}

/// Valida i nomi di colonna di una riga (le chiavi vengono dai DATI).
pub(crate) fn check_fields(fields: &[(String, serde_json::Value)], dialect: &str) -> Result<(), String> {
    for (name, _) in fields {
        check_ident(name, dialect)?;
    }
    Ok(())
}

/// Valida in un colpo tabella, chiavi, colonne elencate e colonna RETURNING.
pub(crate) fn check_names(
    table: &str,
    keys: &[String],
    columns: Option<&[String]>,
    returning: Option<&str>,
    dialect: &str,
) -> Result<(), String> {
    check_table(table, dialect)?;
    for k in keys {
        check_ident(k, dialect)?;
    }
    for c in columns.unwrap_or(&[]) {
        check_ident(c, dialect)?;
    }
    if let Some(r) = returning {
        check_ident(r, dialect)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nomi_validi_invariati() {
        for d in ["postgresql", "sqlite"] {
            for n in ["id", "nome_cliente", "_x", "città", "Col1", "a$b", "\"MiaColonna\"", "\"con \"\"virgolette\"\"\""] {
                assert!(check_ident(n, d).is_ok(), "{d}: {n}");
            }
            for t in ["clienti", "public.clienti", "\"Schema\".\"Tabella\""] {
                assert!(check_table(t, d).is_ok(), "{d}: {t}");
            }
        }
        for n in ["id", "First Name", "prezzo (€)", "città"] {
            assert!(check_ident(n, "mysql").is_ok(), "mysql: {n}");
        }
    }

    #[test]
    fn iniezioni_rifiutate() {
        let cattivi = [
            "id) VALUES (1); DROP TABLE utenti; --",
            "a; DELETE FROM t",
            "x\" OR 1=1 --",
            "1abc",
            "",
            "\"aperta",
            "\"un \" solo\"",
            "nome con spazi",
        ];
        for d in ["postgresql", "sqlite"] {
            for n in cattivi {
                assert!(check_ident(n, d).is_err(), "{d} doveva rifiutare {n:?}");
            }
        }
        for n in ["a`; DROP TABLE t; --", "", "x\0y"] {
            assert!(check_ident(n, "mysql").is_err(), "mysql doveva rifiutare {n:?}");
        }
        assert!(check_table("a.b.c", "postgresql").is_err());
        assert!(check_table("t; DROP TABLE x", "postgresql").is_err());
        assert!(check_table("t`x", "mysql").is_err());
    }

    #[test]
    fn letterale() {
        assert_eq!(literal("fp_1"), "'fp_1'");
        assert_eq!(literal("o'reilly"), "'o''reilly'");
    }
}
