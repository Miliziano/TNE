// ─── src-tauri/src/signing/trust.rs ───────────────────────────────
// TRUST STORE della runtime: elenco delle chiavi PUBBLICHE autorizzate a
// pubblicare artifact su questa runtime. (HANDOFF-firma-artifact.md §6)
//
// v1: file JSON ~/.flowpilot/trust-store.json
//   { "keys": [ { "keyId": "ed25519:...", "publicKey": "<base64>",
//                 "owner": "nome", "status": "active" }, ... ] }
// Enrollment offline: l'admin aggiunge la voce esportata dallo studio con
// `flowpilot_runner trust add <voce.json> --owner <nome>` (P333). Revoca:
// `flowpilot_runner trust revoke <keyId>` (status "revoked", la riga resta
// per l'audit). La runtime NON ha chiavi private.
//
// Il trust store è il "gioiello" della runtime (modello di minaccia, punto 1):
// chi può scriverlo decide di chi ci si fida. Per questo `open()` è RIGOROSO:
//   - file assente / illeggibile / JSON non valido → errore (niente "vuoto" silenzioso);
//   - su Unix, file o cartella scrivibili da chiunque → errore (rifiuto);
//     scrivibile dal gruppo → avviso;
//   - voci incoerenti (keyId che non è il fingerprint della publicKey, chiave
//     non decodificabile) → IGNORATE con avviso: non autorizzano nulla.

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::VerifyingKey;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn default_trust_path() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(".flowpilot").join("trust-store.json")
}

#[derive(Default)]
pub struct TrustStore {
    entries: Vec<Value>,
    warnings: Vec<String>,
    ignored: usize,
}

/// Esito di `add`.
#[derive(Debug, PartialEq)]
pub enum AddOutcome {
    /// Voce nuova aggiunta.
    Added,
    /// La chiave era già presente e attiva: nessuna modifica.
    AlreadyActive,
}

/// Decodifica e valida una chiave pubblica Ed25519 in base64 (32 byte, punto
/// valido della curva). Restituisce (bytes, keyId calcolato).
pub fn parse_public_key(public_b64: &str) -> Result<([u8; 32], String), String> {
    let bytes = STANDARD
        .decode(public_b64.trim())
        .map_err(|_| "chiave pubblica: non è base64 valido".to_string())?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "chiave pubblica: deve essere di 32 byte (Ed25519)".to_string())?;
    VerifyingKey::from_bytes(&bytes)
        .map_err(|_| "chiave pubblica: non è una chiave Ed25519 valida".to_string())?;
    let id = super::keys::key_id(&bytes);
    Ok((bytes, id))
}

/// Una voce è coerente se la publicKey è valida e il keyId è ESATTAMENTE il
/// suo fingerprint. Un keyId che non corrisponde alla chiave confonderebbe
/// l'attribuzione (audit) → la voce non deve autorizzare nulla.
fn check_entry(e: &Value) -> Result<(), String> {
    let key_id = e.get("keyId").and_then(|v| v.as_str()).unwrap_or("");
    let public = e
        .get("publicKey")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("voce '{key_id}': publicKey mancante"))?;
    let (_, computed) = parse_public_key(public).map_err(|m| format!("voce '{key_id}': {m}"))?;
    if computed != key_id {
        return Err(format!(
            "voce '{key_id}': il keyId non corrisponde alla chiave pubblica (atteso {computed})"
        ));
    }
    Ok(())
}

impl TrustStore {
    /// Trust store vuoto (per costruirne uno nuovo con `add` + `save`).
    pub fn empty() -> Self {
        Self::default()
    }

    /// Caricamento TOLLERANTE (storico): qualunque problema → store vuoto, che
    /// non autorizza nulla (resta fail-closed). Il runner usa `open`, che spiega
    /// il motivo invece di ripiegare.
    pub fn load() -> Self {
        Self::load_at(&default_trust_path())
    }

    pub fn load_at(path: &Path) -> Self {
        Self::open(path).unwrap_or_default()
    }

