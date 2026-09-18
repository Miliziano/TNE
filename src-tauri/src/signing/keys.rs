// ─── src-tauri/src/signing/keys.rs ────────────────────────────────
// Helper condivisi per la chiave di firma: percorso del file, fingerprint
// (keyId) e il tipo Keypair. Lo STORAGE della chiave (cifrato a riposo) e lo
// sblocco in memoria stanno in `vault.rs`. (HANDOFF-firma-artifact.md §6/§7)

use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

/// Percorso del file chiave: ~/.flowpilot/signing-key.json (accanto a studio.json).
pub fn default_key_path() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(".flowpilot").join("signing-key.json")
}

/// keyId = "ed25519:" + hex(sha256(chiave pubblica)). Fingerprint stabile,
/// mostrato all'enrollment (trust store) e citato nel manifesto.
pub fn key_id(public_key: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(public_key);
    format!("ed25519:{:x}", h.finalize())
}

pub struct Keypair {
    pub signing: SigningKey,
    pub key_id: String,
    pub public_b64: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_id_deterministico_da_seed() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        assert_eq!(
            key_id(&sk.verifying_key().to_bytes()),
            "ed25519:fe812c12f3ab4ce6ac5db69ac352f906cb1b11ef43fb33e252ef7ff552263889"
        );
    }
}
