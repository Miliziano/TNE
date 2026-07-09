// ─── src-tauri/src/engine/expr_functions.rs ────────────────────────
//
// Funzioni FPEL aggiuntive: date, stringhe, numeri, encoding, hash.
// Complemento di `eval_function` in expr.rs (che resta per le funzioni
// storiche). Chiamato da eval_function come fallback.
//
// CONTRATTO (docs/design-linguaggio-espressioni.md):
//  - funzioni PURE: stessi argomenti → stesso risultato
//  - argomento non valido → Value::Null, mai panic
//  - i nomi qui sono i CANONICI (snake_case); gli alias camelCase sono
//    normalizzati dal parser nello studio (src/ir/functions.ts)

use chrono::{NaiveDate, NaiveDateTime, Datelike, Timelike, Duration, Local};
use crate::engine::types::Value;

// ─── Helper di conversione ─────────────────────────────────────────

fn s(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.as_str_repr(),
    }
}

fn i(v: Option<&Value>) -> Option<i64> {
    match v {
        Some(Value::Int(x))   => Some(*x),
        Some(Value::Float(f)) => Some(*f as i64),
        Some(Value::String(x)) => x.trim().parse().ok(),
        _ => None,
    }
}

fn f(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Int(x))   => Some(*x as f64),
        Some(Value::Float(x)) => Some(*x),
        Some(Value::Decimal(d)) => { use rust_decimal::prelude::ToPrimitive; d.to_f64() }
        Some(Value::String(x)) => x.trim().parse().ok(),
        _ => None,
    }
}

/// Parsing data tollerante: accetta i formati che il motore produce e
/// quelli comuni in input. Restituisce sempre un NaiveDateTime (le date
/// pure hanno ora 00:00:00).
pub fn parse_datetime(txt: &str) -> Option<NaiveDateTime> {
    let t = txt.trim();
    if t.is_empty() { return None }
    const DT: &[&str] = &[
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%d/%m/%Y %H:%M:%S",
    ];
    for fmt in DT {
        if let Ok(d) = NaiveDateTime::parse_from_str(t, fmt) { return Some(d) }
    }
    const D: &[&str] = &["%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%Y/%m/%d"];
    for fmt in D {
        if let Ok(d) = NaiveDate::parse_from_str(t, fmt) {
            return d.and_hms_opt(0, 0, 0)
        }
    }
    None
}

fn date_arg(v: Option<&Value>) -> Option<NaiveDateTime> {
    match v {
        Some(Value::Date(x)) | Some(Value::DateTime(x)) | Some(Value::String(x)) => parse_datetime(x),
        _ => None,
    }
}

fn date_out(d: NaiveDateTime) -> Value { Value::Date(d.date().to_string()) }

// ─── Dispatch ──────────────────────────────────────────────────────
//
// Ritorna None se la funzione non appartiene a questo modulo (così
// eval_function può proseguire col suo match storico).

