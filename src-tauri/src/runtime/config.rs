// ─── src-tauri/src/runtime/config.rs ──────────────────────────────
// Configurazione separata dall'artifact (P380, fase 2 di
// docs/ARCHITETTURA-coordinatore.md, decisione D7).
//
// L'artifact FIRMATO dichiara nel manifesto le variabili configurabili:
//
//   "variables": {
//     "SOGLIA":  { "type": "number",  "default": "10", "min": 0, "max": 1000 },
//     "DB_HOST": { "type": "string",  "default": "db.test.interno",
//                  "pattern": "[a-z0-9.-]+\\.interno" },
//     "LIVELLO": { "type": "string",  "default": "base", "allowed": ["base", "pieno"] }
//   }
//
// Al run un file di configurazione (`--config <file>`, o FLOWPILOT_CONFIG) può
// cambiarne i valori, nel formato dell'export dei profili dello studio (P152):
//
//   { "profile": "prod", "values": { "SOGLIA": "50", "DB_HOST": "db.prod.interno" } }
//
// Regole di sicurezza (concordate il 29 ottobre):
//   1. Solo variabili DICHIARATE nell'artifact firmato; le altre → rifiuto.
//   2. Tipo e vincoli (allowed/min/max/pattern) sono nel manifesto firmato;
//      un valore fuori dai vincoli → rifiuto, prima di processare una riga.
//   3. I valori sono DATI: finiscono nelle variabili di lane (lette da var() e
//      dai percorsi "da variabile") e nei campi delle risorse al posto di
//      `${NOME}`; mai nel testo di un'espressione o di una query. Caratteri di
//      controllo (a capo compreso) sempre rifiutati.
//   4. Il file è controllato come il trust store (permessi, JSON rigoroso).
//   5. L'impronta dei valori usati va nell'intestazione del log.
//
// Rappresentazione: lo studio scrive i valori delle variabili come TESTO nel
// piano; qui si fa lo stesso, così un valore da configurazione si comporta
// esattamente come lo stesso valore congelato alla compilazione.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub enum VarType {
    String,
    Number,
    Boolean,
    Json,
}

/// Una variabile configurabile, come dichiarata nel manifesto firmato.
#[derive(Debug, Clone)]
pub struct Declared {
    pub ty: VarType,
    pub default: String,
    pub allowed: Option<Vec<String>>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub pattern: Option<regex::Regex>,
}

/// Legge `manifest.variables`. Assente → nessuna variabile configurabile.
/// Una chiave di vincolo sconosciuta è un errore: l'artifact chiede un controllo
/// che questo runner non sa fare, e non va ignorato.
pub fn declared_variables(manifest: &Value) -> Result<BTreeMap<String, Declared>, String> {
    let Some(vars) = manifest.get("variables") else { return Ok(BTreeMap::new()) };
    if vars.is_null() {
        return Ok(BTreeMap::new());
    }
    let obj = vars.as_object().ok_or("manifest.variables deve essere un oggetto")?;
    let mut out = BTreeMap::new();
    for (name, d) in obj {
        let d = d.as_object().ok_or_else(|| format!("variabile {name}: dichiarazione non valida"))?;
        for k in d.keys() {
            if !matches!(k.as_str(), "type" | "default" | "allowed" | "min" | "max" | "pattern") {
                return Err(format!("variabile {name}: vincolo sconosciuto \"{k}\" (artifact per un runner più recente)"));
            }
        }
        let ty = match d.get("type").and_then(|v| v.as_str()) {
            Some("string") => VarType::String,
            Some("number") => VarType::Number,
            Some("boolean") => VarType::Boolean,
            Some("json") => VarType::Json,
            other => return Err(format!("variabile {name}: tipo non supportato {other:?}")),
        };
        let default = d
            .get("default")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("variabile {name}: manca il valore di default (testo)"))?
            .to_string();
        let allowed = match d.get("allowed") {
            None | Some(Value::Null) => None,
            Some(Value::Array(a)) => Some(
                a.iter()
                    .map(|v| v.as_str().map(str::to_string).ok_or_else(|| format!("variabile {name}: \"allowed\" deve contenere testi")))
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            Some(_) => return Err(format!("variabile {name}: \"allowed\" deve essere un elenco")),
        };
        let num = |k: &str| -> Result<Option<f64>, String> {
            match d.get(k) {
                None | Some(Value::Null) => Ok(None),
                Some(v) => v.as_f64().map(Some).ok_or_else(|| format!("variabile {name}: \"{k}\" deve essere un numero")),
            }
        };
        let (min, max) = (num("min")?, num("max")?);
        if (min.is_some() || max.is_some()) && ty != VarType::Number {
            return Err(format!("variabile {name}: min/max valgono solo per il tipo number"));
        }
        let pattern = match d.get("pattern") {
            None | Some(Value::Null) => None,
            Some(Value::String(p)) => {
                if ty != VarType::String {
                    return Err(format!("variabile {name}: pattern vale solo per il tipo string"));
                }
                // Ancorato: il valore INTERO deve rispettarlo, non una sua parte.
                Some(regex::Regex::new(&format!("^(?:{p})$")).map_err(|e| format!("variabile {name}: pattern non valido: {e}"))?)
            }
            Some(_) => return Err(format!("variabile {name}: \"pattern\" deve essere un testo")),
        };
        let decl = Declared { ty, default, allowed, min, max, pattern };
        // Anche il default deve rispettare i vincoli: altrimenti l'artifact è incoerente.
        check_value(name, &decl, &decl.default).map_err(|e| format!("{e} (valore di default)"))?;
        out.insert(name.clone(), decl);
    }
    Ok(out)
}