    /// Caricamento RIGOROSO: errore se il file manca, non si legge, non è un
    /// trust store valido o (Unix) ha permessi pericolosi. Le voci incoerenti
    /// sono scartate e riportate in `warnings()`.
    pub fn open(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Err(format!(
                "trust store assente ({}): nessuna chiave è autorizzata su questa runtime",
                path.display()
            ));
        }
        let mut warnings = check_permissions(path)?;
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("trust store illeggibile ({}): {e}", path.display()))?;
        let mut store = Self::parse(&raw)
            .map_err(|e| format!("trust store non valido ({}): {e}", path.display()))?;
        warnings.append(&mut store.warnings);
        store.warnings = warnings;
        Ok(store)
    }

    /// Interpreta il contenuto JSON di un trust store.
    pub fn parse(raw: &str) -> Result<Self, String> {
        let v: Value = serde_json::from_str(raw).map_err(|e| format!("JSON non valido: {e}"))?;
        let keys = v
            .get("keys")
            .and_then(|k| k.as_array())
            .ok_or_else(|| "manca l'array \"keys\"".to_string())?;
        let mut entries = Vec::new();
        let mut warnings = Vec::new();
        let mut ignored = 0;
        for e in keys {
            match check_entry(e) {
                Ok(()) => entries.push(e.clone()),
                Err(m) => {
                    ignored += 1;
                    warnings.push(format!("{m} — voce IGNORATA"));
                }
            }
        }
        Ok(TrustStore { entries, warnings, ignored })
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Voci valide (per elencarle).
    pub fn entries(&self) -> &[Value] {
        &self.entries
    }

    /// Avvisi raccolti al caricamento (voci ignorate, permessi larghi).
    pub fn warnings(&self) -> &[String] {
        &self.warnings
    }

    /// Quante voci del file sono state scartate perché incoerenti. Chi MODIFICA
    /// il trust store deve rifiutarsi di salvare se > 0: `save` riscrive solo le
    /// voci valide e cancellerebbe in silenzio quelle scartate.
    pub fn ignored(&self) -> usize {
        self.ignored
    }

    fn entry(&self, key_id: &str) -> Option<&Value> {
        self.entries
            .iter()
            .find(|e| e.get("keyId").and_then(|v| v.as_str()) == Some(key_id))
    }

    fn entry_mut(&mut self, key_id: &str) -> Option<&mut Value> {
        self.entries
            .iter_mut()
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

    /// Autorizza una chiave. `declared_key_id`, se presente (voce esportata
    /// dallo studio), DEVE coincidere col fingerprint della chiave. Una chiave
    /// REVOCATA non si riattiva da qui: la revoca di solito significa
    /// compromissione, e riattivarla deve essere una scelta esplicita (a mano).
    pub fn add(
        &mut self,
        public_b64: &str,
        declared_key_id: Option<&str>,
        owner: &str,
    ) -> Result<(AddOutcome, String), String> {
        let owner = owner.trim();
        if owner.is_empty() {
            return Err("owner obbligatorio: indica a chi appartiene la chiave (--owner)".into());
        }
        let (_, key_id) = parse_public_key(public_b64)?;
        if let Some(decl) = declared_key_id.filter(|d| !d.trim().is_empty()) {
            if decl.trim() != key_id {
                return Err(format!(
                    "il keyId dichiarato ({}) non corrisponde alla chiave pubblica ({key_id}): voce rifiutata",
                    decl.trim()
                ));
            }
        }
        if let Some(e) = self.entry(&key_id) {
            let status = e.get("status").and_then(|v| v.as_str()).unwrap_or("active");
            if status == "active" {
                return Ok((AddOutcome::AlreadyActive, key_id));
            }
            return Err(format!(
                "la chiave {key_id} è presente con stato '{status}': non viene riattivata. \
                 Se è davvero voluto, modifica a mano il trust store."
            ));
        }
        self.entries.push(json!({
            "keyId": key_id,
            "publicKey": public_b64.trim(),
            "owner": owner,
            "status": "active",
            "addedAt": chrono::Utc::now().to_rfc3339(),
        }));
        Ok((AddOutcome::Added, key_id))
    }

    /// Revoca una chiave (status "revoked" + revokedAt). La riga RESTA, per
    /// l'audit. Ritorna false se era già revocata. Match ESATTO sul keyId.
    pub fn revoke(&mut self, key_id: &str) -> Result<bool, String> {
        let e = self
            .entry_mut(key_id)
            .ok_or_else(|| format!("chiave '{key_id}' non presente nel trust store"))?;
        if e.get("status").and_then(|v| v.as_str()) == Some("revoked") {
            return Ok(false);
        }
        if let Some(obj) = e.as_object_mut() {
            obj.insert("status".into(), Value::from("revoked"));
            obj.insert("revokedAt".into(), Value::from(chrono::Utc::now().to_rfc3339()));
        }
        Ok(true)
    }

    /// Scrive il trust store in modo ATOMICO (file temporaneo + rename) e con
    /// permessi stretti su Unix (file 0600, cartella 0700 se la crea).
    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            if !dir.as_os_str().is_empty() && !dir.exists() {
                create_private_dir(dir)?;
            }
        }
        let body = serde_json::to_vec_pretty(&json!({ "keys": self.entries }))
            .map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        write_private_file(&tmp, &body)?;
        std::fs::rename(&tmp, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("scrittura del trust store ({}): {e}", path.display())
        })
    }
}

