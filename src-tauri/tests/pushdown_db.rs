// ─── tests/pushdown_db.rs ─────────────────────────────────────────
// P394: il Filter dopo un DB Input spinto nella query (SQLite vero).
// Le righe in uscita devono essere IDENTICHE con e senza la spinta; con la
// spinta il DB Input ne legge meno, e il log dice cosa è stato spinto (o
// perché no).

use app_lib::engine::{engine_poll_events, engine_run};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

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

fn f(n: &str) -> Value { json!({"kind":"DirectFieldRef","field": n}) }
fn lit(v: Value) -> Value { json!({"kind":"Literal","value": v}) }
fn bin(op: &str, l: Value, r: Value) -> Value { json!({"kind":"BinaryOp","op": op,"left": l,"right": r}) }

fn piano(run: &str, db: &str, out: &str, query: &str, cond: &Value, spingi: bool) -> Value {
    let conditions = json!([{ "id": "c1", "label": "ok", "mode": "code", "expr": cond }]);
    let mut cfg = json!({});
    if spingi {
        cfg = json!({ "pushdown": { "filter": "Filtro", "conditions": conditions, "null_behavior": "exclude", "case_sensitive": true } });
    }
    json!({"run_id": run, "bridges": [], "lanes": [{"lane_id":"l1","label":"L","variables":{"soglia": 2}, "nodes": [
        {"node_id":"db","node_type":"source_db","label":"db","config":{},
         "spec":{"props":{"query": query},"config": cfg,
                 "resource":{"dialect":"sqlite","database": db},"resourceId":"r1"}},
        {"node_id":"fl","node_type":"filter","label":"Filtro","config":{},
         "spec":{"props":{},"config":{"conditions": conditions}}},
        {"node_id":"out","node_type":"sink_file","label":"out","config":{},
         "spec":{"props":{"path": out,"format":"csv"}}}
    ], "edges": [
        {"edge_id":"e1","source_node":"db","source_handle":"output","target_node":"fl","target_handle":"input"},
        {"edge_id":"e2","source_node":"fl","source_handle":"c1","target_node":"out","target_handle":"input"}
    ]}]})
}

fn letti(eventi: &[Value]) -> u64 {
    eventi.iter().find(|e| e["type"] == "NodeCompleted" && e["payload"]["node_id"] == "db")
        .and_then(|e| e["payload"]["stats"]["rows_out"].as_u64()).expect("NodeCompleted del DB Input")
}
fn log(eventi: &[Value]) -> Vec<String> {
    eventi.iter().filter(|e| e["type"] == "NodeLog" && e["payload"]["node_id"] == "db")
        .map(|e| e["payload"]["message"].as_str().unwrap_or("").to_string()).collect()
}

#[tokio::test]
async fn filtro_spinto_nella_query() {
    use sqlx::sqlite::SqlitePoolOptions;
    let base = std::env::temp_dir().join(format!("fp_pushdown_{}", std::process::id()));
    std::fs::create_dir_all(&base).unwrap();
    let db = base.join("t.db");
    let pool = SqlitePoolOptions::new().connect(&format!("sqlite:{}?mode=rwc", db.display())).await.unwrap();
    for s in [
        "CREATE TABLE ordini (id INTEGER, qta INTEGER, nome TEXT, giorno DATE)",
        "INSERT INTO ordini VALUES (1, 1, 'a', '2024-01-01'), (2, 3, 'b', '2024-02-01'), (3, 5, NULL, '2024-03-01'), (4, 7, 'x', '2024-04-01'), (5, NULL, 'c', NULL)",
    ] { sqlx::query(s).execute(&pool).await.unwrap(); }
    pool.close().await;
    let db = db.display().to_string();
    let q = "SELECT id, qta, nome, giorno FROM ordini;";

    // qta > var("soglia") && nome != "x" && giorno >= "2024-02-01"
    let cond = bin("AND",
        bin("GT", f("qta"), json!({"kind":"FunctionCall","name":"var","args":[lit(json!("soglia"))]})),
        bin("AND", bin("NE", f("nome"), lit(json!("x"))), bin("GTE", f("giorno"), lit(json!("2024-02-01")))));

    let out_a = base.join("a.csv").display().to_string();
    let (esito, ev_a) = esegui(piano("pd-a", &db, &out_a, q, &cond, true)).await;
    assert_eq!(esito, "completed", "{:?}", log(&ev_a));
    let out_b = base.join("b.csv").display().to_string();
    let (esito, ev_b) = esegui(piano("pd-b", &db, &out_b, q, &cond, false)).await;
    assert_eq!(esito, "completed");

    let a = std::fs::read_to_string(&out_a).unwrap();
    let b = std::fs::read_to_string(&out_b).unwrap();
    assert_eq!(a, b, "stesse righe con e senza la spinta");
    assert_eq!(a.lines().count(), 3, "intestazione + ordini 2 e 3 (null != \"x\" è vero): {a}");
    assert_eq!(letti(&ev_b), 5, "senza spinta il DB Input legge tutto");
    assert_eq!(letti(&ev_a), 2, "con la spinta legge solo ciò che serve");
    assert!(log(&ev_a).iter().any(|m| m.contains("pushed into the query: WHERE")), "{:?}", log(&ev_a));

    // ORDER BY nella query: non si spinge, e il log dice perché
    let out_c = base.join("c.csv").display().to_string();
    let (esito, ev_c) = esegui(piano("pd-c", &db, &out_c, "SELECT * FROM ordini ORDER BY id DESC", &cond, true)).await;
    assert_eq!(esito, "completed");
    assert_eq!(letti(&ev_c), 5);
    assert!(log(&ev_c).iter().any(|m| m.contains("not pushed") && m.contains("ORDER BY")), "{:?}", log(&ev_c));

    // una condizione che non si traduce (un calcolo): non si spinge
    let out_d = base.join("d.csv").display().to_string();
    let cond_d = bin("GT", bin("ADD", f("qta"), lit(json!(1))), lit(json!(3)));
    let (_, ev_d) = esegui(piano("pd-d", &db, &out_d, q, &cond_d, true)).await;
    assert_eq!(letti(&ev_d), 5);
    assert!(log(&ev_d).iter().any(|m| m.contains("not pushed")), "{:?}", log(&ev_d));

    let _ = std::fs::remove_dir_all(&base);
}