/// Controlla un valore (in forma di testo) contro tipo e vincoli.
fn check_value(name: &str, d: &Declared, v: &str) -> Result<(), String> {
    if v.chars().any(|c| c.is_control()) {
        return Err(format!("variabile {name}: il valore contiene caratteri di controllo"));
    }
    // Un `${…}` dentro un valore verrebbe poi risolto come SEGRETO quando il
    // valore finisce in una risorsa: un file di configurazione potrebbe così
    // far leggere una variabile d'ambiente qualsiasi e mandarla, per esempio,
    // nel nome dell'host. I valori sono dati: niente riferimenti.
    if v.contains("${") {
        return Err(format!("variabile {name}: il valore non può contenere riferimenti ${{…}}"));
    }
    match d.ty {
        VarType::String => {}
        VarType::Number => {
            let n: f64 = v.trim().parse().map_err(|_| format!("variabile {name}: \"{v}\" non è un numero"))?;
            if !n.is_finite() {
                return Err(format!("variabile {name}: \"{v}\" non è un numero finito"));
            }
            if d.min.is_some_and(|m| n < m) || d.max.is_some_and(|m| n > m) {
                return Err(format!("variabile {name}: {v} fuori dall'intervallo ammesso [{}, {}]",
                    d.min.map(|m| m.to_string()).unwrap_or("-∞".into()),
                    d.max.map(|m| m.to_string()).unwrap_or("+∞".into())));
            }
        }
        VarType::Boolean => {
            if v != "true" && v != "false" {
                return Err(format!("variabile {name}: \"{v}\" non è true/false"));
            }
        }
        VarType::Json => {
            serde_json::from_str::<Value>(v).map_err(|e| format!("variabile {name}: JSON non valido: {e}"))?;
        }
    }
    if let Some(a) = &d.allowed {
        if !a.iter().any(|x| x == v) {
            return Err(format!("variabile {name}: \"{v}\" non è fra i valori ammessi ({})", a.join(", ")));
        }
    }
    if let Some(p) = &d.pattern {
        if !p.is_match(v) {
            return Err(format!("variabile {name}: \"{v}\" non rispetta il formato richiesto"));
        }
    }
    Ok(())
}

/// Il file di configurazione letto (non ancora confrontato con l'artifact).
#[derive(Debug, Clone, Default)]
pub struct RunConfig {
    pub profile: Option<String>,
    pub values: BTreeMap<String, String>,
    pub source: Option<PathBuf>,
    pub warnings: Vec<String>,
}

