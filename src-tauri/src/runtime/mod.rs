// ─── src-tauri/src/runtime/mod.rs ─────────────────────────────────
// Lato "runtime" dell'architettura di esecuzione (docs/ARCHITETTURA-coordinatore.md):
// ciò che una macchina decide da sé prima di eseguire un artifact.
//
//   profile    profilo della runtime: policy dei nodi (e, in futuro, limiti)
//   config     configurazione separata dall'artifact (variabili dichiarate)
//   admission  UNICO ingresso dell'ammissione: firma + compatibilità + policy.
//              Lo usa il runner oggi; lo useranno agente e coordinatore.
pub mod admission;
pub mod config;
pub mod profile;

/// Applica `secrets.onlyDeclared` del profilo (P380): da qui in poi, nel processo,
/// si risolvono solo i segreti elencati in `requiredSecrets` del manifesto firmato.
pub fn restrict_secrets_to_declared(manifest: &serde_json::Value) -> Vec<String> {
    let names: Vec<String> = manifest
        .get("requiredSecrets")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    crate::secrets::restrict_to(names.clone());
    names
}
