// ─── src-tauri/src/signing/vault.rs ───────────────────────────────
// VAULT della chiave di firma: la chiave privata (seed Ed25519) è salvata
// CIFRATA A RIPOSO con una passphrase, e tenuta DECIFRATA solo in memoria per
// la durata della sessione dello studio. (HANDOFF-firma-artifact.md §7 — protez.
// della chiave a riposo). Sostituisce il vecchio file in chiaro `keys.rs`.
//
// Formato file (~/.flowpilot/signing-key.json):
//   { "alg":"ed25519", "keyId":"ed25519:…", "public":"<b64>",
//     "enc": { "kdf":"argon2id", "salt":"<b64>", "nonce":"<b64>",
//              "ciphertext":"<b64 del seed 32B cifrato>" } }
//   → keyId e chiave PUBBLICA restano in chiaro (servono per mostrarli e per
//     l'enrollment nel trust store); la PRIVATA è solo nel ciphertext.
//
// Crittografia: passphrase --argon2id--> chiave 32B --XChaCha20-Poly1305--> seed.
// Passphrase errata ⇒ il tag AEAD non torna ⇒ errore (nessun seed sbagliato).
//
// Limite noto: mentre è sbloccata, la chiave vive in memoria del processo; un
// malware che gira come l'utente potrebbe estrarla. La cifratura a riposo chiude
// il furto del FILE (backup, disco, altro utente), non il desktop compromesso.

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::SigningKey;
use rand_core::{OsRng, RngCore};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use argon2::Argon2;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};

/// Identità pubblica della chiave (mostrabile senza sbloccare).
pub struct Identity {
    pub key_id: String,
    pub public_b64: String,
}

pub fn default_key_path() -> PathBuf {
    super::keys::default_key_path()
}

fn identity_from_seed(seed: &[u8; 32]) -> Identity {
    let pk = SigningKey::from_bytes(seed).verifying_key().to_bytes();
    Identity { key_id: super::keys::key_id(&pk), public_b64: STANDARD.encode(pk) }
}

/// Nuovo seed casuale (chiave generata dal sistema).
pub fn generate_seed() -> [u8; 32] {
    let mut s = [0u8; 32];
    OsRng.fill_bytes(&mut s);
    s
}

/// Seed importato a mano dall'utente (base64 di 32 byte).
pub fn seed_from_b64(b64: &str) -> Result<[u8; 32], String> {
    let bytes = STANDARD
        .decode(b64.trim())
        .map_err(|_| "il seed non è base64 valido".to_string())?;
    bytes.try_into().map_err(|_| "il seed deve essere di 32 byte".to_string())
}

fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| format!("derivazione chiave (argon2): {e}"))?;
    Ok(key)
}

/// Cifra il seed con la passphrase e lo salva (0600). Restituisce l'identità.
pub fn save_encrypted(path: &Path, seed: &[u8; 32], passphrase: &str) -> Result<Identity, String> {
    if passphrase.is_empty() {
        return Err("la passphrase non può essere vuota".into());
    }
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let key = derive_key(passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|e| format!("cipher: {e}"))?;
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), seed.as_slice())
        .map_err(|_| "cifratura fallita".to_string())?;
    let id = identity_from_seed(seed);
    let doc = serde_json::json!({
        "alg": "ed25519",
        "keyId": id.key_id,
        "public": id.public_b64,
        "enc": {
            "kdf": "argon2id",
            "salt": STANDARD.encode(salt),
            "nonce": STANDARD.encode(nonce),
            "ciphertext": STANDARD.encode(&ct),
        }
    });
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(&doc).unwrap()).map_err(|e| e.to_string())?;
    restrict(path);
    Ok(id)
}

/// Legge keyId + chiave pubblica SENZA passphrase (per mostrarli).
pub fn load_identity(path: &Path) -> Option<Identity> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    Some(Identity {
        key_id: v.get("keyId")?.as_str()?.to_string(),
        public_b64: v.get("public")?.as_str()?.to_string(),
    })
}

pub fn key_exists(path: &Path) -> bool {
    path.exists()
}

