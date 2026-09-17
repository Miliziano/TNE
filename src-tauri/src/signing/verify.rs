// ─── src-tauri/src/signing/verify.rs ──────────────────────────────
// Verifica FAIL-CLOSED dell'artifact prima dell'esecuzione. (§9)
// Ogni fallimento (incluso "non firmato") è un Err(motivo); il chiamante
// (runner) decide che farne secondo la modalità off/warn/enforce.

use super::canonical::plan_hash;
use super::sign::verify_manifest;
use super::trust::TrustStore;
use serde_json::Value;

pub struct Verified {
    pub key_id: String,
    pub owner: String,
}

/// Esegue i controlli nell'ordine di §9. Non ha effetti collaterali.
pub fn verify_artifact(
    root: &Value,
    engine_version: &str,
    trust: &TrustStore,
) -> Result<Verified, String> {
    // 1) formato + presenza busta firmata
    let fv = root.get("formatVersion").and_then(|v| v.as_u64()).unwrap_or(0);
    let manifest = root.get("manifest");
    let sig = root.get("sig").and_then(|v| v.as_str());
    let (manifest, sig) = match (manifest, sig) {
        (Some(m), Some(s)) if fv >= 2 => (m, s),
        _ => return Err("artifact non firmato (manca manifest/sig o formatVersion < 2)".into()),
    };

    // 2) compatibilità del motore
    let range = manifest.get("engineVersionRange").and_then(|v| v.as_str()).unwrap_or("*");
    if !engine_compatible(range, engine_version) {
        return Err(format!(
            "motore incompatibile: artifact per '{range}', runner '{engine_version}'"
        ));
    }

    // 3+4) keyId presente e ATTIVO nel trust store → chiave pubblica autorizzata
    let key_id = manifest.get("keyId").and_then(|v| v.as_str()).unwrap_or("");
    let pubkey = match trust.authorized_key(key_id) {
        Some(pk) => pk,
        None => {
            return Err(format!(
                "chiave non autorizzata: '{key_id}' assente o revocata nel trust store"
            ))
        }
    };

    // 5) firma valida — verificata con la chiave del TRUST STORE (non con la
    //    publicKey eventualmente incorporata nell'artifact, che non è fidata)
    if !verify_manifest(manifest, sig, &pubkey) {
        return Err("firma del manifesto non valida".into());
    }

    // 6) integrità: planHash ricalcolato dal piano == quello firmato
    let plan = root.get("plan").ok_or_else(|| "piano assente".to_string())?;
    let recomputed = plan_hash(plan);
    let declared = manifest.get("planHash").and_then(|v| v.as_str()).unwrap_or("");
    if recomputed != declared {
        return Err(format!(
            "planHash non combacia (piano manomesso): firmato {declared}, calcolato {recomputed}"
        ));
    }

    // 7) policy dei nodi pericolosi: non applicata in v1 (capitolo sandbox).
    let owner = trust.owner(key_id).unwrap_or_default();
    Ok(Verified { key_id: key_id.to_string(), owner })
}

/// v1: accetta solo "*" (qualsiasi motore). Il matching di versioni reali
/// arriverà quando definiremo lo schema di versione del motore; fino ad allora
/// un range diverso da "*" è considerato incompatibile (fail-closed).
fn engine_compatible(range: &str, _version: &str) -> bool {
    range == "*"
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::keys::{self, Keypair};
    use super::super::seal::seal_with;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ed25519_dalek::SigningKey;
    use serde_json::json;

    fn kp(seed: u8) -> Keypair {
        let sk = SigningKey::from_bytes(&[seed; 32]);
        let pk = sk.verifying_key().to_bytes();
        Keypair { key_id: keys::key_id(&pk), public_b64: STANDARD.encode(pk), signing: sk }
    }

    // Costruisce una busta .ffart firmata (come farebbe lo studio).
    fn sealed_root(kp: &Keypair, plan: &Value) -> Value {
        let sealed = seal_with(plan, &json!({ "engineVersionRange": "*", "createdAt": "t" }), kp);
        json!({
            "formatVersion": 2,
            "manifest": sealed["manifest"],
            "sig": sealed["sig"],
            "publicKey": sealed["publicKey"],
            "plan": plan
        })
    }

    fn trust_with(kp: &Keypair, status: &str) -> TrustStore {
        let dir = std::env::temp_dir().join(format!("flowpilot-verify-{}-{}", std::process::id(), status));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("trust-store.json");
        std::fs::write(&path, serde_json::to_vec(&json!({ "keys": [
            { "keyId": kp.key_id, "publicKey": kp.public_b64, "owner": "marco", "status": status }
        ] })).unwrap()).unwrap();
        TrustStore::load_at(&path)
    }

    #[test]
    fn artifact_valido_verifica() {
        let k = kp(5);
        let plan = json!({ "run_id": "export-1", "lanes": [], "bridges": [] });
        let root = sealed_root(&k, &plan);
        let v = verify_artifact(&root, "0.1.0", &trust_with(&k, "active")).unwrap();
        assert_eq!(v.key_id, k.key_id);
        assert_eq!(v.owner, "marco");
    }

    #[test]
    fn chiave_non_nel_trust_store() {
        let k = kp(5);
        let plan = json!({ "run_id": "x", "lanes": [], "bridges": [] });
        let root = sealed_root(&k, &plan);
        let other = trust_with(&kp(9), "active"); // trust store con un'altra chiave
        assert!(verify_artifact(&root, "0.1.0", &other).is_err());
    }

    #[test]
    fn chiave_revocata() {
        let k = kp(5);
        let plan = json!({ "run_id": "x", "lanes": [], "bridges": [] });
        let root = sealed_root(&k, &plan);
        assert!(verify_artifact(&root, "0.1.0", &trust_with(&k, "revoked")).is_err());
    }

    #[test]
    fn piano_manomesso_dopo_la_firma() {
        let k = kp(5);
        let plan = json!({ "run_id": "x", "lanes": [], "bridges": [] });
        let mut root = sealed_root(&k, &plan);
        // altero il piano: il planHash ricalcolato non combacerà più
        root["plan"]["lanes"] = json!([{ "lane_id": "iniettata" }]);
        assert!(verify_artifact(&root, "0.1.0", &trust_with(&k, "active")).is_err());
    }

    #[test]
    fn artifact_non_firmato() {
        let plan = json!({ "run_id": "x", "lanes": [], "bridges": [] });
        let root = json!({ "formatVersion": 1, "plan": plan });
        assert!(verify_artifact(&root, "0.1.0", &trust_with(&kp(5), "active")).is_err());
    }
}
