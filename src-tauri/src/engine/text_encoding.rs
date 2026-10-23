// ─── src-tauri/src/engine/text_encoding.rs ─────────────────────────
//
// Codifica di un testo nelle codifiche offerte dai pannelli dei sink
// (P356: sink_ftp; pronto per sink_file) e decodifica dei file letti
// (P357: source_file). Senza crate esterni: le
// codifiche a un byte sono tabelle piccole, UTF-16 è nella libreria
// standard.
//
// Un carattere non rappresentabile diventa '?' e si conta: chi chiama
// lo dice nel log, invece di produrre un file che "sembra giusto".

/// Codici 0x80..=0x9F di Windows-1252 (None = posizione non assegnata).
const CP1252_HIGH: [Option<char>; 32] = [
    Some('€'), None, Some('‚'), Some('ƒ'), Some('„'), Some('…'), Some('†'), Some('‡'),
    Some('ˆ'), Some('‰'), Some('Š'), Some('‹'), Some('Œ'), None, Some('Ž'), None,
    None, Some('‘'), Some('’'), Some('“'), Some('”'), Some('•'), Some('–'), Some('—'),
    Some('˜'), Some('™'), Some('š'), Some('›'), Some('œ'), None, Some('ž'), Some('Ÿ'),
];

fn cp1252_byte(c: char) -> Option<u8> {
    let u = c as u32;
    if u < 0x80 || (0xA0..=0xFF).contains(&u) { return Some(u as u8) }
    CP1252_HIGH.iter().position(|x| *x == Some(c)).map(|i| 0x80 + i as u8)
}

/// Normalizza l'etichetta della codifica come la scrivono i pannelli.
pub fn normalize(label: &str) -> String {
    label.trim().to_ascii_lowercase().replace('_', "-")
}

/// Testo → byte nella codifica richiesta. Restituisce anche il numero di
/// caratteri sostituiti con '?'. Errore solo per una codifica sconosciuta.
pub fn encode_text(s: &str, encoding: &str) -> Result<(Vec<u8>, usize), String> {
    let enc = normalize(encoding);
    let mut replaced = 0usize;
    let bytes = match enc.as_str() {
        "" | "utf-8" | "utf8" => s.as_bytes().to_vec(),
        // UTF-16 little endian con BOM: è ciò che si aspettano Excel e Windows.
        "utf-16" | "utf-16le" => {
            let mut v = vec![0xFF, 0xFE];
            for u in s.encode_utf16() { v.extend_from_slice(&u.to_le_bytes()) }
            v
        }
        "iso-8859-1" | "latin-1" | "latin1" => s.chars().map(|c| {
            let u = c as u32;
            if u <= 0xFF { u as u8 } else { replaced += 1; b'?' }
        }).collect(),
        "windows-1252" | "cp1252" => s.chars().map(|c| match cp1252_byte(c) {
            Some(b) => b,
            None    => { replaced += 1; b'?' }
        }).collect(),
        "ascii" | "us-ascii" => s.chars().map(|c| {
            if c.is_ascii() { c as u8 } else { replaced += 1; b'?' }
        }).collect(),
        other => return Err(format!("unsupported encoding '{}' (use utf-8, utf-16, iso-8859-1, windows-1252 or ascii)", other)),
    };
    Ok((bytes, replaced))
}

// ─── Decodifica (P357: source_file) ─────────────────────────────────

/// Codifiche a un byte per carattere: si decodificano riga per riga.
pub fn is_single_byte(encoding: &str) -> bool {
    matches!(normalize(encoding).as_str(), "iso-8859-1" | "latin-1" | "latin1" | "windows-1252" | "cp1252" | "ascii" | "us-ascii")
}

/// Un byte → carattere, per le codifiche a un byte.
pub fn decode_byte(b: u8, encoding: &str) -> char {
    match normalize(encoding).as_str() {
        "windows-1252" | "cp1252" if (0x80..=0x9F).contains(&b) =>
            CP1252_HIGH[(b - 0x80) as usize].unwrap_or('\u{FFFD}'),
        "ascii" | "us-ascii" if b >= 0x80 => '\u{FFFD}',
        _ => b as char,   // ISO-8859-1: il byte È il code point
    }
}

/// Byte → testo. UTF-8 (BOM tolto), UTF-16 (BOM LE/BE; senza BOM: LE),
/// codifiche a un byte. Errore per una codifica sconosciuta o un UTF-8
/// non valido (con la posizione).
pub fn decode_text(bytes: &[u8], encoding: &str) -> Result<String, String> {
    let enc = normalize(encoding);
    match enc.as_str() {
        "" | "utf-8" | "utf8" => {
            let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
            String::from_utf8(b.to_vec()).map_err(|e| format!(
                "the file is not valid UTF-8 (byte {}): choose the right encoding in the panel", e.utf8_error().valid_up_to()))
        }
        "utf-16" | "utf-16le" | "utf-16be" => {
            let (body, be) = if bytes.starts_with(&[0xFE, 0xFF]) { (&bytes[2..], true) }
                             else if bytes.starts_with(&[0xFF, 0xFE]) { (&bytes[2..], false) }
                             else { (bytes, enc == "utf-16be") };
            let units: Vec<u16> = body.chunks(2).filter(|c| c.len() == 2)
                .map(|c| if be { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) })
                .collect();
            Ok(String::from_utf16_lossy(&units))
        }
        _ if is_single_byte(&enc) => Ok(bytes.iter().map(|b| decode_byte(*b, &enc)).collect()),
        other => Err(format!("unsupported encoding '{}' (use utf-8, utf-16, iso-8859-1, windows-1252 or ascii)", other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codifiche() {
        assert_eq!(encode_text("è€", "utf-8").unwrap().0, "è€".as_bytes());
        assert_eq!(encode_text("è€", "windows-1252").unwrap(), (vec![0xE8, 0x80], 0));
        assert_eq!(encode_text("è€", "iso-8859-1").unwrap(), (vec![0xE8, b'?'], 1));
        assert_eq!(encode_text("aè", "ascii").unwrap(), (vec![b'a', b'?'], 1));
        assert_eq!(encode_text("A", "utf-16").unwrap().0, vec![0xFF, 0xFE, 0x41, 0x00]);
        assert!(encode_text("x", "ebcdic").is_err());
    }

    #[test]
    fn decodifiche() {
        assert_eq!(decode_text(&[0xEF, 0xBB, 0xBF, b'a'], "utf-8").unwrap(), "a");
        assert_eq!(decode_text(&[0xE8, 0x80], "windows-1252").unwrap(), "è€");
        assert_eq!(decode_text(&[0xE8], "iso-8859-1").unwrap(), "è");
        assert_eq!(decode_text(&[0xFF, 0xFE, 0x41, 0x00], "utf-16").unwrap(), "A");
        assert!(decode_text(&[0xE8], "utf-8").unwrap_err().contains("not valid UTF-8"));
        // andata e ritorno
        let (b, _) = encode_text("Città €", "windows-1252").unwrap();
        assert_eq!(decode_text(&b, "windows-1252").unwrap(), "Città €");
    }
}