pub fn eval_extra(name: &str, args: &[Value]) -> Option<Value> {
    let a0 = args.first();
    let a1 = args.get(1);
    let a2 = args.get(2);

    let out = match name {
        // ── Date: componenti ─────────────────────────────────────
        "quarter" => match date_arg(a0) {
            Some(d) => Value::Int(((d.month() - 1) / 3 + 1) as i64),
            None => Value::Null,
        },
        "day_of_week" => match date_arg(a0) {
            // 0 = domenica, come JS getDay()
            Some(d) => Value::Int(d.weekday().num_days_from_sunday() as i64),
            None => Value::Null,
        },
        "is_weekend" => match date_arg(a0) {
            Some(d) => Value::Bool(matches!(d.weekday().num_days_from_sunday(), 0 | 6)),
            None => Value::Null,
        },

        // ── Date: aritmetica ─────────────────────────────────────
        "add_days" => match (date_arg(a0), i(a1)) {
            (Some(d), Some(n)) => date_out(d + Duration::days(n)),
            _ => Value::Null,
        },
        "add_months" => match (date_arg(a0), i(a1)) {
            (Some(d), Some(n)) => match add_months_impl(d, n) {
                Some(x) => date_out(x), None => Value::Null,
            },
            _ => Value::Null,
        },
        "add_years" => match (date_arg(a0), i(a1)) {
            (Some(d), Some(n)) => match add_months_impl(d, n * 12) {
                Some(x) => date_out(x), None => Value::Null,
            },
            _ => Value::Null,
        },
        "diff_days" => match (date_arg(a0), date_arg(a1)) {
            (Some(a), Some(b)) => Value::Int((b.date() - a.date()).num_days()),
            _ => Value::Null,
        },

        // ── Date: confini di periodo ─────────────────────────────
        "start_of_month" => match date_arg(a0) {
            Some(d) => match d.date().with_day(1) { Some(x) => Value::Date(x.to_string()), None => Value::Null },
            None => Value::Null,
        },
        "end_of_month" => match date_arg(a0) {
            Some(d) => match end_of_month_impl(d) { Some(x) => Value::Date(x.to_string()), None => Value::Null },
            None => Value::Null,
        },
        "start_of_year" => match date_arg(a0) {
            Some(d) => match NaiveDate::from_ymd_opt(d.year(), 1, 1) { Some(x) => Value::Date(x.to_string()), None => Value::Null },
            None => Value::Null,
        },

        // ── Date: confronto ──────────────────────────────────────
        "is_before" => match (date_arg(a0), date_arg(a1)) {
            (Some(a), Some(b)) => Value::Bool(a < b), _ => Value::Null,
        },
        "is_after" => match (date_arg(a0), date_arg(a1)) {
            (Some(a), Some(b)) => Value::Bool(a > b), _ => Value::Null,
        },

        // ── Date: conversione ────────────────────────────────────
        "to_unix_timestamp" => match date_arg(a0) {
            Some(d) => Value::Int(d.and_utc().timestamp()), None => Value::Null,
        },
        "to_unix_timestamp_ms" => match date_arg(a0) {
            Some(d) => Value::Int(d.and_utc().timestamp_millis()), None => Value::Null,
        },
        "parse_date" => {
            // parse_date(testo, formato) → data
            let txt = s(a0);
            let fmt = s(a1);
            if fmt.is_empty() {
                match parse_datetime(&txt) { Some(d) => date_out(d), None => Value::Null }
            } else {
                match NaiveDate::parse_from_str(&txt, &fmt) {
                    Ok(d) => Value::Date(d.to_string()),
                    Err(_) => match NaiveDateTime::parse_from_str(&txt, &fmt) {
                        Ok(d) => Value::DateTime(d.to_string()),
                        Err(_) => Value::Null,
                    }
                }
            }
        }

        // ── Numeri ───────────────────────────────────────────────
        "sign" => match f(a0) {
            Some(x) => Value::Int(if x > 0.0 { 1 } else if x < 0.0 { -1 } else { 0 }),
            None => Value::Null,
        },
        "negate" => match f(a0) {
            Some(x) => Value::Float(-x), None => Value::Null,
        },
        "clamp" => match (f(a0), f(a1), f(a2)) {
            (Some(x), Some(lo), Some(hi)) => Value::Float(x.max(lo).min(hi)),
            _ => Value::Null,
        },
        "format_number" => {
            // format_number(x, decimali [, sep_decimale [, sep_migliaia]])
            // Italiano:  format_number(x, 2, ",", ".")  → 1.234,56
            // Inglese:   format_number(x, 2, ".", ",")  → 1,234.56
            match (f(a0), i(a1)) {
                (Some(x), Some(dec)) => {
                    let dec      = dec.clamp(0, 15) as usize;
                    let dec_sep  = a2.map(|v| s(Some(v))).unwrap_or_else(|| ".".to_string());
                    let thou_sep = args.get(3).map(|v| s(Some(v))).unwrap_or_default();
                    let base = format!("{:.*}", dec, x);   // sempre con '.' decimale
                    let grouped = if thou_sep.is_empty() { base } else { group_thousands(&base, &thou_sep) };
                    // sostituisci il separatore decimale (solo l'ultimo '.')
                    let out = if dec_sep != "." && dec > 0 {
                        match grouped.rfind('.') {
                            Some(pos) => format!("{}{}{}", &grouped[..pos], dec_sep, &grouped[pos + 1..]),
                            None => grouped,
                        }
                    } else { grouped };
                    Value::String(out)
                }
                _ => Value::Null,
            }
        }

        // ── Stringhe ─────────────────────────────────────────────
        "capitalize" => {
            let t = s(a0);
            let mut c = t.chars();
            Value::String(match c.next() {
                Some(first) => first.to_uppercase().collect::<String>() + &c.as_str().to_lowercase(),
                None => String::new(),
            })
        }
        "title_case" => Value::String(
            s(a0).split_whitespace()
                .map(|w| {
                    let mut c = w.chars();
                    match c.next() {
                        Some(f) => f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase(),
                        None => String::new(),
                    }
                })
                .collect::<Vec<_>>().join(" ")
        ),
        "remove_accents" => Value::String(remove_accents_impl(&s(a0))),
        "to_slug" => {
            let base = remove_accents_impl(&s(a0)).to_lowercase();
            let slug: String = base.chars()
                .map(|c| if c.is_alphanumeric() { c } else { '-' })
                .collect();
            // comprimi trattini multipli e togli quelli ai bordi
            let parts: Vec<&str> = slug.split('-').filter(|p| !p.is_empty()).collect();
            Value::String(parts.join("-"))
        }
        "replace_regex" => {
            // replace_regex(s, pattern, sostituto)
            let txt = s(a0);
            let pat = s(a1);
            let rep = s(a2);
            match regex::Regex::new(&pat) {
                Ok(re) => Value::String(re.replace_all(&txt, rep.as_str()).into_owned()),
                Err(_)  => Value::Null,
            }
        }
        "mask_email" => {
            let e = s(a0);
            match e.split_once('@') {
                Some((user, dom)) if !user.is_empty() => {
                    let visible = user.chars().next().unwrap();
                    Value::String(format!("{}{}@{}", visible, "*".repeat(user.len().saturating_sub(1)), dom))
                }
                _ => Value::Null,
            }
        }
        "mask_card" => {
            let digits: String = s(a0).chars().filter(|c| c.is_ascii_digit()).collect();
            if digits.len() < 4 { Value::Null } else {
                let last4 = &digits[digits.len() - 4..];
                Value::String(format!("{}{}", "*".repeat(digits.len() - 4), last4))
            }
        }

        // ── Encoding / hash ──────────────────────────────────────
        "url_encode" => Value::String(urlencoding::encode(&s(a0)).into_owned()),
        "url_decode" => match urlencoding::decode(&s(a0)) {
            Ok(d) => Value::String(d.into_owned()), Err(_) => Value::Null,
        },
        "base64_encode" => {
            use base64::Engine;
            Value::String(base64::engine::general_purpose::STANDARD.encode(s(a0).as_bytes()))
        }
        "base64_decode" => {
            use base64::Engine;
            match base64::engine::general_purpose::STANDARD.decode(s(a0).as_bytes()) {
                Ok(b) => match String::from_utf8(b) { Ok(t) => Value::String(t), Err(_) => Value::Null },
                Err(_) => Value::Null,
            }
        }
        "hash_sha256" => {
            use sha2::{Sha256, Digest};
            let mut h = Sha256::new();
            h.update(s(a0).as_bytes());
            Value::String(format!("{:x}", h.finalize()))
        }



        // ── Date: formattazione bilingue ─────────────────────────
        // Accetta sia i pattern chrono (%Y-%m-%d) sia quelli "umani"
        // (YYYY-MM-DD, DD/MM/YYYY), che è la convenzione che l'utente
        // conosce da Java/Moment/Excel.
        "date_format" => match (date_arg(a0), a1) {
            (Some(d), Some(fmt)) => {
                let pattern = normalize_date_pattern(&s(Some(fmt)));
                Value::String(d.format(&pattern).to_string())
            }
            _ => Value::Null,
        },
        // ── Numeri: logaritmi ────────────────────────────────────
        "log" | "ln" => match f(a0) {
            Some(x) if x > 0.0 => Value::Float(x.ln()),
            _ => Value::Null,
        },
        "log10" => match f(a0) {
            Some(x) if x > 0.0 => Value::Float(x.log10()),
            _ => Value::Null,
        },

        // ── Hash (famiglia SHA) ──────────────────────────────────
        // NB: niente bcrypt/Argon2: sono lenti per progetto e NON
        // deterministici (salt casuale) → inutilizzabili in espressioni
        // pure e in un ETL su volumi. Servono per le password, non qui.
        "hash_sha1" => {
            use sha1::{Sha1, Digest};
            let mut h = Sha1::new();
            h.update(s(a0).as_bytes());
            Value::String(format!("{:x}", h.finalize()))
        }
        "hash_sha512" => {
            use sha2::{Sha512, Digest};
            let mut h = Sha512::new();
            h.update(s(a0).as_bytes());
            Value::String(format!("{:x}", h.finalize()))
        }

        // ── Strutture (oggetti / array JSON) ─────────────────────
        "get" => {
            // get(oggetto, chiave) → valore, o null
            match (a0, a1) {
                (Some(Value::Object(o)), Some(k)) => {
                    let key = s(Some(k));
                    o.get(&key).map(|v| Value::from_json(v.clone())).unwrap_or(Value::Null)
                }
                _ => Value::Null,
            }
        }
        "get_path" => match (a0, a1) {
            // get_path(oggetto, "a.b.c") → valore annidato, o null.
            // Supporta indici di array: get_path(x, "items.0.nome")
            (Some(Value::Object(o)), Some(p)) => match walk_path(o, &s(Some(p))) {
                Some(v) => Value::from_json(v.clone()),
                None    => Value::Null,
            },
            _ => Value::Null,
        },
        "keys" => match a0 {
            Some(Value::Object(o)) => match o.as_object() {
                Some(map) => Value::from_json(serde_json::json!(map.keys().collect::<Vec<_>>())),
                None => Value::Null,
            },
            _ => Value::Null,
        },
        "values" => match a0 {
            Some(Value::Object(o)) => match o.as_object() {
                Some(map) => Value::from_json(serde_json::json!(map.values().collect::<Vec<_>>())),
                None => Value::Null,
            },
            _ => Value::Null,
        },
        "merge" => {
            // merge(a, b) → oggetto unito; le chiavi di b prevalgono
            match (a0, a1) {
                (Some(Value::Object(x)), Some(Value::Object(y))) => {
                    match (x.as_object(), y.as_object()) {
                        (Some(mx), Some(my)) => {
                            let mut out = mx.clone();
                            for (k, v) in my { out.insert(k.clone(), v.clone()); }
                            Value::Object(serde_json::Value::Object(out))
                        }
                        _ => Value::Null,
                    }
                }
                _ => Value::Null,
            }
        }

        "to_json" => match a0 {
            Some(v) => Value::String(v.to_json().to_string()),
            None => Value::Null,
        },

        _ => return None,   // non è una funzione di questo modulo
    };
    Some(out)
}

