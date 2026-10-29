// ─── src-tauri/src/runtime/admission.rs ───────────────────────────
// Ammissione di un artifact su questa runtime (P378): l'UNICO ingresso.
// Lo usa il runner oggi; lo useranno l'agente (una volta per deployment) e il
// coordinatore (anteprima: "questo artifact girerebbe su quella runtime?").
//
// Ordine (fail-closed, ogni errore = rifiuto, uscita 3 nel runner):
//   1-6  firma, compatibilità del motore, chiave autorizzata, integrità del
//        piano — signing::verify (HANDOFF-firma-artifact.md §9)
//   7    policy della runtime sui tipi di nodo (profile.rs)
//   8    configurazione: valori solo per variabili dichiarate nel manifesto
//        firmato, nei loro vincoli (config.rs, P380)
//
// Nessun effetto collaterale: nessun file scritto, nessuna rete, nessun
// segreto risolto. Costo: una verifica Ed25519 + un hash del piano, una volta
// per artifact — mai per riga (§8: ammissione ≠ esecuzione).

use super::config::{self, Resolved, RunConfig};
use super::profile::RuntimeProfile;
use crate::signing::trust::TrustStore;
use crate::signing::verify::verify_artifact;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

/// Esito positivo: chi ha firmato e cosa contiene, per log, eventi e agente.
#[derive(Debug, Clone)]
pub struct Admitted {
    pub key_id: String,
    pub owner: String,
    pub plan_hash: String,
    pub plan_name: Option<String>,
    pub node_types: BTreeSet<String>,
    /// Valori delle variabili configurabili per questo run (default + configurazione).
    pub config: Resolved,
}

impl Admitted {
    /// Riepilogo leggibile da una macchina (stdout di `--admit-only`).
    pub fn to_json(&self) -> Value {
        json!({
            "admitted":  true,
            "keyId":     self.key_id,
            "owner":     self.owner,
            "planHash":  self.plan_hash,
            "planName":  self.plan_name,
            "nodeTypes": self.node_types,
            "configuration": self.config.summary(),
        })
    }
}

