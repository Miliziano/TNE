// ─── src-tauri/src/engine/nodes/source_http.rs ────────────────────
//
// Sorgente HTTP (client). PORTING DA ZERO in reqwest: a differenza di
// ftp/mqtt/stomp, il client HTTP NON esisteva in Rust (il runner lo faceva
// in TS con `fetch`). Qui c'è il NUCLEO condiviso della famiglia HTTP —
// helper `pub(crate)` riusati poi da http_request e sink_http (fonte unica).
//
// Modello: source_http fa UNA chiamata per ogni riga in ingresso (con
// interpolazione `${campo}`), o UNA sola con riga vuota se non c'è input.
// Le righe di risposta escono su `output`.
//
// v1 (questo patch): auth none/basic/bearer/api_key/oauth2_ac/oauth2_cc;
// body none/json/raw/binary; retry (codici+delay); responseType json
// (+jsonPath+customFields)/json_raw/text/xml/csv/binary(+pdf→base64).
// RINVIATI al patch successivo: auth **digest** (serve crate md-5 + dance),
// **paginazione**. Un authType non ancora gestito dà errore esplicito.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use base64::Engine as _;
use md5::{Digest, Md5};
use serde_json::Value as J;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

// ─── Interpolazione `${campo}` ────────────────────────────────────
pub(crate) fn interpolate(template: &str, row: &Row) -> String {
    if !template.contains("${") { return template.to_string(); }
    let mut out = String::with_capacity(template.len());
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'$' && bytes[i + 1] == b'{' {
            if let Some(end) = template[i + 2..].find('}') {
                let name = &template[i + 2..i + 2 + end];
                let val = row.get(name).map(|v| v.as_str_repr()).unwrap_or_default();
                out.push_str(&val);
                i = i + 2 + end + 1;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

// ─── jsonPath minimale: `$`, `$.a.b.c` ────────────────────────────
pub(crate) fn resolve_json_path(root: &J, path: &str) -> Option<J> {
    let p = path.trim();
    if p == "$" || p.is_empty() { return Some(root.clone()); }
    let p = p.strip_prefix("$.").or_else(|| p.strip_prefix('$')).unwrap_or(p);
    let mut cur = root;
    for seg in p.split('.').filter(|s| !s.is_empty()) {
        cur = cur.get(seg)?;
    }
    Some(cur.clone())
}

// ─── Header di autenticazione (+ eventuale api_key in query) ──────
// Ritorna (headers, Option<(nome_query, valore)>). Per oauth2_cc fa il
// fetch del token (con cache). `digest` non è ancora gestito qui.
pub(crate) async fn auth_headers(spec: &Spec)
    -> Result<(Vec<(String, String)>, Option<(String, String)>), String> {
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut api_key_query: Option<(String, String)> = None;

    match spec.str_or("authType", "none").as_str() {
        "none" => {}
        "basic" => {
            let creds = base64::engine::general_purpose::STANDARD
                .encode(format!("{}:{}", spec.str_or("username", ""), spec.str_or("password", "")));
            headers.push(("Authorization".into(), format!("Basic {}", creds)));
        }
        "bearer" => {
            headers.push(("Authorization".into(), format!("Bearer {}", spec.str_or("bearerToken", ""))));
        }
        "oauth2_ac" => {
            headers.push(("Authorization".into(), format!("Bearer {}", spec.str_or("oauth2AccessToken", ""))));
        }
        "oauth2_cc" => {
            let token = oauth2_cc_token(spec).await?;
            headers.push(("Authorization".into(), format!("Bearer {}", token)));
        }
        "api_key" => {
            let name  = spec.str_or("apiKeyName", "api_key");
            let value = spec.str_or("apiKeyValue", "");
            if spec.str_or("apiKeyIn", "header") == "query" {
                api_key_query = Some((name, value));
            } else {
                headers.push((name, value));
            }
        }
        "digest" => {
            // Il digest non si calcola in anticipo: serve la sfida (nonce) del
            // server. Handshake 401→Authorization gestito in execute_single_request.
        }
        other => {
            return Err(format!("authType '{}' non riconosciuto", other));
        }
    }
    Ok((headers, api_key_query))
}

// ─── OAuth2 Client Credentials: token con cache ──────────────────
static OAUTH2_CACHE: OnceLock<Mutex<HashMap<String, (String, Instant)>>> = OnceLock::new();

async fn oauth2_cc_token(spec: &Spec) -> Result<String, String> {
    let token_url = spec.str_or("oauth2TokenUrl", "");
    let client_id = spec.str_or("oauth2ClientId", "");
    let cache_key = format!("{}::{}", token_url, client_id);

    // cache hit?
    if let Some(m) = OAUTH2_CACHE.get() {
        if let Ok(map) = m.lock() {
            if let Some((tok, exp)) = map.get(&cache_key) {
                if *exp > Instant::now() { return Ok(tok.clone()); }
            }
        }
    }

    let secret      = spec.str_or("oauth2ClientSecret", "");
    let client_auth = spec.str_or("oauth2ClientAuth", "body");
    let scope       = spec.str_or("oauth2Scope", "");
    let audience    = spec.str_or("oauth2Audience", "");

    let mut form: Vec<(String, String)> = vec![("grant_type".into(), "client_credentials".into())];
    let mut req = reqwest::Client::new().post(&token_url);
    if client_auth == "basic" {
        let creds = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", client_id, secret));
        req = req.header("Authorization", format!("Basic {}", creds));
    } else {
        form.push(("client_id".into(), client_id));
        form.push(("client_secret".into(), secret));
    }
    if !scope.is_empty()    { form.push(("scope".into(), scope)); }
    if !audience.is_empty() { form.push(("audience".into(), audience)); }

    let res = req.form(&form).send().await
        .map_err(|e| format!("OAuth2 CC: richiesta token fallita: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("OAuth2 CC: token HTTP {}", res.status().as_u16()));
    }
    let body: J = res.json().await.map_err(|e| format!("OAuth2 CC: risposta non JSON: {}", e))?;
    let token = body.get("access_token").and_then(|v| v.as_str())
        .ok_or("OAuth2 CC: 'access_token' assente")?.to_string();
    let expires_in = body.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(3600);

    let map = OAUTH2_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut m) = map.lock() {
        // margine di 30s sulla scadenza
        let exp = Instant::now() + Duration::from_secs(expires_in.saturating_sub(30).max(1));
        m.insert(cache_key, (token.clone(), exp));
    }
    Ok(token)
}

// ─── Corpo della request (none/json/raw/binary) ──────────────────
// Ritorna (Option<bytes>, Option<content_type>).
fn build_body(spec: &Spec, row: &Row, method: &str) -> Result<(Option<Vec<u8>>, Option<String>), String> {
    if !matches!(method, "POST" | "PUT" | "PATCH") { return Ok((None, None)); }
    let has_input = !row.0.is_empty();
    let mode = spec.str_or("inputBodyMode", if has_input { "json" } else { "none" });
    match mode.as_str() {
        "none" => {
            let raw = spec.str_or("body", "");
            if raw.is_empty() { Ok((None, None)) }
            else { Ok((Some(interpolate(&raw, row).into_bytes()),
                       Some(spec.str_or("contentType", "application/json")))) }
        }
        "json" => {
            let template = spec.str_or("inputBodyTemplate", "");
            let s = if !template.is_empty() {
                interpolate(&template, row)
            } else {
                serde_json::to_string(&row_to_json_obj(row)).unwrap_or_else(|_| "{}".into())
            };
            Ok((Some(s.into_bytes()), Some("application/json".into())))
        }
        "raw" => {
            let field = spec.str_or("inputRawField", "");
            let ct    = spec.str_or("inputRawContentType", "text/plain");
            let val   = row.get(&field).map(|v| v.as_str_repr()).unwrap_or_default();
            Ok((Some(val.into_bytes()), Some(ct)))
        }
        "binary" => {
            let field = spec.str_or("inputBinaryField", "content");
            let ct    = spec.str_or("inputBinaryContentType", "application/octet-stream");
            let b64   = row.get(&field).map(|v| v.as_str_repr()).unwrap_or_default();
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim())
                .map_err(|e| format!("body binary: base64 non valido nel campo '{}': {}", field, e))?;
            Ok((Some(bytes), Some(ct)))
        }
        _ => Ok((None, None)),
    }
}

fn row_to_json_obj(row: &Row) -> J {
    let mut m = serde_json::Map::new();
    for (k, v) in row.0.iter() { m.insert(k.clone(), v.to_json()); }
    J::Object(m)
}

// ─── Una singola chiamata (con retry) → righe ────────────────────
#[allow(clippy::too_many_arguments)]
pub(crate) async fn execute_single_request(
    spec:         &Spec,
    client:       &reqwest::Client,
    row:          &Row,
    ctx:          &NodeContext,
    extra_query:  &[(String, String)],
    url_override: Option<&str>,
) -> Result<Vec<Row>, String> {
    let method = spec.str_or("method", "GET").to_uppercase();

    // URL: override (paginazione link) oppure interpolazione
    let url = match url_override {
        Some(u) => u.to_string(),
        None    => interpolate(&spec.str_or("url", ""), row),
    };
    let (auth_h, api_key_q) = auth_headers(spec).await?;

    let mut query: Vec<(String, String)> = Vec::new();
    if let Some((k, v)) = api_key_q { query.push((k, v)); }
    if let Ok(J::Object(qp)) = serde_json::from_str::<J>(&interpolate(&spec.str_or("queryParams", "{}"), row)) {
        for (k, v) in qp { query.push((k, json_scalar_str(&v))); }
    }
    for (k, v) in extra_query { query.push((k.clone(), v.clone())); }
    // Headers: Accept + auth + extra(JSON interpolato) + dinamici da campi
    let mut headers: Vec<(String, String)> = vec![
        ("Accept".into(), "application/json, text/plain, */*".into()),
    ];
    headers.extend(auth_h);
    if let Ok(J::Object(extra)) = serde_json::from_str::<J>(&interpolate(&spec.str_or("headers", "{}"), row)) {
        for (k, v) in extra { headers.push((k, json_scalar_str(&v))); }
    }
    if let Ok(J::Object(mapping)) = serde_json::from_str::<J>(&spec.str_or("inputHeaderMapping", "{}")) {
        for (field, hname) in mapping {
            if let Some(v) = row.get(&field) {
                headers.push((hname.as_str().unwrap_or("").to_string(), v.as_str_repr()));
            }
        }
    }

    let (body, body_ct) = build_body(spec, row, &method)?;
    if let Some(ct) = body_ct {
        if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("content-type")) {
            headers.push(("Content-Type".into(), ct));
        }
    }

    let m = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| format!("metodo HTTP non valido: {}", method))?;

    // Retry
    let retry_count: u32 = spec.u64_or("retryCount", 0) as u32;
    let retry_delay: u64 = spec.u64_or("retryDelay", 5);
    let retry_codes: Vec<u16> = spec.str_or("retryCodes", "429,503,504")
        .split(',').filter_map(|s| s.trim().parse::<u16>().ok()).collect();

    let is_digest = spec.str_or("authType", "none") == "digest";
    let mut digest_header: Option<String> = None;
    let mut attempt: u32 = 0;
    let mut last_err = String::new();
    loop {
        let mut rb = client.request(m.clone(), url.as_str());
        if !query.is_empty() { rb = rb.query(&query); }
        for (k, v) in &headers {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) { rb = rb.header(name, val); }
        }
        if let Some(dh) = &digest_header {
            if let Ok(val) = reqwest::header::HeaderValue::from_str(dh) {
                rb = rb.header(reqwest::header::AUTHORIZATION, val);
            }
        }
        if let Some(b) = &body { rb = rb.body(b.clone()); }

        let t0 = Instant::now();
        match rb.send().await {
            Ok(res) => {
                let status = res.status().as_u16();

                // Digest: primo 401 con sfida → calcola e ritenta SENZA consumare un retry.
                if is_digest && status == 401 && digest_header.is_none() {
                    if let Some(h) = compute_digest_header(&res, spec, &method, url.as_str()) {
                        digest_header = Some(h);
                        continue;
                    }
                }

                if attempt < retry_count && retry_codes.contains(&status) {
                    last_err = format!("HTTP {}", status);
                    attempt += 1;
                    ctx.emit_log(&ctx.label, "warn", 0,
                        format!("HTTP retry {}/{} tra {}s", attempt, retry_count, retry_delay), "panel");
                    tokio::time::sleep(Duration::from_secs(retry_delay)).await;
                    continue;
                }
                if !res.status().is_success() {
                    ctx.emit_log(&ctx.label, "warn", 0,
                        format!("HTTP {} {} -> {}", method, url, status), "panel");
                }
                return process_response(res, spec, t0).await;
            }
            Err(e) => {
                last_err = e.to_string();
                if attempt < retry_count {
                    attempt += 1;
                    ctx.emit_log(&ctx.label, "warn", 0,
                        format!("HTTP retry {}/{} tra {}s", attempt, retry_count, retry_delay), "panel");
                    tokio::time::sleep(Duration::from_secs(retry_delay)).await;
                    continue;
                }
                return Err(format!("HTTP fallita dopo {} tentativi: {}", retry_count + 1, last_err));
            }
        }
    }
}