// ─── Implementazioni di supporto ───────────────────────────────────

fn add_months_impl(d: NaiveDateTime, n: i64) -> Option<NaiveDateTime> {
    let total = d.year() as i64 * 12 + (d.month() as i64 - 1) + n;
    let year  = (total.div_euclid(12)) as i32;
    let month = (total.rem_euclid(12) + 1) as u32;
    // giorno "clampato" all'ultimo del mese (31 gen + 1 mese → 28/29 feb)
    let last = days_in_month(year, month);
    let day  = d.day().min(last);
    NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(d.hour(), d.minute(), d.second())
}

fn end_of_month_impl(d: NaiveDateTime) -> Option<NaiveDate> {
    NaiveDate::from_ymd_opt(d.year(), d.month(), days_in_month(d.year(), d.month()))
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 { 29 } else { 28 },
        _ => 30,
    }
}

fn group_thousands(num: &str, sep: &str) -> String {
    let (intpart, rest) = match num.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (num, None),
    };
    let neg = intpart.starts_with('-');
    let digits = intpart.trim_start_matches('-');
    let mut grouped = String::new();
    for (idx, ch) in digits.chars().enumerate() {
        if idx > 0 && (digits.len() - idx) % 3 == 0 { grouped.push_str(sep) }
        grouped.push(ch);
    }
    let mut out = String::new();
    if neg { out.push('-') }
    out.push_str(&grouped);
    if let Some(r) = rest { out.push('.'); out.push_str(r) }
    out
}

