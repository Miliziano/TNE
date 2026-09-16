// ─── src-tauri/src/signing/mod.rs ─────────────────────────────────
// Catena di fiducia degli artifact (firma). Vedi HANDOFF-firma-artifact.md.
// v1: sola FORMA CANONICA + planHash (§4/§5). Firma/verifica in arrivo.
pub mod canonical;
pub mod keys; // gestione chiave Ed25519 dello sviluppatore (§6/§7)
pub mod sign; // firma/verifica del manifesto (§5/§9)