// ─── Risposta → righe ────────────────────────────────────────────
pub(crate) async fn process_response(res: reqwest::Response, spec: &Spec, t0: Instant) -> Result<Vec<Row>, String> {
    let status = res.status().as_u16();
    let content_type = res.headers().get("content-type")
        .and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let mut hdr_map = serde_json::Map::new();
    for (k, v) in res.headers().iter() {
        hdr_map.insert(k.as_str().to_string(), J::String(v.to_str().unwrap_or("").to_string()));
    }
    let latency = t0.elapsed().as_millis() as i64;

    let fixed = move |row: &mut Row| {
        row.set("status_code".into(),  Value::Int(status as i64));
        row.set("content_type".into(), Value::String(content_type.clone()));
        row.set("latency_ms".into(),   Value::Int(latency));
        row.set("headers".into(),      Value::Object(J::Object(hdr_map.clone())));
    };

    let response_type = spec.str_or("responseType", "json");
    match response_type.as_str() {
        "json" => {
            let text = res.text().await.map_err(|e| format!("lettura risposta: {}", e))?;
            let parsed: J = serde_json::from_str(&text).unwrap_or(J::Null);
            let target = resolve_json_path(&parsed, &spec.str_or("jsonPath", "$")).unwrap_or(J::Null);
            let items: Vec<J> = match target {
                J::Array(a) => a,
                J::Null     => vec![],
                other       => vec![other],
            };
            let custom: Vec<String> = serde_json::from_str::<Vec<serde_json::Value>>(&spec.str_or("customFields", "[]"))
                .ok().map(|v| v.iter().filter_map(|f| f.get("name").and_then(|n| n.as_str()).map(String::from)).collect())
                .unwrap_or_default();
            let mut out = Vec::new();
            for it in items {
                let mut row = Row::new();
                fixed(&mut row);
                if let J::Object(obj) = &it {
                    if custom.is_empty() {
                        for (k, v) in obj { row.set(k.clone(), Value::from_json(v.clone())); }
                    } else {
                        for name in &custom {
                            row.set(name.clone(), obj.get(name).cloned().map(Value::from_json).unwrap_or(Value::Null));
                        }
                    }
                } else {
                    row.set("value".into(), Value::from_json(it));
                }
                out.push(row);
            }
            Ok(out)
        }
        "json_raw" => {
            let text = res.text().await.map_err(|e| format!("lettura risposta: {}", e))?;
            let parsed: J = serde_json::from_str(&text).unwrap_or(J::Null);
            let mut row = Row::new();
            fixed(&mut row);
            row.set("body".into(), Value::String(text));
            row.set("body_parsed".into(), Value::from_json(parsed));
            Ok(vec![row])
        }
        "binary" | "pdf" => {
            let bytes = res.bytes().await.map_err(|e| format!("lettura risposta: {}", e))?;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let mut row = Row::new();
            fixed(&mut row);
            row.set("content".into(), Value::String(b64));
            row.set("content_length".into(), Value::Int(bytes.len() as i64));
            Ok(vec![row])
        }
        _ => {
            // text / xml / csv / default
            let body = res.text().await.map_err(|e| format!("lettura risposta: {}", e))?;
            let mut row = Row::new();
            fixed(&mut row);
            row.set("body".into(), Value::String(body));
            Ok(vec![row])
        }
    }
}

