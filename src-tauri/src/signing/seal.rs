// ─── src-tauri/src/signing/seal.rs ────────────────────────────────
// Costruisce il MANIFESTO firmato dell'artifact e lo firma. (HANDOFF-firma-
// artifact.md §5). Restituisce { manifest, sig, publicKey }, che lo studio
// incorpora nella busta .ffart accanto al piano.
//
// Il planHash del manifesto è RICALCOLATO qui dal piano (autorità Rust), non
// preso dallo studio: la firma copre un hash che il runner potrà a sua volta
// ricalcolare e confrontare.

use super::canonical::plan_hash;
use super::keys::{self, Keypair};
use super::sign::sign_manifest;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

/// Costruisce e firma il manifesto con una coppia di chiavi data (pura, no IO).
pub fn seal_with(plan: &Value, meta: &Value, kp: &Keypair) -> Value {
    let manifest = json!({
        "planHash":           plan_hash(plan),
        "hashAlg":            "sha256",
        "sigAlg":             "ed25519",
        "keyId":              kp.key_id,
        "engineVersionRange": meta.get("engineVersionRange").cloned().unwrap_or(Value::from("*")),
        "createdAt":          meta.get("createdAt").cloned().unwrap_or(Value::Null),
    });
    let sig = sign_manifest(&manifest, &kp.signing);
    json!({ "manifest": manifest, "sig": sig, "publicKey": kp.public_b64 })
}

/// Firma con la chiave SBLOCCATA in memoria (vault). Se è bloccata, lo studio
/// deve prima chiedere la passphrase all'utente.
pub fn seal(plan: &Value, meta: &Value) -> Result<Value, String> {
    let signing = super::vault::unlocked_signing_key()
        .ok_or_else(|| "chiave di firma bloccata: inserisci la passphrase".to_string())?;
    let pk = signing.verifying_key().to_bytes();
    let kp = Keypair {
        key_id: keys::key_id(&pk),
        public_b64: STANDARD.encode(pk),
        signing,
    };
    Ok(seal_with(plan, meta, &kp))
}

#[cfg(test)]
mod tests {
    use super::super::sign::verify_manifest;
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ed25519_dalek::SigningKey;

    fn kp(seed: u8) -> Keypair {
        let sk = SigningKey::from_bytes(&[seed; 32]);
        let pk = sk.verifying_key().to_bytes();
        Keypair { key_id: keys::key_id(&pk), public_b64: STANDARD.encode(pk), signing: sk }
    }

    #[test]
    fn busta_firmata_e_verificabile() {
        let plan = json!({"run_id":"export-1","lanes":[],"bridges":[]});
        let meta = json!({"engineVersionRange":"*","createdAt":"2026-09-16T00:00:00Z"});
        let sealed = seal_with(&plan, &meta, &kp(5));
        assert!(verify_manifest(
            &sealed["manifest"],
            sealed["sig"].as_str().unwrap(),
            sealed["publicKey"].as_str().unwrap()
        ));
        assert_eq!(sealed["manifest"]["planHash"], json!(plan_hash(&plan)));
        // run_id del piano non influisce sul planHash firmato
        let mut plan2 = plan.clone();
        plan2["run_id"] = json!("export-DIVERSO");
        let sealed2 = seal_with(&plan2, &meta, &kp(5));
        assert_eq!(sealed["manifest"]["planHash"], sealed2["manifest"]["planHash"]);
    }
}
