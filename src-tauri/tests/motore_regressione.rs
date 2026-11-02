// ─── tests/motore_regressione.rs ──────────────────────────────────
// Banco di NON REGRESSIONE del motore (P384). Prerequisito delle righe con
// schema (voce A di docs/STUDIO-motore-prestazioni.md): prima di cambiare come
// il motore rappresenta una riga, si fissa cosa deve produrre.
//
// Ogni scenario genera dati deterministici, esegue un piano reale con
// `engine_run` e confronta i file prodotti con quelli attesi in
// `tests/regressione/<scenario>/` — byte per byte.
//
//   cargo test --no-default-features --test motore_regressione
//
// Un cambiamento VOLUTO dell'output (es. l'ordine delle colonne) si registra
// rigenerando gli attesi e guardando il diff in git:
//
//   FLOWPILOT_AGGIORNA_ATTESI=1 cargo test --no-default-features --test motore_regressione
//
// Copertura scelta per ciò che cambia con lo schema: righe di forma variabile
// (pivot dinamico, JSON parser, campi assegnati in un `if`, emit), union di
// schemi diversi, CSV con intestazioni duplicate e righe irregolari, join e
// TMap in tutte le varianti, tipi dei valori (JSON Lines).

use app_lib::engine::{engine_poll_events, engine_run};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

// ─── dati ────────────────────────────────────────────────────────

fn scrivi(path: &Path, s: &str) {
    std::fs::write(path, s).unwrap();
}

fn genera_dati(dir: &Path) {
    let citta = ["Milano", "Roma", "Torino", "Napoli", "Bari"];
    let mesi = ["gen", "feb", "mar"];
    let mut o = String::from("id,cust_id,qty,price,city,month\n");
    for i in 0..300 {
        o.push_str(&format!("{},{},{},{}.{:02},{},{}\n", i, i % 60, i % 17 + 1, i % 50, i % 100, citta[i % 5], mesi[i % 3]));
    }
    scrivi(&dir.join("orders.csv"), &o);
    // 50 clienti su 60 (10 mancanti → scarti dell'inner) e 8 doppioni (uno-a-molti)
    let mut c = String::from("id,name,segment\n");
    for i in 0..50 {
        c.push_str(&format!("{},Cliente {},{}\n", i, i, if i % 3 == 0 { "B" } else { "A" }));
    }
    for i in (0..50).step_by(7) {
        c.push_str(&format!("{},Doppio {},C\n", i, i));
    }
    scrivi(&dir.join("customers.csv"), &c);
    // flusso con colonne diverse, per la union
    let mut r = String::from("code,qty,note\n");
    for i in 0..20 {
        r.push_str(&format!("R{},{},reso {}\n", i, i % 4, i));
    }
    scrivi(&dir.join("returns.csv"), &r);
    // CSV irregolare: intestazione duplicata, colonna senza nome, righe corte e
    // lunghe, virgole e virgolette fra virgolette
    scrivi(&dir.join("irregolare.csv"), "id,name,name,,note\n\
1,Anna,Bianchi,x,\"con, virgola\"\n\
2,Bruno,Verdi\n\
3,Carla,Neri,y,\"dice \"\"ciao\"\"\",extra1,extra2\n\
4,,,,\n");
    // JSON annidato in una colonna
    let mut j = String::from("order,payload\n");
    for i in 0..10 {
        let righe: Vec<String> = (0..(i % 3 + 1))
            .map(|k| format!("{{\"sku\":\"S{}-{}\",\"qty\":{}}}", i, k, k + 1))
            .collect();
        let payload = format!("{{\"customer\":{{\"name\":\"C{}\",\"vip\":{}}},\"righe\":[{}]}}", i, i % 2 == 0, righe.join(","));
        j.push_str(&format!("{},\"{}\"\n", i, payload.replace('"', "\"\"")));
    }
    scrivi(&dir.join("ordini_json.csv"), &j);
}

// ─── mattoni dei piani ───────────────────────────────────────────

fn f(n: &str) -> Value { json!({"kind":"DirectFieldRef","field": n}) }
fn q(i: &str, n: &str) -> Value { json!({"kind":"FieldRef","input": i,"field": n}) }
fn lit(v: Value) -> Value { json!({"kind":"Literal","value": v}) }
fn bin(op: &str, l: Value, r: Value) -> Value { json!({"kind":"BinaryOp","op": op,"left": l,"right": r}) }
fn call(n: &str, a: Vec<Value>) -> Value { json!({"kind":"FunctionCall","name": n,"args": a}) }