fn json_scalar_str(v: &J) -> String {
    match v {
        J::String(s) => s.clone(),
        other        => other.to_string(),
    }
}

// ─── HTTP Digest (RFC 2617/7616) challenge-response ──────────────
// Calcola l'header Authorization: Digest dalla sfida WWW-Authenticate del 401.
fn compute_digest_header(res: &reqwest::Response, spec: &Spec, method: &str, url: &str) -> Option<String> {
    let raw = res.headers().get("www-authenticate")?.to_str().ok()?.trim().to_string();
    if !raw.to_ascii_lowercase().starts_with("digest") { return None; }
    let params = parse_digest_challenge(&raw["Digest".len()..]);

    let realm     = params.get("realm").cloned().unwrap_or_default();
    let nonce     = params.get("nonce").cloned().unwrap_or_default();
    let opaque    = params.get("opaque").cloned();
    let algorithm = params.get("algorithm").cloned().unwrap_or_else(|| "MD5".to_string());
    let qop_raw   = params.get("qop").cloned().unwrap_or_default();
    let use_qop   = qop_raw.split(',').any(|q| q.trim() == "auth");

    let username = spec.str_or("username", "");
    let password = spec.str_or("password", "");
    let uri      = request_uri(url);
    let cnonce   = gen_cnonce();
    let nc       = "00000001";

    let ha1_base = md5_hex(&format!("{}:{}:{}", username, realm, password));
    let ha1 = if algorithm.eq_ignore_ascii_case("MD5-sess") {
        md5_hex(&format!("{}:{}:{}", ha1_base, nonce, cnonce))
    } else { ha1_base };
    let ha2 = md5_hex(&format!("{}:{}", method, uri));
    let response = if use_qop {
        md5_hex(&format!("{}:{}:{}:{}:auth:{}", ha1, nonce, nc, cnonce, ha2))
    } else {
        md5_hex(&format!("{}:{}:{}", ha1, nonce, ha2))
    };

    let mut h = format!(
        "Digest username=\"{}\", realm=\"{}\", nonce=\"{}\", uri=\"{}\", response=\"{}\"",
        username, realm, nonce, uri, response);
    if !algorithm.is_empty() { h.push_str(&format!(", algorithm={}", algorithm)); }
    if use_qop { h.push_str(&format!(", qop=auth, nc={}, cnonce=\"{}\"", nc, cnonce)); }
    if let Some(o) = opaque { h.push_str(&format!(", opaque=\"{}\"", o)); }
    Some(h)
}

