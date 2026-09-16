// ─── src-tauri/src/signing/keys.rs ────────────────────────────────
// Gestione della chiave dello sviluppatore per la FIRMA degli artifact.
// (HANDOFF-firma-artifact.md §6/§7)
//
// v1: chiave privata in un FILE protetto (0600) accanto a studio.json, in
// ~/.flowpilot/signing-key.json. Semplice e air-gap (nessun collegamento
// alla runtime). Upgrade possibile: keychain del SO (crate `keyring`, già
// usato per i segreti) — hardening successivo.

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Percorso di default: ~/.flowpilot/signing-key.json (accanto a studio.json).
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

fn from_signing(sk: SigningKey) -> Keypair {
    let pk = sk.verifying_key().to_bytes();
    Keypair { key_id: key_id(&pk), public_b64: STANDARD.encode(pk), signing: sk }
}

/// Carica la chiave da `path`; se non esiste la GENERA e la salva (0600).
pub fn load_or_create_at(path: &Path) -> std::io::Result<Keypair> {
    if path.exists() {
        let raw = std::fs::read_to_string(path)?;
        let v: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let b64 = v.get("private").and_then(|x| x.as_str()).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "campo 'private' mancante")
        })?;
        let bytes = STANDARD
            .decode(b64)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let arr: [u8; 32] = bytes.try_into().map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "chiave privata di 32 byte attesa")
        })?;
        return Ok(from_signing(SigningKey::from_bytes(&arr)));
    }
    let sk = SigningKey::generate(&mut rand_core::OsRng);
    save(path, &sk)?;
    Ok(from_signing(sk))
}

/// Come sopra, sul percorso di default.
pub fn load_or_create() -> std::io::Result<Keypair> {
    load_or_create_at(&default_key_path())
}

fn save(path: &Path, sk: &SigningKey) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let pk = sk.verifying_key().to_bytes();
    let doc = serde_json::json!({
        "alg":     "ed25519",
        "private": STANDARD.encode(sk.to_bytes()),
        "public":  STANDARD.encode(pk),
        "keyId":   key_id(&pk),
    });
    std::fs::write(path, serde_json::to_vec_pretty(&doc).unwrap())?;
    restrict(path)
}

#[cfg(unix)]
fn restrict(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}
#[cfg(not(unix))]
fn restrict(_path: &Path) -> std::io::Result<()> {
    Ok(())
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

    #[test]
    fn crea_e_ricarica_stessa_chiave() {
        let dir = std::env::temp_dir().join(format!("flowpilot-keytest-{}", std::process::id()));
        let path = dir.join("signing-key.json");
        let _ = std::fs::remove_dir_all(&dir);
        let a = load_or_create_at(&path).unwrap(); // genera
        let b = load_or_create_at(&path).unwrap(); // ricarica
        assert_eq!(a.key_id, b.key_id);
        assert_eq!(a.public_b64, b.public_b64);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
