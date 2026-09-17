// ─── src-tauri/src/signing/trust.rs ───────────────────────────────
// TRUST STORE della runtime: elenco delle chiavi PUBBLICHE autorizzate a
// pubblicare artifact su questa runtime. (HANDOFF-firma-artifact.md §6)
//
// v1: file JSON ~/.flowpilot/trust-store.json
//   { "keys": [ { "keyId": "ed25519:...", "publicKey": "<base64>",
//                 "owner": "nome", "status": "active" }, ... ] }
// Enrollment offline: l'admin aggiunge keyId+publicKey (li trova in
// ~/.flowpilot/signing-key.json sullo studio dello sviluppatore). Revoca:
// status != "active" (o riga rimossa). La runtime NON ha chiavi private.

use serde_json::Value;
use std::path::{Path, PathBuf};

pub fn default_trust_path() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(".flowpilot").join("trust-store.json")
}

pub struct TrustStore {
    entries: Vec<Value>,
}

impl TrustStore {
    pub fn load() -> Self {
        Self::load_at(&default_trust_path())
    }

    pub fn load_at(path: &Path) -> Self {
        let entries = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.get("keys").and_then(|k| k.as_array()).cloned())
            .unwrap_or_default();
        TrustStore { entries }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn entry(&self, key_id: &str) -> Option<&Value> {
        self.entries
            .iter()
            .find(|e| e.get("keyId").and_then(|v| v.as_str()) == Some(key_id))
    }

    /// Chiave pubblica (base64) autorizzata per `key_id`, solo se presente e
    /// con status "active".
    pub fn authorized_key(&self, key_id: &str) -> Option<String> {
        let e = self.entry(key_id)?;
        let status = e.get("status").and_then(|v| v.as_str()).unwrap_or("active");
        if status != "active" {
            return None;
        }
        e.get("publicKey").and_then(|v| v.as_str()).map(|s| s.to_string())
    }

    pub fn owner(&self, key_id: &str) -> Option<String> {
        self.entry(key_id)
            .map(|e| e.get("owner").and_then(|v| v.as_str()).unwrap_or("").to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_store(keys: Value) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flowpilot-trust-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("trust-store.json");
        std::fs::write(&path, serde_json::to_vec(&json!({ "keys": keys })).unwrap()).unwrap();
        path
    }

    #[test]
    fn attiva_autorizzata_revocata_no() {
        let path = write_store(json!([
            { "keyId": "ed25519:aaa", "publicKey": "PUBA", "owner": "marco", "status": "active" },
            { "keyId": "ed25519:bbb", "publicKey": "PUBB", "owner": "eve",   "status": "revoked" }
        ]));
        let t = TrustStore::load_at(&path);
        assert_eq!(t.authorized_key("ed25519:aaa").as_deref(), Some("PUBA"));
        assert_eq!(t.owner("ed25519:aaa").as_deref(), Some("marco"));
        assert_eq!(t.authorized_key("ed25519:bbb"), None); // revocata
        assert_eq!(t.authorized_key("ed25519:zzz"), None); // sconosciuta
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn store_assente_e_vuoto() {
        let t = TrustStore::load_at(Path::new("/percorso/che/non/esiste.json"));
        assert!(t.is_empty());
        assert_eq!(t.authorized_key("ed25519:aaa"), None);
    }
}
