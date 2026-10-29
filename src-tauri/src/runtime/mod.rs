// ─── src-tauri/src/runtime/mod.rs ─────────────────────────────────
// Lato "runtime" dell'architettura di esecuzione (docs/ARCHITETTURA-coordinatore.md):
// ciò che una macchina decide da sé prima di eseguire un artifact.
//
//   profile    profilo della runtime: policy dei nodi (e, in futuro, limiti)
//   admission  UNICO ingresso dell'ammissione: firma + compatibilità + policy.
//              Lo usa il runner oggi; lo useranno agente e coordinatore.
pub mod admission;
pub mod profile;