fn remove_accents_impl(t: &str) -> String {
    t.chars().map(|c| match c {
        'à'|'á'|'â'|'ã'|'ä'|'å' => 'a', 'À'|'Á'|'Â'|'Ã'|'Ä'|'Å' => 'A',
        'è'|'é'|'ê'|'ë' => 'e',         'È'|'É'|'Ê'|'Ë' => 'E',
        'ì'|'í'|'î'|'ï' => 'i',         'Ì'|'Í'|'Î'|'Ï' => 'I',
        'ò'|'ó'|'ô'|'õ'|'ö' => 'o',     'Ò'|'Ó'|'Ô'|'Õ'|'Ö' => 'O',
        'ù'|'ú'|'û'|'ü' => 'u',         'Ù'|'Ú'|'Û'|'Ü' => 'U',
        'ñ' => 'n', 'Ñ' => 'N', 'ç' => 'c', 'Ç' => 'C',
        other => other,
    }).collect()
}



/// Naviga un JSON seguendo un percorso "a.b.0.c". None se un segmento manca.
fn walk_path<'a>(root: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut cur = root;
    for part in path.split('.').filter(|x| !x.is_empty()) {
        cur = match part.parse::<usize>() {
            Ok(idx) => cur.get(idx)?,
            Err(_)  => cur.get(part)?,
        };
    }
    Some(cur)
}

