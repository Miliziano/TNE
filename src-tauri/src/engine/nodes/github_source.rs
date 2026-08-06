// ─── src-tauri/src/engine/nodes/github_source.rs ──────────────────
//
// Sorgente GitHub (lettura) — un nodo, tre entità (repos / issues / commits).
// Connessione (token, baseUrl) dalla risorsa `kind:'github'`; HTTP via reqwest
// con gli helper condivisi `crate::github_client()` / `crate::github_base()`.
// PAGINAZIONE reale via header `Link` rel="next" (no troncamento silenzioso),
// con eventuale tetto `maxItems`. Le colonne emesse combaciano con lo schema
// dichiarato dal Panel (src/nodes/types/github_source/Panel.tsx).
//
// NB: modalità da-CONFIG (owner/repo dai prop del nodo). La modalità per-riga
// (owner/repo dalle righe in ingresso) è una fetta futura: qui l'input è solo
// un trigger.

use std::time::Instant;
use serde_json::Value as Json;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

// ── helper di estrazione JSON → Value del motore ──────────────────
fn jstr(v: &Json, key: &str) -> Value {
    match v.get(key) {
        Some(Json::String(s)) => Value::String(s.clone()),
        Some(Json::Null) | None => Value::Null,
        Some(other) => Value::String(other.to_string()),
    }
}
fn jint(v: &Json, key: &str) -> Value {
    v.get(key).and_then(|x| x.as_i64()).map(Value::Int).unwrap_or(Value::Null)
}
fn jbool(v: &Json, key: &str) -> Value {
    Value::Bool(v.get(key).and_then(|x| x.as_bool()).unwrap_or(false))
}
fn jpath(v: &Json, path: &[&str]) -> Value {
    let mut cur = v;
    for k in path {
        match cur.get(k) { Some(n) => cur = n, None => return Value::Null }
    }
    match cur {
        Json::String(s) => Value::String(s.clone()),
        Json::Null      => Value::Null,
        other           => Value::String(other.to_string()),
    }
}
/// Array di stringhe (es. topics).
fn jstr_array(v: &Json, key: &str) -> Value {
    match v.get(key) {
        Some(Json::Array(a)) => Value::from_json(Json::Array(a.clone())),
        _ => Value::from_json(Json::Array(vec![])),
    }
}
/// Array di un sotto-campo di oggetti (es. labels[].name, assignees[].login).
fn jobj_field_array(v: &Json, key: &str, field: &str) -> Value {
    let items = v.get(key).and_then(|x| x.as_array()).map(|a| {
        a.iter()
            .filter_map(|o| o.get(field).and_then(|f| f.as_str()).map(|s| Json::String(s.to_string())))
            .collect::<Vec<_>>()
    }).unwrap_or_default();
    Value::from_json(Json::Array(items))
}

fn map_repo(it: &Json) -> Row {
    let mut r = Row::new();
    r.set("full_name".into(),         jstr(it, "full_name"));
    r.set("name".into(),              jstr(it, "name"));
    r.set("owner_login".into(),       jpath(it, &["owner", "login"]));
    r.set("description".into(),       jstr(it, "description"));
    r.set("private".into(),           jbool(it, "private"));
    r.set("fork".into(),              jbool(it, "fork"));
    r.set("language".into(),          jstr(it, "language"));
    r.set("stargazers_count".into(),  jint(it, "stargazers_count"));
    r.set("forks_count".into(),       jint(it, "forks_count"));
    r.set("open_issues_count".into(), jint(it, "open_issues_count"));
    r.set("default_branch".into(),    jstr(it, "default_branch"));
    r.set("topics".into(),            jstr_array(it, "topics"));
    r.set("html_url".into(),          jstr(it, "html_url"));
    r.set("created_at".into(),        jstr(it, "created_at"));
    r.set("updated_at".into(),        jstr(it, "updated_at"));
    r.set("pushed_at".into(),         jstr(it, "pushed_at"));
    r
}

fn map_issue(it: &Json) -> Row {
    let mut r = Row::new();
    r.set("number".into(),          jint(it, "number"));
    r.set("title".into(),           jstr(it, "title"));
    r.set("state".into(),           jstr(it, "state"));
    r.set("user_login".into(),      jpath(it, &["user", "login"]));
    r.set("labels".into(),          jobj_field_array(it, "labels", "name"));
    r.set("assignees".into(),       jobj_field_array(it, "assignees", "login"));
    r.set("comments".into(),        jint(it, "comments"));
    r.set("is_pull_request".into(), Value::Bool(it.get("pull_request").is_some()));
    r.set("html_url".into(),        jstr(it, "html_url"));
    r.set("created_at".into(),      jstr(it, "created_at"));
    r.set("updated_at".into(),      jstr(it, "updated_at"));
    r.set("closed_at".into(),       jstr(it, "closed_at"));
    r.set("body".into(),            jstr(it, "body"));
    r
}

