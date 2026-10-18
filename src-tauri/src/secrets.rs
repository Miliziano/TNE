// src-tauri/src/secrets.rs
//
// Provider di SEGRETI. I `${SEGRETO}` nei config delle RISORSE vengono lasciati
// INTATTI dallo studio (che risolve solo le variabili non-segrete) e arrivano
// qui, dove vengono risolti NEL BACKEND: il valore del segreto non torna mai al
// lato JS.
//
// P155: backend = SOLO variabili d'ambiente (server/CI, stile 12-factor).
// Fetta successiva: fallback sul KEYCHAIN del SO per il desktop (crate keyring),
// più i comandi per impostare/leggere un segreto — l'unico punto da estendere è
// `resolve_secret` qui sotto.

use std::sync::{Mutex, OnceLock};

/// Nome del "service" nel keychain del SO (namespace dei segreti di FlowPilot).
const SERVICE: &str = "flowpilot";

/// Legge un segreto per nome. Ordine di risoluzione:
///   1. variabile d'ambiente `NOME` (server/CI, stile 12-factor);
///   2. keychain del SO (desktop: Keychain macOS / Credential Manager Windows /
///      Secret Service Linux), service `flowpilot`.
/// Ritorna None se il segreto non è disponibile da nessuna fonte. Gli errori del
/// keychain (assente/non sbloccato) degradano a None: la risoluzione non crasha.
pub fn resolve_secret(name: &str) -> Option<String> {
    if let Ok(v) = std::env::var(name) {
        if !v.is_empty() {
            remember_secret(&v);
            return Some(v);
        }
    }
    let kc = keyring::Entry::new(SERVICE, name)
        .ok()
        .and_then(|e| e.get_password().ok())
        .filter(|v| !v.is_empty());
    if let Some(ref v) = kc {
        remember_secret(v);
    }
    kc
}

/// Imposta un segreto nel keychain del SO (provisioning sulla macchina).
pub fn set_secret(name: &str, value: &str) -> Result<(), String> {
    remember_secret(value);
    keyring::Entry::new(SERVICE, name)
        .map_err(|e| e.to_string())?
        .set_password(value)
        .map_err(|e| e.to_string())
}

/// Vero se il segreto è disponibile (env var o keychain).
pub fn has_secret(name: &str) -> bool {
    resolve_secret(name).is_some()
}

/// Rimuove un segreto dal keychain del SO.
pub fn delete_secret(name: &str) -> Result<(), String> {
    keyring::Entry::new(SERVICE, name)
        .map_err(|e| e.to_string())?
        .delete_credential()
        .map_err(|e| e.to_string())
}

/// Sostituisce ogni `${NOME}` nella stringa col segreto risolto. Se un segreto
/// non è disponibile, lascia `${NOME}` INTATTO: nessun valore fittizio finisce
/// nella connessione, e l'errore a valle rende evidente quale segreto manca.
/// UTF-8 safe: `find` su `"${"`/`"}"` restituisce offset ai confini dei char.
pub fn resolve_secret_refs(s: &str) -> String {
    if !s.contains("${") {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find('}') {
            Some(end) => {
                let name = after[..end].trim();
                match resolve_secret(name) {
                    Some(v) => out.push_str(&v),
                    None => {
                        // segreto assente → lascia `${NOME}` intatto
                        out.push_str("${");
                        out.push_str(&after[..end]);
                        out.push('}');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                // nessuna chiusura '}': copia il resto e termina
                out.push_str("${");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

// ── REDACTION dei segreti nei log/eventi (verso il monitor e stdout) ──────────
// I valori dei segreti risolti in questo processo vengono registrati qui, e
// `redact()` li maschera nei testi emessi (NodeLog.message, NodeFailed.error).
// Difesa al confine di EMISSIONE: cattura qualunque nodo, indipendentemente da
// dove il valore sia finito (comando ssh/shell, connection-string, ecc.).
// Limite noto: maschera il valore LETTERALE; una forma trasformata (es. URL-
// encoded) non verrebbe colta. Soglia >= 4 char per non mascherare valori banali.

fn secret_registry() -> &'static Mutex<Vec<String>> {
    static R: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Vec::new()))
}

/// Registra un valore di segreto risolto, per la successiva redaction.
fn remember_secret(value: &str) {
    if value.chars().count() < 4 {
        return; // valori troppo brevi: mascherarli spezzerebbe testo innocuo
    }
    if let Ok(mut reg) = secret_registry().lock() {
        if !reg.iter().any(|v| v == value) {
            reg.push(value.to_string());
            // i più lunghi prima: se un segreto è sottostringa di un altro,
            // si maschera prima quello più lungo.
            reg.sort_by(|a, b| b.len().cmp(&a.len()));
        }
    }
}

/// Maschera con `***` ogni valore di segreto risolto in questo processo.
/// Da usare SOLO al confine di emissione (log/eventi). Nessun costo se non è
/// stato risolto alcun segreto.
pub fn redact(text: &str) -> String {
    let reg = match secret_registry().lock() {
        Ok(r) => r,
        Err(_) => return text.to_string(),
    };
    if reg.is_empty() {
        return text.to_string();
    }
    let mut out = text.to_string();
    for v in reg.iter() {
        if out.contains(v.as_str()) {
            out = out.replace(v.as_str(), "***");
        }
    }
    out
}

#[cfg(test)]
mod redaction_tests {
    use super::*;

    #[test]
    fn maschera_i_segreti_registrati_non_i_valori_brevi() {
        remember_secret("S3cr3t!Passw0rd");
        remember_secret("abc123def456");
        remember_secret("ok"); // < 4 → ignorato
        let a = redact("ssh with password 'S3cr3t!Passw0rd' ok");
        assert!(!a.contains("S3cr3t!Passw0rd"));
        assert!(a.contains("***") && a.contains("ok")); // 'ok' resta, non spezza
        let b = redact("postgres://u:S3cr3t!Passw0rd@h Bearer abc123def456");
        assert!(!b.contains("S3cr3t!Passw0rd") && !b.contains("abc123def456"));
    }
}
