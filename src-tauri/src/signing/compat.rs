// ─── src-tauri/src/signing/compat.rs ──────────────────────────────
// VETTORI DI COMPATIBILITA' (P340). Generati con le versioni crittografiche in
// uso fino al P339 (ed25519-dalek 2, sha2 0.10, argon2 0.5, chacha20poly1305
// 0.10). Ogni aggiornamento delle crate deve continuare a:
//  1. aprire una chiave di firma cifrata a riposo con quelle versioni
//     (altrimenti gli sviluppatori resterebbero chiusi fuori dalla loro chiave);
//  2. produrre la STESSA firma e lo STESSO manifesto (Ed25519 e' deterministica)
//     e verificare quelli vecchi (altrimenti gli artifact gia' firmati e i trust
//     store gia' distribuiti smetterebbero di funzionare).
// Se uno di questi test fallisce dopo un aggiornamento, NON si aggiornano i
// vettori: si corregge il codice.

#[cfg(test)]
mod tests {
    use super::super::{keys, seal::seal_with, sign::verify_manifest, vault};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ed25519_dalek::SigningKey;
    use serde_json::{json, Value};

    const VAULT_FILE: &str = r#"{
  "alg": "ed25519",
  "keyId": "ed25519:fe812c12f3ab4ce6ac5db69ac352f906cb1b11ef43fb33e252ef7ff552263889",
  "public": "6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=",
  "enc": {
    "kdf": "argon2id",
    "salt": "C9w+UVE8+N80fxMRL1dqGA==",
    "nonce": "aaVRGq5uOkzhryx8o5cOKSw8nu9nIQZX",
    "ciphertext": "u36gLVld6jw/3q72zDAz/ioCJ9zHdMkxOw8UU06hG/CoUFWiE8StbsCiLSN8GvQ4"
  }
}"#;
    const PLAN: &str = r#"{"run_id": "export-vettore", "lanes": [{"lane_id": "L", "label": "à è", "nodes": [], "edges": [], "variables": {"n": 1.5}}], "bridges": []}"#;
    const MANIFEST: &str = r#"{"planName": "vettore", "createdAt": "2026-10-17T00:00:00Z", "planHash": "sha256:cde031b9a678a27340dcd80afb0e1e9086fe946ee685116ddaac112c796710f7", "hashAlg": "sha256", "sigAlg": "ed25519", "keyId": "ed25519:b600306cfa76723fdec395e53a9b3d9fdb78b1e2d7a23c32fcbcd2dc6d0c4092", "engineVersionRange": "*"}"#;
    const SIG: &str = "6yKxqdfOT463IpdfBU87reN2qZtZkngvZzbBugcXCuvXNDdSQId2cl0ApqkFYnJuyF3rV7sQKrHMqt9MTBvFAQ==";
    const PUBLIC: &str = "GX9rI+FshTLGq8g4+s1ep4m+DHaykgM0A5v6iz02jWE=";

    #[test]
    fn chiave_cifrata_con_le_versioni_precedenti_si_apre() {
        let dir = std::env::temp_dir().join(format!("flowpilot-compat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("signing-key.json");
        std::fs::write(&path, VAULT_FILE).unwrap();
        let seed = vault::decrypt_seed(&path, "passphrase-di-prova").expect("la chiave vecchia deve aprirsi");
        assert_eq!(seed, [7u8; 32]);
        assert!(vault::decrypt_seed(&path, "sbagliata").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn firma_e_manifesto_identici_alle_versioni_precedenti() {
        let sk = SigningKey::from_bytes(&[42u8; 32]);
        let pk = sk.verifying_key().to_bytes();
        assert_eq!(STANDARD.encode(pk), PUBLIC);
        let kp = keys::Keypair { key_id: keys::key_id(&pk), public_b64: STANDARD.encode(pk), signing: sk };
        let plan: Value = serde_json::from_str(PLAN).unwrap();
        let sealed = seal_with(&plan, &json!({"planName": "vettore", "createdAt": "2026-10-17T00:00:00Z"}), &kp);
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        assert_eq!(sealed["manifest"], manifest, "manifesto (planHash/keyId) cambiato");
        assert_eq!(sealed["sig"].as_str().unwrap(), SIG, "firma cambiata");
        assert!(verify_manifest(&manifest, SIG, PUBLIC), "una firma vecchia deve verificare");
    }
}
