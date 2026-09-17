// ─── src-tauri/src/signing/mod.rs ─────────────────────────────────
// Catena di fiducia degli artifact (firma). Vedi HANDOFF-firma-artifact.md.
// v1: sola FORMA CANONICA + planHash (§4/§5). Firma/verifica in arrivo.
pub mod canonical;
pub mod keys; // gestione chiave Ed25519 dello sviluppatore (§6/§7)
pub mod sign; // firma/verifica del manifesto (§5/§9)
pub mod seal; // costruzione + firma del manifesto per l'export (§5)
pub mod trust; // trust store della runtime: chiavi pubbliche autorizzate (§6)
pub mod verify; // verifica fail-closed dell'artifact prima dell'esecuzione (§9)
