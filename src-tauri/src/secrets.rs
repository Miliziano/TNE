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

/// Legge un segreto per nome. Ordine di risoluzione:
///   1. variabile d'ambiente `NOME` (iniettata dall'orchestratore/CI);
///   (2. keychain del SO — desktop — in arrivo).
/// Ritorna None se il segreto non è disponibile.
pub fn resolve_secret(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(v) if !v.is_empty() => Some(v),
        _ => None,
    }
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
