// ─── src-tauri/src/runtime/profile.rs ─────────────────────────────
// Profilo della runtime (P378): un file per macchina con le regole che QUESTA
// macchina impone a qualunque artifact, firmato o no. Contratto in
// docs/ARCHITETTURA-coordinatore.md §4.5.
//
//   {
//     "formatVersion": 1,
//     "description": "testo libero",
//     "policy": {
//       "deniedNodeTypes":  ["shell_exec", "ssh_exec"],
//       "allowedNodeTypes": ["source_db", "tmap", "sink_db"]   // facoltativo
//     }
//   }
//
// Dove si trova: `--profile <file>` > `FLOWPILOT_RUNTIME_PROFILE` >
// `~/.flowpilot/runtime.json`. Se il percorso è stato INDICATO e il file manca
// → errore. Se manca il file di default → profilo vuoto = nessuna restrizione,
// cioè il comportamento di prima.
//
// Sicurezza (fail-closed): il profilo restringe ciò che gira, quindi non si
// tollera nulla che non si capisca. Chiave sconosciuta, formatVersion più nuovo,
// tipo di nodo inesistente (refuso), permessi pericolosi → errore e il run non
// parte. Un profilo scritto per un runner più recente non deve perdere le sue
// restrizioni in silenzio su un runner più vecchio.

use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub const PROFILE_FORMAT_VERSION: u64 = 1;

/// Regole sui tipi di nodo. `denied` vince su `allowed`.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Policy {
    pub denied: BTreeSet<String>,
    /// `None` = tutti i tipi ammessi (salvo i vietati).
    pub allowed: Option<BTreeSet<String>>,
}

impl Policy {
    /// Il tipo è ammesso su questa runtime?
    pub fn permits(&self, node_type: &str) -> bool {
        if self.denied.contains(node_type) {
            return false;
        }
        match &self.allowed {
            Some(a) => a.contains(node_type),
            None => true,
        }
    }

    pub fn is_unrestricted(&self) -> bool {
        self.denied.is_empty() && self.allowed.is_none()
    }
}

#[derive(Debug, Default, Clone)]
pub struct RuntimeProfile {
    pub policy: Policy,
    pub description: Option<String>,
    /// File da cui è stato letto; `None` = profilo vuoto (file di default assente).
    pub source: Option<PathBuf>,
    pub warnings: Vec<String>,
}

pub fn default_profile_path() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(".flowpilot").join("runtime.json")
}

impl RuntimeProfile {
    /// Risolve il profilo secondo la precedenza documentata in testa al file.
    pub fn resolve(cli: Option<&Path>) -> Result<Self, String> {
        if let Some(p) = cli {
            return Self::open(p, true);
        }
        if let Ok(p) = std::env::var("FLOWPILOT_RUNTIME_PROFILE") {
            if !p.trim().is_empty() {
                return Self::open(Path::new(p.trim()), true);
            }
        }
        Self::open(&default_profile_path(), false)
    }

    /// `required` = il percorso è stato indicato esplicitamente: se manca è un errore.
    pub fn open(path: &Path, required: bool) -> Result<Self, String> {
        if !path.exists() {
            if required {
                return Err(format!("profilo della runtime assente ({})", path.display()));
            }
            return Ok(Self::default());
        }
        let mut warnings = crate::signing::trust::check_file_permissions(path, "profilo della runtime")?;
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("profilo della runtime illeggibile ({}): {e}", path.display()))?;
        let mut profile = Self::parse(&raw)
            .map_err(|e| format!("profilo della runtime non valido ({}): {e}", path.display()))?;
        warnings.append(&mut profile.warnings);
        profile.warnings = warnings;
        profile.source = Some(path.to_path_buf());
        Ok(profile)
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        let v: Value = serde_json::from_str(raw).map_err(|e| format!("JSON non valido: {e}"))?;
        let obj = v.as_object().ok_or("deve essere un oggetto JSON")?;
        for k in obj.keys() {
            if !matches!(k.as_str(), "formatVersion" | "description" | "policy") {
                return Err(format!("chiave sconosciuta \"{k}\": il profilo è per un runner più recente o contiene un refuso"));
            }
        }
        match obj.get("formatVersion").and_then(|v| v.as_u64()) {
            Some(PROFILE_FORMAT_VERSION) => {}
            Some(n) => return Err(format!("formatVersion {n} non supportata (questo runner legge la {PROFILE_FORMAT_VERSION}): aggiorna il runner")),
            None => return Err("manca \"formatVersion\": 1".into()),
        }
        let description = match obj.get("description") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => return Err("\"description\" deve essere un testo".into()),
        };
        let policy = match obj.get("policy") {
            None | Some(Value::Null) => Policy::default(),
            Some(p) => parse_policy(p)?,
        };
        Ok(Self { policy, description, source: None, warnings: Vec::new() })
    }
}