fn check_permissions(path: &Path) -> Result<Vec<String>, String> {
    check_file_permissions(path, "trust store")
}

/// Controllo dei permessi di un file di configurazione DI SICUREZZA della
/// runtime (trust store, profilo della runtime): chi può scriverlo decide cosa
/// la macchina esegue. Scrivibile da chiunque (o in una cartella scrivibile da
/// chiunque senza sticky bit) → rifiutato; scrivibile dal gruppo → avviso.
#[cfg(unix)]
pub(crate) fn check_file_permissions(path: &Path, label: &str) -> Result<Vec<String>, String> {
    use std::os::unix::fs::PermissionsExt;
    let mut warnings = Vec::new();
    let mode = std::fs::metadata(path)
        .map_err(|e| format!("{label} ({}): {e}", path.display()))?
        .permissions()
        .mode();
    if mode & 0o002 != 0 {
        return Err(format!(
            "{label} scrivibile da CHIUNQUE ({}, permessi {:o}): rifiutato. Correggi con: chmod 600 {}",
            path.display(),
            mode & 0o777,
            path.display()
        ));
    }
    if mode & 0o020 != 0 {
        warnings.push(format!(
            "{label} scrivibile dal gruppo ({}, permessi {:o}): consigliato chmod 600",
            path.display(),
            mode & 0o777
        ));
    }
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        if let Ok(md) = std::fs::metadata(dir) {
            let dmode = md.permissions().mode();
            // cartella scrivibile da chiunque e senza sticky bit: chiunque può
            // sostituire il file → equivale a un trust store scrivibile.
            if dmode & 0o002 != 0 && dmode & 0o1000 == 0 {
                return Err(format!(
                    "la cartella del {label} è scrivibile da CHIUNQUE ({}, permessi {:o}): rifiutato",
                    dir.display(),
                    dmode & 0o7777
                ));
            }
        }
    }
    Ok(warnings)
}

#[cfg(not(unix))]
pub(crate) fn check_file_permissions(_path: &Path, _label: &str) -> Result<Vec<String>, String> {
    // Windows: le ACL non si riducono a bit rwx; la protezione è responsabilità
    // dell'amministratore (cartella del profilo dell'utente di servizio).
    Ok(Vec::new())
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("creazione cartella {}: {e}", dir.display()))
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("creazione cartella {}: {e}", dir.display()))
}