impl RunConfig {
    /// `--config` > FLOWPILOT_CONFIG > nessuna configurazione (valori di default).
    pub fn resolve(cli: Option<&Path>) -> Result<Option<Self>, String> {
        if let Some(p) = cli {
            return Self::open(p).map(Some);
        }
        match std::env::var("FLOWPILOT_CONFIG") {
            Ok(p) if !p.trim().is_empty() => Self::open(Path::new(p.trim())).map(Some),
            _ => Ok(None),
        }
    }

    pub fn open(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Err(format!("configurazione assente ({})", path.display()));
        }
        let mut warnings = crate::signing::trust::check_file_permissions(path, "configurazione")?;
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("configurazione illeggibile ({}): {e}", path.display()))?;
        let mut c = Self::parse(&raw).map_err(|e| format!("configurazione non valida ({}): {e}", path.display()))?;
        warnings.append(&mut c.warnings);
        c.warnings = warnings;
        c.source = Some(path.to_path_buf());
        Ok(c)
    }

    pub fn parse(raw: &str) -> Result<Self, String> {
        let v: Value = serde_json::from_str(raw).map_err(|e| format!("JSON non valido: {e}"))?;
        let obj = v.as_object().ok_or("deve essere un oggetto JSON")?;
        for k in obj.keys() {
            if !matches!(k.as_str(), "profile" | "values") {
                return Err(format!("chiave sconosciuta \"{k}\""));
            }
        }
        let profile = match obj.get("profile") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => return Err("\"profile\" deve essere un testo".into()),
        };
        let mut values = BTreeMap::new();
        if let Some(vals) = obj.get("values") {
            let vals = vals.as_object().ok_or("\"values\" deve essere un oggetto")?;
            for (k, v) in vals {
                // Il formato dello studio usa testi; numeri e booleani JSON si
                // accettano e si portano alla stessa forma testuale.
                let s = match v {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    Value::Bool(b) => b.to_string(),
                    _ => return Err(format!("valore di {k}: usa un testo, un numero o true/false")),
                };
                values.insert(k.clone(), s);
            }
        }
        Ok(Self { profile, values, source: None, warnings: Vec::new() })
    }
}

/// Valori effettivi del run: default dell'artifact + configurazione, validati.
#[derive(Debug, Clone, Default)]
pub struct Resolved {
    pub values: BTreeMap<String, String>,
    /// Nomi i cui valori vengono dalla configurazione (non dal default).
    pub overridden: Vec<String>,
    pub profile: Option<String>,
    pub source: Option<PathBuf>,
}

impl Resolved {
    /// Impronta dei valori usati (sha256 del JSON ordinato): registrata nel log
    /// accanto al planHash, dice con quali valori è girato il codice firmato
    /// senza scrivere i valori stessi.
    pub fn hash(&self) -> String {
        let canon = serde_json::to_string(&self.values).unwrap_or_default();
        format!("sha256:{}", hex::encode(Sha256::digest(canon.as_bytes())))
    }

    pub fn summary(&self) -> Value {
        serde_json::json!({
            "source":     self.source.as_ref().map(|p| p.display().to_string()),
            "profile":    self.profile,
            "hash":       self.hash(),
            "overridden": self.overridden,
        })
    }
}

pub fn resolve(declared: &BTreeMap<String, Declared>, config: Option<&RunConfig>) -> Result<Resolved, String> {
    let mut r = Resolved::default();
    for (name, d) in declared {
        r.values.insert(name.clone(), d.default.clone());
    }
    if let Some(c) = config {
        r.profile = c.profile.clone();
        r.source = c.source.clone();
        let undeclared: Vec<&String> = c.values.keys().filter(|k| !declared.contains_key(*k)).collect();
        if !undeclared.is_empty() {
            let names = undeclared.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
            return Err(if declared.is_empty() {
                format!("configurazione: l'artifact non dichiara variabili configurabili, valori non ammessi: {names}")
            } else {
                format!("configurazione: variabili non configurabili in questo artifact: {names}")
            });
        }
        for (name, v) in &c.values {
            check_value(name, &declared[name], v)?;
            r.values.insert(name.clone(), v.clone());
            r.overridden.push(name.clone());
        }
    }
    Ok(r)
}