fn map_commit(it: &Json) -> Row {
    let mut r = Row::new();
    r.set("sha".into(),            jstr(it, "sha"));
    r.set("message".into(),        jpath(it, &["commit", "message"]));
    r.set("author_name".into(),    jpath(it, &["commit", "author", "name"]));
    r.set("author_email".into(),   jpath(it, &["commit", "author", "email"]));
    r.set("author_date".into(),    jpath(it, &["commit", "author", "date"]));
    r.set("committer_name".into(), jpath(it, &["commit", "committer", "name"]));
    r.set("committer_date".into(), jpath(it, &["commit", "committer", "date"]));
    r.set("html_url".into(),       jstr(it, "html_url"));
    r
}

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("github_source {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("github_source", &ctx.node_id.0);

    // Input = solo trigger (modalità da-config).
    let _ = super::source_input::await_params(&ctx.node_id.0, "github_source", rx).await?;

    // Connessione dalla risorsa (o prop in fallback).
    let (token, base_url) = if spec.has_resource() {
        (spec.res_str_or("token", ""), spec.res_str_or("baseUrl", ""))
    } else {
        (spec.str_or("token", ""), spec.str_or("baseUrl", ""))
    };
    let base = crate::github_base(&crate::GithubConnection { token: token.clone(), base_url });

    // Parametri (prop del nodo).
    let entity      = spec.str_or("entity", "repos");
    let owner       = spec.str_or("owner", "");
    let repo        = spec.str_or("repo", "");
    let owner_type  = spec.str_or("ownerType", "org");
    let state       = spec.str_or("state", "open");
    let branch      = spec.str_or("branch", "");
    let include_prs = spec.str_or("includePRs", "false") == "true";
    let per_page    = spec.str_or("perPage", "100").parse::<u32>().unwrap_or(100).clamp(1, 100);
    let max_items   = spec.str_or("maxItems", "0").parse::<u64>().unwrap_or(0);

    // Endpoint + query per entità (con validazione).
    let (path, extra_query) = match entity.as_str() {
        "issues" => {
            if owner.is_empty() || repo.is_empty() {
                let m = format!("github_source {}: owner/repo mancanti", ctx.node_id.0);
                ctx.emit_failed(m.clone()); return Err(m);
            }
            (format!("/repos/{}/{}/issues", owner, repo), format!("&state={}", state))
        }
        "commits" => {
            if owner.is_empty() || repo.is_empty() {
                let m = format!("github_source {}: owner/repo mancanti", ctx.node_id.0);
                ctx.emit_failed(m.clone()); return Err(m);
            }
            let q = if branch.is_empty() { String::new() } else { format!("&sha={}", branch) };
            (format!("/repos/{}/{}/commits", owner, repo), q)
        }
        _ => {
            if owner.is_empty() {
                let m = format!("github_source {}: owner (org/utente) mancante", ctx.node_id.0);
                ctx.emit_failed(m.clone()); return Err(m);
            }
            let seg = if owner_type == "user" { "users" } else { "orgs" };
            (format!("/{}/{}/repos", seg, owner), String::new())
        }
    };

    let client = crate::github_client()?;
    let start = Instant::now();
    let mut rows_out = 0u64;
    let mut page = 1u32;

    ctx.emit_log(&ctx.label, "info", 0, format!("GitHub: {} — {}", entity, path), "panel");

    'outer: loop {
        if ctx.cancel.is_cancelled() { break; }

        let url = format!("{}{}?per_page={}&page={}{}", base, path, per_page, page, extra_query);
        let mut req = client.get(url.as_str())
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if !token.trim().is_empty() {
            req = req.bearer_auth(token.trim());
        }

        let resp = req.send().await.map_err(|e| {
            let m = format!("github_source {}: richiesta fallita — {}", ctx.node_id.0, e);
            ctx.emit_failed(m.clone()); m
        })?;

        let status = resp.status();
        let has_next = resp.headers().get("link")
            .and_then(|h| h.to_str().ok())
            .map(|s| s.contains("rel=\"next\""))
            .unwrap_or(false);

        if !status.is_success() {
            let code = status.as_u16();
            let m = match code {
                403 => format!("github_source {}: rate limit o accesso negato (403) — controlla il token", ctx.node_id.0),
                404 => format!("github_source {}: non trovato (404) — owner/repo corretti?", ctx.node_id.0),
                401 => format!("github_source {}: token non valido (401)", ctx.node_id.0),
                _   => format!("github_source {}: GitHub ha risposto HTTP {}", ctx.node_id.0, code),
            };
            ctx.emit_failed(m.clone());
            return Err(m);
        }

        let body: Json = resp.json().await.map_err(|e| {
            let m = format!("github_source {}: JSON non valido — {}", ctx.node_id.0, e);
            ctx.emit_failed(m.clone()); m
        })?;

        let arr = match body {
            Json::Array(a) => a,
            _ => {
                let m = format!("github_source {}: risposta inattesa (atteso un array)", ctx.node_id.0);
                ctx.emit_failed(m.clone()); return Err(m);
            }
        };
        if arr.is_empty() { break; }

        for it in &arr {
            if max_items > 0 && rows_out >= max_items { break 'outer; }

            let row = match entity.as_str() {
                "issues" => {
                    // L'endpoint issues include i PR: filtrabili.
                    if !include_prs && it.get("pull_request").is_some() { continue; }
                    map_issue(it)
                }
                "commits" => map_commit(it),
                _         => map_repo(it),
            };

            if let Some(t) = &tx {
                if t.send(row).await.is_err() { break 'outer; }
            }
            rows_out += 1;
        }

        if !has_next { break; }
        page += 1;
    }

    ctx.emit_log(&ctx.label, "ok", 0,
        format!("GitHub {}: {} righe in {}ms", entity, rows_out, start.elapsed().as_millis()), "panel");

    let stats = NodeStats {
        rows_in: 0, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
