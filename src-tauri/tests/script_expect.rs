// ─── tests/script_expect.rs ───────────────────────────────────────
// P392: regole `expect` del nodo Script, eseguite davvero dal motore.
// Righe scartate, avvisate e contate; il conteggio arriva nell'evento
// NodeRuleStats; con `else error` il nodo fallisce ma i conteggi escono lo
// stesso.

use app_lib::engine::{engine_poll_events, engine_run};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn lit(v: Value) -> Value { json!({"kind":"Literal","value": v}) }
fn f(n: &str) -> Value { json!({"kind":"DirectFieldRef","field": n}) }
fn bin(op: &str, l: Value, r: Value) -> Value { json!({"kind":"BinaryOp","op": op,"left": l,"right": r}) }

/// Esegue il piano; restituisce l'esito e gli eventi del run.
async fn esegui(plan: Value) -> (String, Vec<Value>) {
    let run_id = plan["run_id"].as_str().unwrap().to_string();
    let mut cursor = 0;
    loop {
        let r = engine_poll_events(cursor).await.unwrap();
        if r.events.is_empty() { break; }
        cursor = r.cursor;
    }
    engine_run(plan.to_string()).await.unwrap();
    let t0 = Instant::now();
    let mut eventi = Vec::new();
    loop {
        let r = engine_poll_events(cursor).await.unwrap();
        cursor = r.cursor;
        for e in &r.events {
            let v = serde_json::to_value(&e.event).unwrap();
            if v["payload"]["run_id"].as_str() != Some(run_id.as_str()) { continue; }
            let tipo = v["type"].as_str().unwrap_or("").to_string();
            eventi.push(v);
            if tipo == "RunCompleted" { return ("completed".into(), eventi) }
            if tipo == "RunFailed" { return ("failed".into(), eventi) }
        }
        assert!(t0.elapsed() < Duration::from_secs(30), "run non finito");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn piano(run: &str, dir: &std::path::Path, body: Value) -> Value {
    let input = dir.join("in.csv");
    std::fs::write(&input, "id,qty,price\n1,3,10\n2,0,10\n3,-1,500\n4,2,200\n").unwrap();
    json!({"run_id": run, "bridges": [], "lanes": [{"lane_id":"l1","label":"L","variables":{}, "nodes": [
        {"node_id":"src","node_type":"source_file","label":"src","config":{},
         "spec":{"props":{"path": input.display().to_string(),"format":"csv","hasHeader":"true"}}},
        {"node_id":"sc","node_type":"script","label":"sc","config":{},
         "spec":{"props":{"sourceMode":"flusso","hasReject":"true"},"config":{"body": body}}},
        {"node_id":"ok","node_type":"sink_file","label":"ok","config":{},
         "spec":{"props":{"path": dir.join("ok.csv").display().to_string(),"format":"csv"}}},
        {"node_id":"ko","node_type":"sink_file","label":"ko","config":{},
         "spec":{"props":{"path": dir.join("ko.csv").display().to_string(),"format":"csv"}}}
    ], "edges": [
        {"edge_id":"e1","source_node":"src","source_handle":"output","target_node":"sc","target_handle":"input"},
        {"edge_id":"e2","source_node":"sc","source_handle":"output","target_node":"ok","target_handle":"input"},
        {"edge_id":"e3","source_node":"sc","source_handle":"reject","target_node":"ko","target_handle":"input"}
    ]}]})
}

fn regole(eventi: &[Value]) -> Vec<(String, String, u64)> {
    let e = eventi.iter().find(|e| e["type"] == "NodeRuleStats").expect("evento NodeRuleStats");
    e["payload"]["rules"].as_array().unwrap().iter()
        .map(|r| (r["rule"].as_str().unwrap().to_string(), r["action"].as_str().unwrap().to_string(), r["violations"].as_u64().unwrap()))
        .collect()
}

#[tokio::test]
async fn regole_expect() {
    let base = std::env::temp_dir().join(format!("fp_expect_{}", std::process::id()));
    std::fs::create_dir_all(&base).unwrap();

    // 1) reject + warn: la riga con qty <= 0 si scarta; il prezzo alto avvisa e prosegue
    let d1 = base.join("a"); std::fs::create_dir_all(&d1).unwrap();
    let body = json!([
        {"kind":"Expect","cond": bin("GT", json!({"kind":"FunctionCall","name":"to_int","args":[f("qty")]}), lit(json!(0))),
         "action":"reject","message": lit(json!("quantity must be positive")),"label":"quantity must be positive"},
        {"kind":"Expect","cond": bin("LTE", json!({"kind":"FunctionCall","name":"to_int","args":[f("price")]}), lit(json!(100))),
         "action":"warn","message": null,"label":"price <= 100"}
    ]);
    let (esito, eventi) = esegui(piano("expect-a", &d1, body)).await;
    assert_eq!(esito, "completed");
    assert_eq!(regole(&eventi), vec![
        ("quantity must be positive".into(), "reject".into(), 2),
        ("price <= 100".into(), "warn".into(), 1),   // la riga 3 è già scartata prima del controllo
    ]);
    let ok = std::fs::read_to_string(d1.join("ok.csv")).unwrap();
    assert_eq!(ok.lines().count(), 3, "intestazione + righe 1 e 4: {ok}");
    let ko = std::fs::read_to_string(d1.join("ko.csv")).unwrap();
    assert!(ko.contains("quantity must be positive"), "motivo nello scarto: {ko}");
    let avvisi = eventi.iter().filter(|e| e["type"] == "NodeLog" && e["payload"]["level"] == "warn").count();
    assert_eq!(avvisi, 1, "un solo avviso per regola, alla prima violazione");

    // 2) error: il nodo fallisce, ma i conteggi escono lo stesso
    let d2 = base.join("b"); std::fs::create_dir_all(&d2).unwrap();
    let body = json!([
        {"kind":"Expect","cond": bin("GT", json!({"kind":"FunctionCall","name":"to_int","args":[f("qty")]}), lit(json!(0))),
         "action":"error","message": null,"label":"qty > 0"}
    ]);
    let (esito, eventi) = esegui(piano("expect-b", &d2, body)).await;
    assert_eq!(esito, "failed");
    assert_eq!(regole(&eventi), vec![("qty > 0".into(), "error".into(), 1)]);
    let fallito = eventi.iter().find(|e| e["type"] == "NodeFailed").expect("NodeFailed");
    assert!(fallito["payload"]["error"].as_str().unwrap().contains("expectation not met: qty > 0"));

    let _ = std::fs::remove_dir_all(&base);
}