#[cfg(unix)]
fn write_private_file(path: &Path, body: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("scrittura {}: {e}", path.display()))?;
    f.write_all(body).map_err(|e| format!("scrittura {}: {e}", path.display()))?;
    f.sync_all().map_err(|e| format!("scrittura {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn write_private_file(path: &Path, body: &[u8]) -> Result<(), String> {
    std::fs::write(path, body).map_err(|e| format!("scrittura {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    fn pubkey(seed: u8) -> (String, String) {
        let pk = SigningKey::from_bytes(&[seed; 32]).verifying_key().to_bytes();
        (STANDARD.encode(pk), super::super::keys::key_id(&pk))
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flowpilot-trust-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        dir
    }

    fn write_store(tag: &str, keys: Value) -> PathBuf {
        let path = tmp_dir(tag).join("trust-store.json");
        write_private_file(&path, &serde_json::to_vec(&json!({ "keys": keys })).unwrap()).unwrap();
        path
    }

    #[test]
    fn attiva_autorizzata_revocata_no() {
        let (pa, ida) = pubkey(1);
        let (pb, idb) = pubkey(2);
        let path = write_store("stati", json!([
            { "keyId": ida, "publicKey": pa, "owner": "marco", "status": "active" },
            { "keyId": idb, "publicKey": pb, "owner": "eve",   "status": "revoked" }
        ]));
        let t = TrustStore::open(&path).unwrap();
        assert_eq!(t.authorized_key(&ida).as_deref(), Some(pa.as_str()));
        assert_eq!(t.owner(&ida).as_deref(), Some("marco"));
        assert_eq!(t.authorized_key(&idb), None); // revocata
        assert_eq!(t.authorized_key("ed25519:zzz"), None); // sconosciuta
        assert!(t.warnings().is_empty());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn store_assente_errore_rigoroso_e_vuoto_tollerante() {
        let p = Path::new("/percorso/che/non/esiste.json");
        assert!(TrustStore::open(p).is_err());
        let t = TrustStore::load_at(p);
        assert!(t.is_empty());
        assert_eq!(t.authorized_key("ed25519:aaa"), None);
    }

    #[test]
    fn json_non_valido_e_errore() {
        assert!(TrustStore::parse("{ non json").is_err());
        assert!(TrustStore::parse("{\"altro\": []}").is_err());
    }

    #[test]
    fn voce_con_keyid_incoerente_ignorata() {
        let (pa, _ida) = pubkey(1);
        let (_pb, idb) = pubkey(2);
        // keyId di B con la chiave di A: non deve autorizzare né A né B
        let t = TrustStore::parse(
            &json!({ "keys": [ { "keyId": idb, "publicKey": pa, "owner": "x", "status": "active" } ] })
                .to_string(),
        )
        .unwrap();
        assert!(t.is_empty());
        assert_eq!(t.authorized_key(&idb), None);
        assert_eq!(t.warnings().len(), 1);
        assert_eq!(t.ignored(), 1);
    }

    #[test]
    fn add_revoke_save_roundtrip() {
        let dir = tmp_dir("rt");
        let path = dir.join("sub").join("trust-store.json"); // cartella da creare
        let (pa, ida) = pubkey(3);
        let mut t = TrustStore::empty();
        assert!(t.add(&pa, None, "").is_err()); // owner obbligatorio
        assert!(t.add(&pa, Some("ed25519:sbagliato"), "marco").is_err()); // keyId incoerente
        assert_eq!(t.add(&pa, Some(&ida), "marco").unwrap(), (AddOutcome::Added, ida.clone()));
        assert_eq!(t.add(&pa, None, "marco").unwrap().0, AddOutcome::AlreadyActive);
        t.save(&path).unwrap();

        let mut t2 = TrustStore::open(&path).unwrap();
        assert_eq!(t2.authorized_key(&ida).as_deref(), Some(pa.as_str()));
        assert!(t2.revoke(&ida).unwrap());
        assert!(!t2.revoke(&ida).unwrap()); // già revocata
        assert!(t2.revoke("ed25519:assente").is_err());
        t2.save(&path).unwrap();

        let mut t3 = TrustStore::open(&path).unwrap();
        assert_eq!(t3.authorized_key(&ida), None);
        assert!(t3.add(&pa, None, "marco").is_err()); // una revocata non si riattiva
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let m = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(m, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chiave_pubblica_non_valida_rifiutata() {
        let mut t = TrustStore::empty();
        assert!(t.add("non-base64!!", None, "marco").is_err());
        assert!(t.add(&STANDARD.encode([1u8; 16]), None, "marco").is_err()); // 16 byte
    }

    #[cfg(unix)]
    #[test]
    fn permessi_pericolosi() {
        use std::os::unix::fs::PermissionsExt;
        let (pa, ida) = pubkey(4);
        let path = write_store("perm", json!([
            { "keyId": ida, "publicKey": pa, "owner": "marco", "status": "active" }
        ]));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(TrustStore::open(&path).is_err()); // scrivibile da chiunque
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o660)).unwrap();
        let t = TrustStore::open(&path).unwrap(); // gruppo: avviso, non rifiuto
        assert_eq!(t.warnings().len(), 1);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