/// Applica i valori al piano GIÀ AMMESSO (in memoria; il planHash firmato è
/// già stato verificato sul piano originale):
///  - variabili di lane: il valore sostituisce quello congelato;
///  - campi delle risorse (`spec.resource`): `${NOME}` → valore, solo per le
///    variabili dichiarate. Gli altri `${…}` restano ai segreti, come prima.
pub fn apply(plan: &mut Value, resolved: &Resolved) {
    if resolved.values.is_empty() {
        return;
    }
    let Some(lanes) = plan.get_mut("lanes").and_then(|l| l.as_array_mut()) else { return };
    for lane in lanes {
        if let Some(vars) = lane.get_mut("variables").and_then(|v| v.as_object_mut()) {
            for (k, v) in &resolved.values {
                vars.insert(k.clone(), Value::String(v.clone()));
            }
        }
        let Some(nodes) = lane.get_mut("nodes").and_then(|n| n.as_array_mut()) else { continue };
        for node in nodes {
            if let Some(res) = node.get_mut("spec").and_then(|s| s.get_mut("resource")).and_then(|r| r.as_object_mut()) {
                substitute(res, &resolved.values);
            }
        }
    }
}

fn substitute(obj: &mut Map<String, Value>, values: &BTreeMap<String, String>) {
    for v in obj.values_mut() {
        if let Value::String(s) = v {
            if s.contains("${") {
                *s = replace_refs(s, values);
            }
        }
    }
}