// Parser pragmatico della sfida: coppie k=v separate da virgola, valori tra
// virgolette opzionali. (qop="auth,auth-int" si spezza ma use_qop resta corretto.)
fn parse_digest_challenge(s: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for part in s.split(',') {
        let part = part.trim();
        if let Some(eq) = part.find('=') {
            let k = part[..eq].trim().to_ascii_lowercase();
            let v = part[eq + 1..].trim().trim_matches('"').to_string();
            if !k.is_empty() { m.insert(k, v); }
        }
    }
    m
}

// request-URI per il digest: path (+ query se già presente nell'URL).
// ⚠️ i query param aggiunti via reqwest.query() non sono inclusi qui — v1.
fn request_uri(url: &str) -> String {
    if let Some(idx) = url.find("://") {
        let after = &url[idx + 3..];
        return match after.find('/') { Some(sl) => after[sl..].to_string(), None => "/".to_string() };
    }
    if url.starts_with('/') { url.to_string() } else { format!("/{}", url) }
}

fn md5_hex(s: &str) -> String {
    let mut h = Md5::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

fn gen_cnonce() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let hexed = md5_hex(&format!("{}", n));
    hexed[..16].to_string()
}

// ─── Paginazione (page / offset / cursor / link) ─────────────────
pub(crate) async fn execute_with_pagination(
    spec:   &Spec,
    client: &reqwest::Client,
    row:    &Row,
    ctx:    &NodeContext,
) -> Result<Vec<Row>, String> {
    let pagination = spec.str_or("pagination", "none");
    if pagination == "none" {
        return execute_single_request(spec, client, row, ctx, &[], None).await;
    }

    let max_pages = spec.u64_or("maxPages", 0);
    let page_size = spec.u64_or("pageSize", 100);
    let mut page  = spec.u64_or("pageStart", 1);
    let mut offset   = 0u64;
    let mut cursor   = String::new();
    let mut link_url: Option<String> = None;
    let mut page_num = 0u64;
    let mut all: Vec<Row> = Vec::new();

    loop {
        if max_pages != 0 && page_num >= max_pages { break; }
        page_num += 1;

        // Query params di paginazione per questa pagina
        let mut extra: Vec<(String, String)> = Vec::new();
        match pagination.as_str() {
            "page" => {
                extra.push((spec.str_or("pageParam", "page"), page.to_string()));
                let lp = spec.str_or("limitParam", "limit");
                extra.push((if lp.is_empty() { "page_size".into() } else { lp }, page_size.to_string()));
            }
            "offset" => {
                extra.push((spec.str_or("offsetParam", "offset"), offset.to_string()));
                extra.push((spec.str_or("limitParam", "limit"), page_size.to_string()));
            }
            "cursor" => {
                if !cursor.is_empty() { extra.push((spec.str_or("cursorParam", "cursor"), cursor.clone())); }
                extra.push(("limit".into(), page_size.to_string()));
            }
            _ => {} // link: niente param, si usa url_override
        }

        let page_rows = execute_single_request(spec, client, row, ctx, &extra, link_url.as_deref()).await?;
        let got = page_rows.len() as u64;

        // Determina se c'è un'altra pagina (prima di consumare page_rows)
        let mut has_more = false;
        match pagination.as_str() {
            "page"   => { has_more = got >= page_size; page += 1; }
            "offset" => { has_more = got >= page_size; offset += page_size; }
            "cursor" => {
                let cpath = spec.str_or("cursorPath", "$.meta.next_cursor");
                cursor = page_rows.first().map(|r| {
                    let src = match r.0.get("body_parsed") {
                        Some(Value::Object(bp)) => bp.clone(),
                        _                       => row_to_json_obj(r),
                    };
                    resolve_json_path(&src, &cpath).map(|v| json_scalar_str(&v)).unwrap_or_default()
                }).unwrap_or_default();
                has_more = !cursor.is_empty();
            }
            "link" => {
                let next = page_rows.first().and_then(|r| match r.0.get("headers") {
                    Some(Value::Object(J::Object(h))) => h.get("link").and_then(|v| v.as_str()).and_then(parse_link_next),
                    _ => None,
                });
                has_more = next.is_some();
                link_url = next;
            }
            _ => {}
        }

        all.extend(page_rows);
        ctx.emit_log(&ctx.label, "info", 0,
            format!("HTTP paginazione {} pagina {}: {} righe", pagination, page_num, got), "panel");
        if !has_more { break; }
    }
    Ok(all)
}

