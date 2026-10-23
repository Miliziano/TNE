// ─── src-tauri/src/engine/text_encoding.rs ─────────────────────────
//
// Codifica di un testo nelle codifiche offerte dai pannelli dei sink
// (P356: sink_ftp; pronto per sink_file). Senza crate esterni: le
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
}
