// ─── tests/runner_contract.rs ─────────────────────────────────────
// Contratto dell'interfaccia del runner (P379, docs/ARCHITETTURA-coordinatore.md
// §4.2): codici d'uscita, riepilogo di --admit-only, intestazione del log.
// Chi lancia il runner (uno script, domani l'agente) si basa su questi: se un
// test fallisce si è rotto un contratto, e si corregge il codice.
//
//   cargo test --no-default-features --test runner_contract

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn vectors() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("vectors")
}

/// HOME isolata con il trust store del vettore (permessi stretti, come in produzione).
fn home(name: &str, profile: Option<&str>) -> PathBuf {
    let home = std::env::temp_dir().join(format!("flowpilot-runner-contract-{}-{name}", std::process::id()));
    let dir = home.join(".flowpilot");
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(vectors().join("artifact_v2_trust_store.json"), dir.join("trust-store.json")).unwrap();
    if let Some(p) = profile {
        std::fs::write(dir.join("runtime.json"), p).unwrap();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for (p, m) in [(&home, 0o700), (&dir, 0o700)] {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
        }
        for f in ["trust-store.json", "runtime.json"] {
            let f = dir.join(f);
            if f.exists() {
                std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
            }
        }
    }
    home
}

fn run(home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_flowpilot_runner"))
        .args(args)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("FLOWPILOT_RUNS_DIR", home.join("runs"))
        .env_remove("FLOWPILOT_RUNTIME_PROFILE")
        .env_remove("MONITOR_URL")
        .output()
        .unwrap()
}

fn artifact() -> String {
    vectors().join("artifact_v2.ffart").display().to_string()
}

#[test]
fn admit_only_ammesso() {
    let h = home("ok", None);
    let out = run(&h, &["--admit-only", &artifact()]);
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["admitted"], true);
    assert_eq!(v["planName"], "vettore-artifact");
    assert_eq!(v["owner"], "vettore");
    assert!(v["keyId"].as_str().unwrap().starts_with("ed25519:"));
    assert!(v["planHash"].as_str().unwrap().starts_with("sha256:"));
    assert_eq!(v["nodeTypes"], serde_json::json!(["sink_file", "source_file"]));
}

#[test]
fn admit_only_rifiutato_dalla_policy() {
    let h = home("policy", Some(r#"{"formatVersion":1,"policy":{"deniedNodeTypes":["sink_file"]}}"#));
    // le opzioni stanno anche dopo il file
    let out = run(&h, &[&artifact(), "--admit-only"]);
    assert_eq!(out.status.code(), Some(3));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["admitted"], false);
    assert!(v["reason"].as_str().unwrap().contains("sink_file (Uscita)"));
}

#[test]
fn rifiuti_e_uso_errato() {
    let h = home("codes", None);
    // profilo indicato ma assente → rifiutato (3)
    let missing = h.join("nope.json").display().to_string();
    assert_eq!(run(&h, &["--profile", &missing, &artifact()]).status.code(), Some(3));
    // trust store assente → rifiutato (3)
    std::fs::remove_file(h.join(".flowpilot").join("trust-store.json")).unwrap();
    assert_eq!(run(&h, &[&artifact()]).status.code(), Some(3));
    // uso errato (2)
    assert_eq!(run(&h, &["--sconosciuta", &artifact()]).status.code(), Some(2));
    assert_eq!(run(&h, &[]).status.code(), Some(2));
    assert_eq!(run(&h, &["/non/esiste.ffart"]).status.code(), Some(2));
    assert_eq!(run(&h, &["--profile"]).status.code(), Some(2));
}

#[test]
fn run_fallito_e_intestazione_del_log() {
    // I nodi del vettore non hanno una configurazione completa: il run parte
    // (ammesso, eventi emessi) e fallisce → uscita 1.
    let h = home("run", None);
    let out = run(&h, &[&artifact()]);
    assert_eq!(out.status.code(), Some(1), "{}", String::from_utf8_lossy(&out.stderr));
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut lines = stdout.lines();
    let header: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
    assert_eq!(header["kind"], "flowpilot-log-header");
    assert_eq!(header["logFormat"], 1);
    assert_eq!(header["artifact"]["planName"], "vettore-artifact");
    assert!(header["runner"]["version"].is_string());
    // ogni riga successiva: { timestamp, event: { type, payload } }
    let mut types = Vec::new();
    for l in lines.filter(|l| !l.trim().is_empty()) {
        let v: serde_json::Value = serde_json::from_str(l).unwrap();
        assert!(v["timestamp"].is_u64(), "{l}");
        types.push(v["event"]["type"].as_str().unwrap().to_string());
    }
    assert_eq!(types.first().map(String::as_str), Some("RunStarted"), "{types:?}");
    assert_eq!(types.last().map(String::as_str), Some("RunFailed"), "{types:?}");
}
