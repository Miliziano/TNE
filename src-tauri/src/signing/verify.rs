// ─── src-tauri/src/signing/verify.rs ──────────────────────────────
// Verifica FAIL-CLOSED dell'artifact prima dell'esecuzione. (§9)
// Ogni fallimento (incluso "non firmato") è un Err(motivo) e il run non parte
// (P333: nessuna modalità off/warn). La policy della runtime si applica dopo,
// in `runtime::admission` (P378), che è l'unico ingresso usato dal runner.

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

    // 7) policy dei nodi pericolosi: in `runtime::admission::admit` (P378).
    let owner = trust.owner(key_id).unwrap_or_default();
    Ok(Verified { key_id: key_id.to_string(), owner })
}

/// `engineVersionRange` del manifesto contro la versione del motore (P378).
///
/// Grammatica (contratto, docs/ARCHITETTURA-coordinatore.md §4.1):
///   `*`                       qualunque motore
///   `>=0.2.0`                 un confronto: `>=` `>` `<=` `<` `=` (o nessun
///                             operatore = versione esatta)
///   `>=0.2.0 <0.3.0`          più confronti, TUTTI veri (separati da spazi o virgole)
/// Versioni `MAGGIORE.MINORE.PATCH`; un suffisso `-qualcosa` del motore si ignora.
/// Qualunque cosa non si capisca → incompatibile (fail-closed): un artifact che
/// chiede un motore che non sappiamo riconoscere non deve girare per sbaglio.
pub fn engine_compatible(range: &str, version: &str) -> bool {
    let range = range.trim();
    if range == "*" {
        return true;
    }
    let Some(v) = parse_version(version) else { return false };
    let mut any = false;
    for part in range.split(|c: char| c.is_whitespace() || c == ',').filter(|p| !p.is_empty()) {
        any = true;
        let (op, rest) = ["<=", ">=", "<", ">", "="]
            .iter()
            .find_map(|op| part.strip_prefix(op).map(|r| (*op, r)))
            .unwrap_or(("=", part));
        let Some(want) = parse_version(rest) else { return false };
        let ok = match op {
            ">=" => v >= want,
            ">" => v > want,
            "<=" => v <= want,
            "<" => v < want,
            _ => v == want,
        };
        if !ok {
            return false;
        }
    }
    any
}

fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let core = s.trim().split(['-', '+']).next()?;
    let mut it = core.split('.');
    let a = it.next()?.parse().ok()?;
    let b = it.next()?.parse().ok()?;
    let c = it.next()?.parse().ok()?;
    if it.next().is_some() {
        return None;
    }
    Some((a, b, c))
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

    #[test]
    fn engine_version_range() {
        assert!(engine_compatible("*", "0.1.0"));
        assert!(engine_compatible(" * ", "anything"));
        assert!(engine_compatible(">=0.1.0", "0.1.0"));
        assert!(engine_compatible(">=0.1.0 <0.2.0", "0.1.9"));
        assert!(engine_compatible(">=0.1.0, <0.2.0", "0.1.9"));
        assert!(!engine_compatible(">=0.1.0 <0.2.0", "0.2.0"));
        assert!(engine_compatible("0.1.0", "0.1.0-beta"));
        assert!(engine_compatible("=1.2.3", "1.2.3"));
        assert!(!engine_compatible(">0.1.0", "0.1.0"));
        assert!(engine_compatible("<=0.1.0", "0.1.0"));
        // fail-closed: sintassi sconosciuta, vuoto, versione illeggibile
        assert!(!engine_compatible("", "0.1.0"));
        assert!(!engine_compatible("^0.1", "0.1.0"));
        assert!(!engine_compatible(">=0.1", "0.1.0"));
        assert!(!engine_compatible(">=0.1.0", "dev"));
    }
}