fn parse_policy(v: &Value) -> Result<Policy, String> {
    let obj = v.as_object().ok_or("\"policy\" deve essere un oggetto")?;
    for k in obj.keys() {
        if !matches!(k.as_str(), "deniedNodeTypes" | "allowedNodeTypes") {
            return Err(format!("chiave sconosciuta \"policy.{k}\""));
        }
    }
    let denied = match obj.get("deniedNodeTypes") {
        None | Some(Value::Null) => BTreeSet::new(),
        Some(v) => node_type_set(v, "deniedNodeTypes")?,
    };
    let allowed = match obj.get("allowedNodeTypes") {
        None | Some(Value::Null) => None,
        Some(v) => Some(node_type_set(v, "allowedNodeTypes")?),
    };
    Ok(Policy { denied, allowed })
}

fn node_type_set(v: &Value, key: &str) -> Result<BTreeSet<String>, String> {
    let arr = v.as_array().ok_or_else(|| format!("\"policy.{key}\" deve essere un elenco"))?;
    let mut out = BTreeSet::new();
    for item in arr {
        let t = item
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("\"policy.{key}\": ogni voce deve essere un tipo di nodo"))?;
        if !crate::engine::executor::NODE_TYPES.contains(&t) {
            return Err(format!("\"policy.{key}\": tipo di nodo sconosciuto \"{t}\""));
        }
        out.insert(t.to_string());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profilo_vuoto_e_policy() {
        let p = RuntimeProfile::parse(r#"{"formatVersion":1}"#).unwrap();
        assert!(p.policy.is_unrestricted());
        assert!(p.policy.permits("shell_exec"));

        let p = RuntimeProfile::parse(
            r#"{"formatVersion":1,"description":"prod","policy":{"deniedNodeTypes":["shell_exec","ssh_exec"]}}"#,
        )
        .unwrap();
        assert!(!p.policy.permits("shell_exec"));
        assert!(p.policy.permits("tmap"));
        assert_eq!(p.description.as_deref(), Some("prod"));

        let p = RuntimeProfile::parse(
            r#"{"formatVersion":1,"policy":{"allowedNodeTypes":["source_db","sink_db"],"deniedNodeTypes":["sink_db"]}}"#,
        )
        .unwrap();
        assert!(p.policy.permits("source_db"));
        assert!(!p.policy.permits("sink_db"), "il divieto vince sul permesso");
        assert!(!p.policy.permits("tmap"), "fuori dall'elenco ammesso");
    }

    #[test]
    fn fail_closed() {
        for (raw, why) in [
            (r#"{}"#, "formatVersion mancante"),
            (r#"{"formatVersion":2}"#, "formatVersion più nuova"),
            (r#"{"formatVersion":1,"limits":{}}"#, "sezione sconosciuta"),
            (r#"{"formatVersion":1,"policy":{"deny":["shell_exec"]}}"#, "chiave di policy sconosciuta"),
            (r#"{"formatVersion":1,"policy":{"deniedNodeTypes":["shell-exec"]}}"#, "refuso nel tipo"),
            (r#"{"formatVersion":1,"policy":{"deniedNodeTypes":"shell_exec"}}"#, "non è un elenco"),
            (r#"{"formatVersion":1,"policy":{"deniedNodeTypes":[""]}}"#, "voce vuota"),
            (r#"[1]"#, "non è un oggetto"),
        ] {
            assert!(RuntimeProfile::parse(raw).is_err(), "doveva fallire: {why}");
        }
    }

    #[test]
    fn file_assente() {
        let p = Path::new("/nonexistent/flowpilot/runtime.json");
        assert!(RuntimeProfile::open(p, false).unwrap().policy.is_unrestricted());
        assert!(RuntimeProfile::open(p, true).is_err(), "indicato esplicitamente → errore");
    }

    /// NODE_TYPES deve elencare esattamente i rami del `match` di `run_node`.
    #[test]
    fn node_types_allineati_al_motore() {
        let src = include_str!("../engine/executor.rs");
        let start = src.find("async fn run_node(").expect("run_node");
        let body = &src[start..];
        let arm = regex::Regex::new(r#"(?m)^\s*("[a-z_]+"(?:\s*\|\s*"[a-z_]+")*)\s*=>"#).unwrap();
        let name = regex::Regex::new(r#""([a-z_]+)""#).unwrap();
        let mut in_match: BTreeSet<String> = BTreeSet::new();
        for c in arm.captures_iter(body) {
            for n in name.captures_iter(&c[1]) {
                in_match.insert(n[1].to_string());
            }
        }
        let listed: BTreeSet<String> =
            crate::engine::executor::NODE_TYPES.iter().map(|s| s.to_string()).collect();
        assert_eq!(listed, in_match, "aggiorna NODE_TYPES in engine/executor.rs");
    }
}