pub fn admit(
    root: &Value,
    engine_version: &str,
    trust: &TrustStore,
    profile: &RuntimeProfile,
    run_config: Option<&RunConfig>,
) -> Result<Admitted, String> {
    let verified = verify_artifact(root, engine_version, trust)?;
    let manifest = root.get("manifest").cloned().unwrap_or(Value::Null);
    let plan = root.get("plan").ok_or("piano assente")?;

    // Tipi di nodo del piano, con le etichette di chi li usa (per un messaggio
    // che dica DOVE sta il nodo vietato, non solo che c'è).
    let mut used: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for lane in plan.get("lanes").and_then(|l| l.as_array()).into_iter().flatten() {
        for node in lane.get("nodes").and_then(|n| n.as_array()).into_iter().flatten() {
            let t = node.get("node_type").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let label = node
                .get("label")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| node.get("node_id").and_then(|v| v.as_str()))
                .unwrap_or("?")
                .to_string();
            used.entry(t).or_default().push(label);
        }
    }

    let blocked: Vec<String> = used
        .iter()
        .filter(|(t, _)| !profile.policy.permits(t))
        .map(|(t, labels)| format!("{t} ({})", labels.join(", ")))
        .collect();
    if !blocked.is_empty() {
        let source = profile
            .source
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "profilo".into());
        return Err(format!(
            "policy della runtime: tipi di nodo non ammessi su questa macchina — {} [{}]",
            blocked.join("; "),
            source
        ));
    }

    let declared = config::declared_variables(&manifest)?;
    let resolved = config::resolve(&declared, run_config)?;

    Ok(Admitted {
        config: resolved,
        key_id: verified.key_id,
        owner: verified.owner,
        plan_hash: manifest.get("planHash").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        plan_name: manifest.get("planName").and_then(|v| v.as_str()).map(|s| s.to_string()),
        node_types: used.into_keys().filter(|t| !t.is_empty()).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::signing::keys::{self, Keypair};
    use crate::signing::seal::seal_with;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ed25519_dalek::SigningKey;

    fn kp() -> Keypair {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk = sk.verifying_key().to_bytes();
        Keypair { key_id: keys::key_id(&pk), public_b64: STANDARD.encode(pk), signing: sk }
    }

    fn artifact(kp: &Keypair, range: &str) -> Value {
        let plan = json!({ "run_id": "export-1", "bridges": [], "lanes": [{
            "lane_id": "l1", "label": "L", "edges": [], "variables": {},
            "nodes": [
                { "node_id": "n1", "node_type": "source_file", "label": "Ordini", "config": {} },
                { "node_id": "n2", "node_type": "shell_exec",  "label": "Pulizia", "config": {} },
            ]
        }]});
        let sealed = seal_with(&plan, &json!({ "engineVersionRange": range, "createdAt": "t", "planName": "demo" }), kp);
        json!({ "formatVersion": 2, "manifest": sealed["manifest"], "sig": sealed["sig"], "plan": plan })
    }

    fn trust(kp: &Keypair) -> TrustStore {
        TrustStore::parse(
            &json!({ "keys": [{ "keyId": kp.key_id, "publicKey": kp.public_b64, "owner": "marco", "status": "active" }] })
                .to_string(),
        )
        .unwrap()
    }

    #[test]
    fn ammesso_senza_policy() {
        let k = kp();
        let a = admit(&artifact(&k, "*"), "0.1.0", &trust(&k), &RuntimeProfile::default(), None).unwrap();
        assert_eq!(a.owner, "marco");
        assert_eq!(a.plan_name.as_deref(), Some("demo"));
        assert!(a.node_types.contains("shell_exec"));
        assert!(!a.plan_hash.is_empty());
    }

    #[test]
    fn policy_rifiuta_e_dice_dove() {
        let k = kp();
        let profile = RuntimeProfile::parse(r#"{"formatVersion":1,"policy":{"deniedNodeTypes":["shell_exec"]}}"#).unwrap();
        let err = admit(&artifact(&k, "*"), "0.1.0", &trust(&k), &profile, None).unwrap_err();
        assert!(err.contains("shell_exec (Pulizia)"), "{err}");

        let only = RuntimeProfile::parse(r#"{"formatVersion":1,"policy":{"allowedNodeTypes":["source_file"]}}"#).unwrap();
        assert!(admit(&artifact(&k, "*"), "0.1.0", &trust(&k), &only, None).is_err());
    }

    #[test]
    fn motore_incompatibile() {
        let k = kp();
        let p = RuntimeProfile::default();
        assert!(admit(&artifact(&k, ">=0.2.0"), "0.1.0", &trust(&k), &p, None).is_err());
        assert!(admit(&artifact(&k, ">=0.1.0 <0.2.0"), "0.1.5", &trust(&k), &p, None).is_ok());
    }

    /// Contratto dell'artifact (P379): `vectors/artifact_v2.ffart`, firmato una
    /// volta e mai più rigenerato. Ogni versione futura del runner deve
    /// ammetterlo così com'è; se il test fallisce si corregge il codice.
    #[test]
    fn vettore_artifact_v2() {
        let art: Value = serde_json::from_str(include_str!("../../../vectors/artifact_v2.ffart")).unwrap();
        let trust = TrustStore::parse(include_str!("../../../vectors/artifact_v2_trust_store.json")).unwrap();
        let a = admit(&art, "0.1.0", &trust, &RuntimeProfile::default(), None).expect("il vettore deve essere ammesso");
        assert_eq!(a.owner, "vettore");
        assert_eq!(a.plan_name.as_deref(), Some("vettore-artifact"));
        assert_eq!(a.node_types.iter().cloned().collect::<Vec<_>>(), vec!["sink_file", "source_file"]);

        // piano toccato → planHash non combacia
        let mut t = art.clone();
        t["plan"]["lanes"][0]["variables"]["SOGLIA"] = json!(11);
        assert!(admit(&t, "0.1.0", &trust, &RuntimeProfile::default(), None).unwrap_err().contains("planHash"));
        // manifesto toccato → firma non valida
        let mut t = art.clone();
        t["manifest"]["logLevel"] = json!("diagnostico");
        assert!(admit(&t, "0.1.0", &trust, &RuntimeProfile::default(), None).unwrap_err().contains("firma"));
    }

    /// P380: artifact con variabili configurabili (`vectors/artifact_v2_config.ffart`).
    #[test]
    fn vettore_artifact_config() {
        let art: Value = serde_json::from_str(include_str!("../../../vectors/artifact_v2_config.ffart")).unwrap();
        let trust = TrustStore::parse(include_str!("../../../vectors/artifact_v2_trust_store.json")).unwrap();
        let p = RuntimeProfile::default();
        // chiede un motore >= 0.2.0
        assert!(admit(&art, "0.1.0", &trust, &p, None).unwrap_err().contains("motore incompatibile"));
        let a = admit(&art, "0.2.0", &trust, &p, None).unwrap();
        assert_eq!(a.config.values["DB_HOST"], "db.test.interno");
        let c = RunConfig::parse(r#"{"values":{"DB_HOST":"db.prod.interno"}}"#).unwrap();
        let a = admit(&art, "0.2.0", &trust, &p, Some(&c)).unwrap();
        let mut plan = art["plan"].clone();
        config::apply(&mut plan, &a.config);
        assert_eq!(plan["lanes"][0]["nodes"][0]["spec"]["resource"]["host"], "db.prod.interno");
        assert_eq!(plan["lanes"][0]["nodes"][0]["spec"]["resource"]["password"], "${DB_PASSWORD}");
        let bad = RunConfig::parse(r#"{"values":{"DB_HOST":"evil.example.com"}}"#).unwrap();
        assert!(admit(&art, "0.2.0", &trust, &p, Some(&bad)).is_err());
    }
}
