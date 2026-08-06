// ─── src-tauri/src/engine/nodes/github_source.rs ──────────────────
//
// Sorgente GitHub (lettura) — un nodo, tre entità (repos / issues / commits) e
// DUE modalità:
//   • config   → owner/repo dai prop del nodo (target fisso); input = trigger;
//   • per-riga → owner/repo dai CAMPI delle righe in ingresso (fan-out da una
//                lista: source_file → github_source). Ogni riga emessa porta
//                anche `_repo` (owner/repo di provenienza) per aggregare a valle.
//
// Connessione (token, baseUrl) dalla risorsa `kind:'github'`; HTTP via reqwest
// con gli helper condivisi `crate::github_client()` / `crate::github_base()`.
// PAGINAZIONE reale via header `Link` rel="next" (no troncamento silenzioso),
// con eventuale tetto `maxItems` (per richiesta). Colonne = schema del Panel.

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
fn jstr_array(v: &Json, key: &str) -> Value {
    match v.get(key) {
        Some(Json::Array(a)) => Value::from_json(Json::Array(a.clone())),
        _ => Value::from_json(Json::Array(vec![])),
    }
}
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

/// Fetch paginata di un'entità per un (owner, repo). Emette le righe su `tx`;
/// se `tag_repo` è Some, aggiunge la colonna `_repo`. Ritorna il conteggio.
/// NON chiama emit_failed: è il chiamante a decidere (fail vs skip-and-log).
#[allow(clippy::too_many_arguments)]
async fn fetch_entity(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    entity: &str,
    owner: &str,
    repo: &str,
    owner_type: &str,
    state: &str,
    branch: &str,
    include_prs: bool,
    per_page: u32,
    max_items: u64,
    tag_repo: Option<&str>,
    tx: &Option<RowSender>,
    ctx: &NodeContext,
) -> Result<u64, String> {
    let (path, extra_query) = match entity {
        "issues" => {
            if owner.is_empty() || repo.is_empty() { return Err("owner/repo mancanti".to_string()); }
            (format!("/repos/{}/{}/issues", owner, repo), format!("&state={}", state))
        }
        "commits" => {
            if owner.is_empty() || repo.is_empty() { return Err("owner/repo mancanti".to_string()); }
            let q = if branch.is_empty() { String::new() } else { format!("&sha={}", branch) };
            (format!("/repos/{}/{}/commits", owner, repo), q)
        }
        _ => {
            if owner.is_empty() { return Err("owner mancante".to_string()); }
            let seg = if owner_type == "user" { "users" } else { "orgs" };
            (format!("/{}/{}/repos", seg, owner), String::new())
        }
    };

    let mut count = 0u64;
    let mut page = 1u32;

    loop {
        if ctx.cancel.is_cancelled() { break; }

        let url = format!("{}{}?per_page={}&page={}{}", base, path, per_page, page, extra_query);
        let mut req = client.get(url.as_str())
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if !token.trim().is_empty() {
            req = req.bearer_auth(token.trim());
        }

        let resp = req.send().await.map_err(|e| format!("richiesta fallita — {}", e))?;
        let status = resp.status();
        let has_next = resp.headers().get("link")
            .and_then(|h| h.to_str().ok())
            .map(|s| s.contains("rel=\"next\""))
            .unwrap_or(false);

        if !status.is_success() {
            let code = status.as_u16();
            return Err(match code {
                403 => "rate limit o accesso negato (403)".to_string(),
                404 => "non trovato (404)".to_string(),
                401 => "token non valido (401)".to_string(),
                _   => format!("HTTP {}", code),
            });
        }

        let body: Json = resp.json().await.map_err(|e| format!("JSON non valido — {}", e))?;
        let arr = match body {
            Json::Array(a) => a,
            _ => return Err("risposta inattesa (atteso un array)".to_string()),
        };
        if arr.is_empty() { break; }

        for it in &arr {
            if max_items > 0 && count >= max_items { return Ok(count); }

            let mut row = match entity {
                "issues" => {
                    if !include_prs && it.get("pull_request").is_some() { continue; }
                    map_issue(it)
                }
                "commits" => map_commit(it),
                _         => map_repo(it),
            };
            if let Some(tag) = tag_repo {
                row.set("_repo".into(), Value::String(tag.to_string()));
            }
            if let Some(t) = tx {
                if t.send(row).await.is_err() { return Ok(count); }
            }
            count += 1;
        }

        if !has_next { break; }
        page += 1;
    }

    Ok(count)
}

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("github_source {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("github_source", &ctx.node_id.0);

    // Connessione dalla risorsa (o prop in fallback).
    let (token, base_url) = if spec.has_resource() {
        (spec.res_str_or("token", ""), spec.res_str_or("baseUrl", ""))
    } else {
        (spec.str_or("token", ""), spec.str_or("baseUrl", ""))
    };
    let base = crate::github_base(&crate::GithubConnection { token: token.clone(), base_url });

    let mode        = spec.str_or("mode", "config");
    let entity      = spec.str_or("entity", "repos");
    let owner_type  = spec.str_or("ownerType", "org");
    let state       = spec.str_or("state", "open");
    let branch      = spec.str_or("branch", "");
    let include_prs = spec.str_or("includePRs", "false") == "true";
    let per_page    = spec.str_or("perPage", "100").parse::<u32>().unwrap_or(100).clamp(1, 100);
    let max_items   = spec.str_or("maxItems", "0").parse::<u64>().unwrap_or(0);

    let client = crate::github_client()?;
    let start = Instant::now();
    let mut rows_out = 0u64;

    if mode == "per_row" {
        // Fan-out: owner/repo dalle righe in ingresso.
        let owner_field = spec.str_or("ownerField", "owner");
        let repo_field  = spec.str_or("repoField", "repo");

        let mut input: Vec<Row> = Vec::new();
        if let Some(mut rxc) = rx {
            while let Some(r) = rxc.recv().await { input.push(r); }
        }
        ctx.emit_log(&ctx.label, "info", 0,
            format!("GitHub per-riga: {} — {} target", entity, input.len()), "panel");

        for row in &input {
            if ctx.cancel.is_cancelled() { break; }
            let ow = row.get(&owner_field).map(|v| v.as_str_repr()).unwrap_or_default();
            let rp = row.get(&repo_field).map(|v| v.as_str_repr()).unwrap_or_default();
            if ow.is_empty() { continue; }
            let tag = if rp.is_empty() { ow.clone() } else { format!("{}/{}", ow, rp) };

            match fetch_entity(&client, &base, &token, &entity, &ow, &rp, &owner_type,
                               &state, &branch, include_prs, per_page, max_items, Some(&tag), &tx, &ctx).await {
                Ok(n)  => rows_out += n,
                // un target che fallisce (404, ecc.) non ferma gli altri.
                Err(e) => ctx.emit_log(&ctx.label, "warn", 0, format!("GitHub [{}]: {}", tag, e), "panel"),
            }
        }
    } else {
        // Da configurazione: un target fisso, input = solo trigger.
        let _ = super::source_input::await_params(&ctx.node_id.0, "github_source", rx).await?;
        let owner = spec.str_or("owner", "");
        let repo  = spec.str_or("repo", "");
        ctx.emit_log(&ctx.label, "info", 0, format!("GitHub: {} — {}/{}", entity, owner, repo), "panel");

        rows_out = fetch_entity(&client, &base, &token, &entity, &owner, &repo, &owner_type,
                                &state, &branch, include_prs, per_page, max_items, None, &tx, &ctx)
            .await
            .map_err(|e| {
                let m = format!("github_source {}: {}", ctx.node_id.0, e);
                ctx.emit_failed(m.clone()); m
            })?;
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