/// Converte i pattern "umani" (YYYY-MM-DD, DD/MM/YYYY hh:mm) nei pattern
/// chrono (%Y-%m-%d). I pattern che contengono già '%' passano invariati.
/// L'ordine delle sostituzioni conta: dal più lungo al più corto.
pub fn normalize_date_pattern(fmt: &str) -> String {
    if fmt.contains('%') { return fmt.to_string() }
    let mut out = fmt.to_string();
    for (from, to) in [
        ("YYYY", "%Y"), ("yyyy", "%Y"),
        ("MMMM", "%B"), ("MMM", "%b"),
        ("MM", "%m"),
        ("DDD", "%j"), ("DD", "%d"), ("dd", "%d"),
        ("HH", "%H"), ("hh", "%I"),
        ("mm", "%M"),
        ("ss", "%S"),
        ("SSS", "%3f"),
        ("A", "%p"), ("a", "%P"),
        ("YY", "%y"),
    ] {
        out = out.replace(from, to);
    }
    out
}

// ─── now() / today() con fuso locale ───────────────────────────────
// (esposte per uso da expr.rs se vuole delegarle qui)

pub fn now_value()   -> Value { Value::DateTime(Local::now().naive_local().to_string()) }
pub fn today_value() -> Value { Value::Date(Local::now().date_naive().to_string()) }