/// Decifra il seed con la passphrase. Err su passphrase errata / file corrotto.
pub fn decrypt_seed(path: &Path, passphrase: &str) -> Result<[u8; 32], String> {
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let enc = v.get("enc").ok_or("file chiave senza blocco 'enc'")?;
    let field = |k: &str| -> Result<Vec<u8>, String> {
        let s = enc.get(k).and_then(|x| x.as_str()).ok_or(format!("campo '{k}' mancante"))?;
        STANDARD.decode(s).map_err(|_| format!("campo '{k}' non è base64"))
    };
    let salt = field("salt")?;
    let nonce = field("nonce")?;
    let ct = field("ciphertext")?;
    let key = derive_key(passphrase, &salt)?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|e| format!("cipher: {e}"))?;
    let pt = cipher
        .decrypt(XNonce::from_slice(&nonce), ct.as_slice())
        .map_err(|_| "passphrase errata o file danneggiato".to_string())?;
    pt.try_into().map_err(|_| "seed decifrato di lunghezza errata".to_string())
}

// ── stato SBLOCCATO in memoria (per la durata della sessione dello studio) ──
fn cell() -> &'static Mutex<Option<[u8; 32]>> {
    static C: OnceLock<Mutex<Option<[u8; 32]>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

/// Decifra e tiene la chiave in memoria per la sessione. Restituisce l'identità.
pub fn unlock(path: &Path, passphrase: &str) -> Result<Identity, String> {
    let seed = decrypt_seed(path, passphrase)?;
    let id = identity_from_seed(&seed);
    *cell().lock().unwrap() = Some(seed);
    Ok(id)
}

/// Dimentica la chiave sbloccata (ri-blocca).
pub fn lock() {
    *cell().lock().unwrap() = None;
}

pub fn is_unlocked() -> bool {
    cell().lock().unwrap().is_some()
}

/// Chiave di firma se sbloccata, altrimenti None (il chiamante chiede l'unlock).
pub fn unlocked_signing_key() -> Option<SigningKey> {
    cell().lock().unwrap().as_ref().map(SigningKey::from_bytes)
}

#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn restrict(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flowpilot-vault-{}-{:?}", std::process::id(), std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("signing-key.json")
    }

    #[test]
    fn cifra_salva_ricarica_decifra() {
        let path = tmp();
        let seed = generate_seed();
        let id = save_encrypted(&path, &seed, "correct horse").unwrap();

        // identità leggibile senza passphrase
        let id2 = load_identity(&path).unwrap();
        assert_eq!(id.key_id, id2.key_id);
        assert_eq!(id.public_b64, id2.public_b64);

        // decifra con passphrase giusta = seed originale
        assert_eq!(decrypt_seed(&path, "correct horse").unwrap(), seed);
        // passphrase errata → errore
        assert!(decrypt_seed(&path, "sbagliata").is_err());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn import_seed_base64() {
        let seed = generate_seed();
        let b64 = STANDARD.encode(seed);
        assert_eq!(seed_from_b64(&b64).unwrap(), seed);
        assert!(seed_from_b64("non-base64!!").is_err());
        assert!(seed_from_b64(&STANDARD.encode([1u8; 10])).is_err()); // lunghezza errata
    }

    #[test]
    fn unlock_lock_e_passphrase_errata() {
        // un solo test: lo stato "sbloccato" è globale al processo, quindi va
        // esercitato in sequenza (non in parallelo con altri test di unlock).
        let path = tmp();
        let seed = generate_seed();
        save_encrypted(&path, &seed, "pw").unwrap();

        lock();
        assert!(!is_unlocked());

        let id = unlock(&path, "pw").unwrap();
        assert!(is_unlocked());
        let sk = unlocked_signing_key().unwrap();
        assert_eq!(super::super::keys::key_id(&sk.verifying_key().to_bytes()), id.key_id);

        lock();
        assert!(!is_unlocked());
        assert!(unlocked_signing_key().is_none());

        // passphrase errata non sblocca
        assert!(unlock(&path, "errata").is_err());
        assert!(!is_unlocked());

        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