// Estrae l'URL con rel="next" da un header Link.
fn parse_link_next(link: &str) -> Option<String> {
    for part in link.split(',') {
        if part.contains("rel=\"next\"") || part.contains("rel=next") {
            if let (Some(a), Some(b)) = (part.find('<'), part.find('>')) {
                if a < b { return Some(part[a + 1..b].to_string()); }
            }
        }
    }
    None
}

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("source_http {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("source_http", &ctx.node_id.0);

    if spec.str_or("url", "").trim().is_empty() {
        let msg = format!("source_http {}: URL non configurato", ctx.node_id.0);
        ctx.emit_failed(msg.clone());
        return Err(msg);
    }
    let passthrough = spec.bool_or("passthroughInput", false);

    // Righe in ingresso: una chiamata per riga, o una con riga vuota.
    let mut inputs: Vec<Row> = Vec::new();
    if let Some(mut rx) = rx {
        while let Some(row) = rx.recv().await { inputs.push(row); }
    }
    if inputs.is_empty() { inputs.push(Row::new()); }

    let tx = match tx {
        Some(t) => t,
        None => return Ok(NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0, elapsed_ms: 0, error: None }),
    };

    let timeout = spec.u64_or("timeout", 30);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|e| format!("source_http {}: client: {}", ctx.node_id.0, e))?;

    let start = Instant::now();
    let single = inputs.len() == 1;
    let mut rows_out = 0u64;

    for row in &inputs {
        match execute_with_pagination(&spec, &client, row, &ctx).await {
            Ok(resp_rows) => {
                for mut rr in resp_rows {
                    if passthrough && !row.0.is_empty() {
                        for (k, v) in row.0.iter() {
                            rr.0.entry(k.clone()).or_insert_with(|| v.clone());
                        }
                    }
                    rows_out += 1;
                    if tx.send(rr).await.is_err() { break; }
                }
            }
            Err(e) => {
                // input singolo che fallisce → errore di nodo; altrimenti riga d'errore e continua.
                if single {
                    let msg = format!("source_http {}: {}", ctx.node_id.0, e);
                    ctx.emit_failed(msg.clone());
                    return Err(msg);
                }
                ctx.emit_log(&ctx.label, "error", 0, format!("HTTP errore su una riga: {}", e), "panel");
                let mut er = Row::new();
                er.set("status_code".into(),  Value::Int(0));
                er.set("content_type".into(), Value::String(String::new()));
                er.set("latency_ms".into(),   Value::Int(0));
                er.set("headers".into(),      Value::Object(J::Object(serde_json::Map::new())));
                er.set("_error".into(),       Value::String(e));
                if passthrough {
                    for (k, v) in row.0.iter() { er.0.entry(k.clone()).or_insert_with(|| v.clone()); }
                }
                rows_out += 1;
                if tx.send(er).await.is_err() { break; }
            }
        }
    }

    let stats = NodeStats {
        rows_in: inputs.len() as u64, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