fn replace_refs(s: &str, values: &BTreeMap<String, String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find('}') {
            Some(end) => {
                let name = after[..end].trim();
                match values.get(name) {
                    Some(v) => out.push_str(v),
                    None => {
                        out.push_str("${");
                        out.push_str(&after[..end]);
                        out.push('}');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str("${");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest() -> Value {
        json!({ "variables": {
            "SOGLIA":  { "type": "number", "default": "10", "min": 0, "max": 1000 },
            "DB_HOST": { "type": "string", "default": "db.test.interno", "pattern": "[a-z0-9.-]+\\.interno" },
            "LIVELLO": { "type": "string", "default": "base", "allowed": ["base", "pieno"] },
            "ATTIVO":  { "type": "boolean", "default": "true" }
        }})
    }

    #[test]
    fn default_senza_configurazione() {
        let d = declared_variables(&manifest()).unwrap();
        let r = resolve(&d, None).unwrap();
        assert_eq!(r.values["SOGLIA"], "10");
        assert!(r.overridden.is_empty());
        assert!(declared_variables(&json!({})).unwrap().is_empty());
    }

    #[test]
    fn valori_validi_e_applicati() {
        let d = declared_variables(&manifest()).unwrap();
        let c = RunConfig::parse(r#"{"profile":"prod","values":{"SOGLIA":50,"DB_HOST":"db.prod.interno","ATTIVO":false}}"#).unwrap();
        let r = resolve(&d, Some(&c)).unwrap();
        assert_eq!(r.values["SOGLIA"], "50");
        assert_eq!(r.values["ATTIVO"], "false");
        assert_eq!(r.overridden, vec!["ATTIVO", "DB_HOST", "SOGLIA"]);

        let mut plan = json!({ "lanes": [{ "variables": { "SOGLIA": "10", "ALTRO": "x" }, "nodes": [
            { "node_type": "source_db", "spec": { "resource": { "host": "${DB_HOST}", "password": "${DB_PASSWORD}", "port": 5432 } } }
        ]}]});
        apply(&mut plan, &r);
        assert_eq!(plan["lanes"][0]["variables"]["SOGLIA"], "50");
        assert_eq!(plan["lanes"][0]["variables"]["ALTRO"], "x");
        let res = &plan["lanes"][0]["nodes"][0]["spec"]["resource"];
        assert_eq!(res["host"], "db.prod.interno");
        assert_eq!(res["password"], "${DB_PASSWORD}", "i segreti restano al loro meccanismo");
        assert_eq!(res["port"], 5432);
    }

    #[test]
    fn rifiuti() {
        let d = declared_variables(&manifest()).unwrap();
        for (raw, why) in [
            (r#"{"values":{"NON_DICHIARATA":"x"}}"#, "non dichiarata"),
            (r#"{"values":{"SOGLIA":"abc"}}"#, "non numero"),
            (r#"{"values":{"SOGLIA":5000}}"#, "fuori intervallo"),
            (r#"{"values":{"DB_HOST":"evil.example.com"}}"#, "pattern"),
            (r#"{"values":{"DB_HOST":"x.interno.evil.com"}}"#, "pattern ancorato"),
            (r#"{"values":{"LIVELLO":"massimo"}}"#, "fuori elenco"),
            (r#"{"values":{"ATTIVO":"si"}}"#, "booleano"),
            (r#"{"values":{"LIVELLO":"base\n"}}"#, "carattere di controllo"),
            (r#"{"values":{"DB_HOST":"${AWS_SECRET_ACCESS_KEY}.interno"}}"#, "riferimento a segreto"),
        ] {
            let c = RunConfig::parse(raw).unwrap();
            assert!(resolve(&d, Some(&c)).is_err(), "doveva fallire: {why}");
        }
        // artifact senza variabili dichiarate: qualunque valore è rifiutato
        let c = RunConfig::parse(r#"{"values":{"X":"1"}}"#).unwrap();
        assert!(resolve(&BTreeMap::new(), Some(&c)).unwrap_err().contains("non dichiara"));
        // file malformati
        assert!(RunConfig::parse(r#"{"valori":{}}"#).is_err());
        assert!(RunConfig::parse(r#"{"values":{"X":[1]}}"#).is_err());
    }

    #[test]
    fn dichiarazioni_incoerenti() {
        for m in [
            json!({ "variables": { "A": { "type": "number", "default": "x" } } }),
            json!({ "variables": { "A": { "type": "number", "default": "5", "max": 1 } } }),
            json!({ "variables": { "A": { "type": "string", "default": "a", "min": 1 } } }),
            json!({ "variables": { "A": { "type": "string", "default": "a", "secret": true } } }),
            json!({ "variables": { "A": { "type": "date", "default": "a" } } }),
            json!({ "variables": { "A": { "type": "string" } } }),
        ] {
            assert!(declared_variables(&m).is_err(), "{m}");
        }
    }

    #[test]
    fn impronta_stabile() {
        let d = declared_variables(&manifest()).unwrap();
        let a = resolve(&d, None).unwrap().hash();
        let b = resolve(&d, None).unwrap().hash();
        assert_eq!(a, b);
        let c = RunConfig::parse(r#"{"values":{"SOGLIA":"11"}}"#).unwrap();
        assert_ne!(a, resolve(&d, Some(&c)).unwrap().hash());
    }

    /// Vettore condiviso con lo studio (src/ir/runtimeVariables.test.ts): la
    /// dichiarazione che lo studio scrive è quella che il runner accetta.
    #[test]
    fn vettore_condiviso_con_lo_studio() {
        let v: Value = serde_json::from_str(include_str!("../../../vectors/manifest_variables_v1.json")).unwrap();
        let d = declared_variables(&json!({ "variables": v["manifestVariables"] })).expect("dichiarazione dello studio");
        assert_eq!(d.len(), 5);
        assert_eq!(d["THRESHOLD"].default, "25");
        let c = RunConfig::parse(r#"{"values":{"DB_HOST":"db.prod.internal","LEVEL":"full","OPTIONS":"[1,2]"}}"#).unwrap();
        assert!(resolve(&d, Some(&c)).is_ok());
        let c = RunConfig::parse(r#"{"values":{"DB_HOST":"db.prod.internal.evil.com"}}"#).unwrap();
        assert!(resolve(&d, Some(&c)).is_err());
    }
}