fn sorgente(id: &str, path: &Path) -> Value {
    json!({"node_id": id, "node_type":"source_file", "label": id, "config":{},
           "spec":{"props":{"path": path.display().to_string(), "format":"csv", "hasHeader":"true"}}})
}
fn uscita(id: &str, path: &Path) -> Value {
    let fmt = if path.extension().and_then(|e| e.to_str()) == Some("jsonl") { "jsonl" } else { "csv" };
    json!({"node_id": id, "node_type":"sink_file", "label": id, "config":{},
           "spec":{"props":{"path": path.display().to_string(), "format": fmt}}})
}
fn arco(id: &str, da: &str, h_da: &str, a: &str, h_a: &str) -> Value {
    json!({"edge_id": id, "source_node": da, "source_handle": h_da, "target_node": a, "target_handle": h_a})
}
fn piano(run: &str, nodes: Vec<Value>, edges: Vec<Value>, vars: Value) -> Value {
    json!({"run_id": run, "bridges": [], "lanes": [{"lane_id":"l1","label":"L","variables": vars, "nodes": nodes, "edges": edges}]})
}

// ─── esecuzione ──────────────────────────────────────────────────

async fn esegui(plan: Value) -> String {
    let run_id = plan["run_id"].as_str().unwrap().to_string();
    let mut cursor = 0;
    // Il bus è globale: si legge fino in fondo prima di partire, poi si segue
    // solo il proprio run.
    loop {
        let r = engine_poll_events(cursor).await.unwrap();
        if r.events.is_empty() { break; }
        cursor = r.cursor;
    }
    engine_run(plan.to_string()).await.unwrap();
    let t0 = Instant::now();
    loop {
        let r = engine_poll_events(cursor).await.unwrap();
        cursor = r.cursor;
        for e in &r.events {
            let v = serde_json::to_value(&e.event).unwrap();
            if v["payload"]["run_id"].as_str() != Some(run_id.as_str()) { continue; }
            match v["type"].as_str() {
                Some("RunCompleted") => return "completed".into(),
                Some("RunFailed") => return format!("failed: {}", v["payload"]["error"]),
                _ => {}
            }
        }
        assert!(t0.elapsed() < Duration::from_secs(60), "run {run_id} non finito in 60 s");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn attesi_dir(scenario: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("regressione").join(scenario)
}

/// Confronta i file prodotti con gli attesi. Ritorna le differenze.
fn confronta(scenario: &str, out: &Path, files: &[&str], esito: &str, esito_atteso: &str) -> Vec<String> {
    let mut diff = Vec::new();
    if esito != esito_atteso {
        diff.push(format!("{scenario}: esito '{esito}', atteso '{esito_atteso}'"));
    }
    let dir = attesi_dir(scenario);
    let aggiorna = std::env::var("FLOWPILOT_AGGIORNA_ATTESI").is_ok();
    for name in files {
        let got = std::fs::read(out.join(name)).unwrap_or_else(|_| b"<file non prodotto>".to_vec());
        let path = dir.join(name);
        if aggiorna {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(&path, &got).unwrap();
            continue;
        }
        let want = std::fs::read(&path).unwrap_or_else(|_| b"<atteso mancante>".to_vec());
        if got != want {
            let (g, w) = (String::from_utf8_lossy(&got), String::from_utf8_lossy(&want));
            let riga = g.lines().zip(w.lines()).position(|(a, b)| a != b)
                .unwrap_or(g.lines().count().min(w.lines().count()));
            diff.push(format!(
                "{scenario}/{name}: diverso alla riga {}\n    ottenuto: {:?}\n    atteso:   {:?}",
                riga + 1, g.lines().nth(riga).unwrap_or("<fine>"), w.lines().nth(riga).unwrap_or("<fine>")));
        }
    }
    diff
}

// ─── scenari ─────────────────────────────────────────────────────

fn tmap_config(join_type: &str) -> Value {
    json!({"main_input_id":"input_main","lane_variables":[],
        "lookups":[{"input_id":"lkp1","label":"Clienti","join_type": join_type,
            "join_pairs":[{"src_key_expr": q("input_main","cust_id"),"dst_field":"id","dst_key_expr": null}]}],
        "transforms":[{"id":"t1","output_name":"total","output_type":"decimal",
            "expr": bin("MUL", call("to_float", vec![q("input_main","qty")]), call("to_float", vec![q("input_main","price")]))}],
        "outputs":[
            {"output_id":"out_big","label":"Big","filter_expr": bin("GT", f("total"), lit(json!(100))),
             "fields":[
                {"name":"id","type":"integer","expr": q("input_main","id")},
                {"name":"name","type":"string","expr": call("upper", vec![q("lkp1","name")])},
                {"name":"total","type":"decimal","expr": f("total")},
                {"name":"tag","type":"string","expr": call("concat", vec![q("input_main","city"), lit(json!("-")), q("Clienti","segment")])},
                {"name":"class","type":"string","expr": {"kind":"CaseWhen","branches":[{"condition": bin("GT", f("total"), lit(json!(500))),"value": lit(json!("XL"))}],"default": lit(json!("L"))}}]},
            {"output_id":"out_small","label":"Small","filter_expr": bin("LTE", f("total"), lit(json!(100))),
             "fields":[
                {"name":"id","type":"integer","expr": q("input_main","id")},
                {"name":"total","type":"decimal","expr": f("total")},
                {"name":"soglia","type":"string","expr": call("var", vec![lit(json!("SOGLIA"))])}]},
            {"output_id":"output_rejected","label":"Rej","filter_expr": null,
             "fields":[{"name":"id","type":"integer","expr": q("input_main","id")},{"name":"cust","type":"string","expr": q("input_main","cust_id")}]}]})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn regressione_del_motore() {
    let base = std::env::temp_dir().join(format!("flowpilot-regressione-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    std::fs::create_dir_all(&base).unwrap();
    std::env::set_var("FLOWPILOT_RUNS_DIR", base.join("runs"));
    let d = base.join("dati");
    std::fs::create_dir_all(&d).unwrap();
    genera_dati(&d);
    let mut diff: Vec<String> = Vec::new();

    // 1. Transform (add, CASE, var) → Filter con scarti
    {
        let o = base.join("trasforma_filtra"); std::fs::create_dir_all(&o).unwrap();
        let p = piano("reg-trasforma", vec![
            sorgente("src", &d.join("orders.csv")),
            json!({"node_id":"tr","node_type":"transform","label":"tr","config":{},"spec":{"props":{},"config":{"mode":"add","fields":[
                {"name":"total","expr": bin("MUL", call("to_float", vec![f("qty")]), call("to_float", vec![f("price")]))},
                {"name":"name_up","expr": call("upper", vec![f("city")])},
                {"name":"fascia","expr": {"kind":"CaseWhen","branches":[{"condition": bin("GT", call("to_int", vec![f("qty")]), call("to_int", vec![call("var", vec![lit(json!("SOGLIA"))])])),"value": lit(json!("alta"))}],"default": lit(json!("bassa"))}}
            ]}}}),
            json!({"node_id":"fl","node_type":"filter","label":"fl","config":{},"spec":{"props":{},"config":{"conditions":[
                {"id":"keep","label":"keep","mode":"code","expr": bin("AND", bin("GT", f("total"), lit(json!(50))), bin("NE", f("city"), lit(json!("Bari"))))}]}}}),
            uscita("k", &o.join("tenute.csv")), uscita("r", &o.join("scartate.jsonl")),
        ], vec![
            arco("e1","src","output","tr","input"), arco("e2","tr","output","fl","input"),
            arco("e3","fl","keep","k","input"), arco("e4","fl","reject","r","input"),
        ], json!({"SOGLIA":"10"}));
        let esito = esegui(p).await;
        diff.extend(confronta("trasforma_filtra", &o, &["tenute.csv", "scartate.jsonl"], &esito, "completed"));
    }

    // 2. TMap: inner, left, first; uno-a-molti; scarti; var()
    for jt in ["inner", "left", "first"] {
        let sc = format!("tmap_{jt}");
        let o = base.join(&sc); std::fs::create_dir_all(&o).unwrap();
        let p = piano(&format!("reg-tmap-{jt}"), vec![
            sorgente("o", &d.join("orders.csv")), sorgente("c", &d.join("customers.csv")),
            json!({"node_id":"tm","node_type":"tmap","label":"tm","config":{},"spec":{"props":{},"config": tmap_config(jt)}}),
            uscita("s1", &o.join("big.jsonl")), uscita("s2", &o.join("small.csv")), uscita("s3", &o.join("scarti.csv")),
        ], vec![
            arco("e1","o","output","tm","input_main"), arco("e2","c","output","tm","lkp1"),
            arco("e3","tm","out_big","s1","input"), arco("e4","tm","out_small","s2","input"),
            arco("e5","tm","output_rejected","s3","input"),
        ], json!({"SOGLIA":"100"}));
        let esito = esegui(p).await;
        diff.extend(confronta(&sc, &o, &["big.jsonl", "small.csv", "scarti.csv"], &esito, "completed"));
    }

    // 3. Aggregate: group by, più funzioni, ordinamento
    {
        let o = base.join("aggregate"); std::fs::create_dir_all(&o).unwrap();
        let p = piano("reg-aggregate", vec![
            sorgente("src", &d.join("orders.csv")),
            json!({"node_id":"ag","node_type":"aggregate","label":"ag","config":{},"spec":{
                "props":{"group_by":"city,month","orderBy":"city","orderDir":"asc"},
                "config":{"functions":[
                    {"fn":"sum","field":"qty","alias":"qty_tot"},
                    {"fn":"count","field":"","alias":"n"},
                    {"fn":"avg","field":"price","alias":"prezzo_medio"},
                    {"fn":"max","field":"price","alias":"prezzo_max"},
                    {"fn":"string_agg","field":"id","alias":"ids","separator":"|"}]}}}),
            uscita("out", &o.join("gruppi.jsonl")),
        ], vec![arco("e1","src","output","ag","input"), arco("e2","ag","output","out","input")], json!({}));
        let esito = esegui(p).await;
        diff.extend(confronta("aggregate", &o, &["gruppi.jsonl"], &esito, "completed"));
    }

    // 4. Pivot DINAMICO: le colonne in uscita nascono dai dati
    {
        let o = base.join("pivot_dinamico"); std::fs::create_dir_all(&o).unwrap();
        let p = piano("reg-pivot", vec![
            sorgente("src", &d.join("orders.csv")),
            json!({"node_id":"pv","node_type":"pivot","label":"pv","config":{},"spec":{"props":{
                "pivotMode":"pivot","pivotType":"dynamic","identityField":"city","pivotField":"month",
                "valueField":"qty","aggFn":"sum","pivotSort":"asc"}}}),
            uscita("out", &o.join("pivot.csv")),
        ], vec![arco("e1","src","output","pv","input"), arco("e2","pv","output","out","input")], json!({}));
        let esito = esegui(p).await;
        diff.extend(confronta("pivot_dinamico", &o, &["pivot.csv"], &esito, "completed"));
    }

    // 5. JSON Parser: testata + righe annidate con i campi del padre
    {
        let o = base.join("json_parser"); std::fs::create_dir_all(&o).unwrap();
        let fld = |n: &str, p: &str, t: &str| json!({"name": n, "jsonPath": p, "type": t, "transform":"none", "onMissing":"null"});
        let p = piano("reg-json", vec![
            sorgente("src", &d.join("ordini_json.csv")),
            json!({"node_id":"jp","node_type":"json_parser","label":"jp","config":{},"spec":{"props":{},"config":{
                "sourceField":"payload","hasReject":false,"flows":[
                    {"id":"testata","label":"testata","jsonPath":"$","isArray":false,"mergeParent":true,"parentFields":["order"],
                     "fields":[fld("cliente","$.customer.name","string"), fld("vip","$.customer.vip","boolean")]},
                    {"id":"righe","label":"righe","jsonPath":"$.righe","isArray":true,"mergeParent":true,"parentFields":["order"],
                     "fields":[fld("sku","$.sku","string"), fld("qty","$.qty","integer"), fld("assente","$.nessuno","string")]}]}}}),
            uscita("t", &o.join("testate.jsonl")), uscita("r", &o.join("righe.jsonl")),
        ], vec![
            arco("e1","src","output","jp","input"),
            arco("e2","jp","testata","t","input"), arco("e3","jp","righe","r","input"),
        ], json!({}));
        let esito = esegui(p).await;
        diff.extend(confronta("json_parser", &o, &["testate.jsonl", "righe.jsonl"], &esito, "completed"));
    }

    // 6. Script: campi assegnati dentro un `if` (forma variabile), emit, reject, let
    {
        let o = base.join("script"); std::fs::create_dir_all(&o).unwrap();
        let body = json!([
            {"kind":"Let","name":"t","expr": bin("MUL", call("to_float", vec![f("qty")]), call("to_float", vec![f("price")]))},
            {"kind":"If","cond": bin("EQ", f("city"), lit(json!("Bari"))),
             "then":[{"kind":"Reject","reason": lit(json!("Bari esclusa"))}], "else":[]},
            {"kind":"If","cond": bin("GT", q("__local","t"), lit(json!(300))),
             "then":[{"kind":"Assign","field":"premio","expr": lit(json!(true))}], "else":[]},
            {"kind":"Assign","field":"totale","expr": q("__local","t")},
            {"kind":"Repeat","count": lit(json!(2)),"varName":"k","body":[
                {"kind":"Assign","field":"copia","expr": q("__local","k")}, {"kind":"Emit"}]},
            {"kind":"Skip"}
        ]);
        let p = piano("reg-script", vec![
            sorgente("src", &d.join("orders.csv")),
            json!({"node_id":"sc","node_type":"script","label":"sc","config":{},"spec":{"props":{"sourceMode":"flusso"},"config":{"body": body}}}),
            uscita("out", &o.join("righe.jsonl")), uscita("rej", &o.join("scarti.jsonl")),
        ], vec![
            arco("e1","src","output","sc","input"), arco("e2","sc","output","out","input"), arco("e3","sc","reject","rej","input"),
        ], json!({}));
        let esito = esegui(p).await;
        diff.extend(confronta("script", &o, &["righe.jsonl", "scarti.jsonl"], &esito, "completed"));
    }

    // 7. Union di schemi diversi (con campo d'origine)
    {
        let o = base.join("union"); std::fs::create_dir_all(&o).unwrap();
        let p = piano("reg-union", vec![
            sorgente("a", &d.join("orders.csv")), sorgente("b", &d.join("returns.csv")),
            json!({"node_id":"un","node_type":"union","label":"un","config":{"union_inputs":[{"id":"union_input_2","label":"flusso_2"}]},
                "spec":{"props":{},"config":{"mode":"concat","missing_field":"null","add_source_field":true,"source_field_name":"_origine",
                    "handle_labels":{"input_main":"ordini","union_input_2":"resi"},
                    "fields":[
                        {"name":"codice","from":{"input_main":"id","union_input_2":"code"}},
                        {"name":"qty","from":{"input_main":"qty","union_input_2":"qty"}},
                        {"name":"city","from":{"input_main":"city"}},
                        {"name":"note","from":{"union_input_2":"note"}}]}}}),
            uscita("out", &o.join("unione.jsonl")),
        ], vec![
            arco("e1","a","output","un","input_main"), arco("e2","b","output","un","union_input_2"),
            arco("e3","un","output","out","input"),
        ], json!({}));
        let esito = esegui(p).await;
        diff.extend(confronta("union", &o, &["unione.jsonl"], &esito, "completed"));
    }

    // 8. CSV irregolare: nomi duplicati, colonna senza nome, righe corte/lunghe
    {
        let o = base.join("csv_irregolare"); std::fs::create_dir_all(&o).unwrap();
        let p = piano("reg-irregolare", vec![
            sorgente("src", &d.join("irregolare.csv")),
            uscita("j", &o.join("righe.jsonl")), uscita("c", &o.join("righe.csv")),
        ], vec![arco("e1","src","output","j","input"), arco("e2","src","output","c","input")], json!({}));
        let esito = esegui(p).await;
        diff.extend(confronta("csv_irregolare", &o, &["righe.jsonl", "righe.csv"], &esito, "completed"));
    }

    // 9. Join (nodo dedicato), left con prefisso e scarti
    {
        let o = base.join("join"); std::fs::create_dir_all(&o).unwrap();
        let p = piano("reg-join", vec![
            sorgente("o", &d.join("orders.csv")), sorgente("c", &d.join("customers.csv")),
            json!({"node_id":"jn","node_type":"join","label":"jn","config":{},"spec":{"props":{
                "join_type":"left","leftKey":"cust_id","rightKey":"id","rightPrefix":"c_","duplicates":"all"}}}),
            uscita("out", &o.join("unite.jsonl")),
        ], vec![
            arco("e1","o","output","jn","input_left"), arco("e2","c","output","jn","input_right"),
            arco("e3","jn","output","out","input"),
        ], json!({}));
        let esito = esegui(p).await;
        diff.extend(confronta("join", &o, &["unite.jsonl"], &esito, "completed"));
    }

    let _ = std::fs::remove_dir_all(&base);
    // Anche rigenerando, un run che non finisce come previsto è un errore: non
    // si registra come "atteso" l'output di un run fallito.
    assert!(diff.is_empty(), "il motore produce un output diverso dall'atteso:\n{}", diff.join("\n"));
    if std::env::var("FLOWPILOT_AGGIORNA_ATTESI").is_ok() {
        eprintln!("attesi rigenerati in tests/regressione/: controlla il diff in git");
    }
}
