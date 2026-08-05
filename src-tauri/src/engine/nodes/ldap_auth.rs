// ─── src-tauri/src/engine/nodes/ldap_auth.rs ──────────────────────
//
// Autenticatore LDAP (FETTA 3b) — per ogni riga verifica le credenziali con
// SEARCH-THEN-BIND: bind come account di servizio (dalla risorsa) → cerca
// l'utente per l'attributo di login → SECONDO bind con la password dell'utente.
// Righe autenticate → porta «output»; fallite → porta «reject» (per instradare
// es. un 401 via webhook_responder). Riusa `crate::ldap_connect_and_bind`.
//
// Difese (ethos "mai finto"):
//   - password vuota → RIFIUTO (un bind anonimo "riesce" → falso positivo);
//   - escape RFC 4515 sullo username nel filtro (anti LDAP-injection);
//   - la search deve dare ESATTAMENTE 1 voce (0/>1 → reject);
//   - la password dell'utente non viene MAI loggata né rimessa in una riga.
//
// Riferimento studio: src/nodes/types/ldap_auth/Panel.tsx.

use std::collections::HashMap;
use std::time::Instant;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::LdapConnection;
use ldap3::{Scope, SearchEntry};

/// Escape RFC 4515 del valore inserito in un filtro LDAP (anti-injection).
fn escape_ldap_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '*'  => out.push_str("\\2a"),
            '('  => out.push_str("\\28"),
            ')'  => out.push_str("\\29"),
            '\\' => out.push_str("\\5c"),
            '\0' => out.push_str("\\00"),
            _    => out.push(c),
        }
    }
    out
}

/// Esegue il search-then-bind per una credenziale. Ok(attrs) = autenticato.
#[allow(clippy::too_many_arguments)]
async fn authenticate(
    service_ldap:  &mut ldap3::Ldap,
    service_conn:  &LdapConnection,
    base_dn:       &str,
    login_attr:    &str,
    user_filter:   &str,
    search_attrs:  &[String],
    require_group: &str,
    username:      &str,
    user_password: &str,
) -> Result<HashMap<String, Vec<String>>, String> {
    // Credenziali presenti (password vuota = rifiuto: niente bind anonimo).
    if username.is_empty() || user_password.is_empty() {
        return Err("credenziali mancanti (username o password vuota)".to_string());
    }

    // Search dell'utente, con escape del valore nel filtro.
    let esc = escape_ldap_value(username);
    let filter = if user_filter.is_empty() {
        format!("({}={})", login_attr, esc)
    } else {
        format!("(&({}={}){})", login_attr, esc, user_filter)
    };
    let (entries, _res) = service_ldap
        .search(base_dn, Scope::Subtree, &filter, search_attrs.to_vec())
        .await.map_err(|e| format!("search fallita: {}", e))?
        .success().map_err(|e| format!("search rifiutata: {}", e))?;

    if entries.is_empty()  { return Err("utente non trovato".to_string()); }
    if entries.len() > 1   { return Err("più voci corrispondono (ambiguo)".to_string()); }
    let se = SearchEntry::construct(entries.into_iter().next().unwrap());

    // SECONDO bind: come l'utente, con la sua password (riusa l'helper condiviso,
    // che rifiuta la password vuota e fa simple_bind().success()).
    let mut user_conn = service_conn.clone();
    user_conn.bind_dn  = se.dn.clone();
    user_conn.password = user_password.to_string();
    match crate::ldap_connect_and_bind(&user_conn).await {
        Ok(mut l) => { let _ = l.unbind().await; }
        Err(_)    => return Err("password non valida".to_string()),
    }

    // Autorizzazione opzionale: appartenenza a un gruppo.
    if !require_group.is_empty() {
        let groups = se.attrs.get("memberOf").cloned().unwrap_or_default();
        if !groups.iter().any(|g| g.eq_ignore_ascii_case(require_group)) {
            return Err("non appartiene al gruppo richiesto".to_string());
        }
    }

    Ok(se.attrs)
}

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    outputs: HashMap<String, RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("ldap_auth {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("ldap_auth", &ctx.node_id.0);

    // Connessione di SERVIZIO (dalla risorsa o prop) — per le search.
    let (host, port, tls_mode, verify_cert, bind_dn, password, res_base_dn, connect_timeout_sec): (
        String, u16, String, bool, String, String, String, u64,
    ) = if spec.has_resource() {
        (
            spec.res_str_or("host", ""),
            spec.res_u16_or("port", 636),
            spec.res_str_or("tlsMode", "ldaps"),
            spec.res_str_or("verifyCert", "true") == "true",
            spec.res_str_or("bindDN", ""),
            spec.res_str_or("password", ""),
            spec.res_str_or("baseDN", ""),
            spec.res_u64_or("connectTimeout", 10),
        )
    } else {
        (
            spec.str_or("host", ""),
            spec.str_or("port", "636").parse().unwrap_or(636),
            spec.str_or("tlsMode", "ldaps"),
            spec.str_or("verifyCert", "true") == "true",
            spec.str_or("bindDN", ""),
            spec.str_or("password", ""),
            spec.str_or("baseDN", ""),
            spec.str_or("connectTimeout", "10").parse().unwrap_or(10),
        )
    };

    let service_conn = LdapConnection {
        host: host.clone(), port, tls_mode, verify_cert,
        bind_dn, password, base_dn: res_base_dn.clone(), connect_timeout_sec,
    };

    // Config auth (prop del nodo).
    let username_field = spec.str_or("usernameField", "username");
    let password_field = spec.str_or("passwordField", "password");
    let login_attr     = spec.str_or("loginAttribute", "uid");
    let base_dn        = { let b = spec.str_or("baseDN", ""); if b.is_empty() { res_base_dn } else { b } };
    let user_filter    = spec.str_or("userFilter", "");
    let require_group  = spec.str_or("requireGroup", "");
    let return_attrs: Vec<String> = spec.str_or("returnAttributes", "")
        .split(',').map(|a| a.trim().to_string()).filter(|a| !a.is_empty()).collect();

    if service_conn.host.is_empty() {
        let m = format!("ldap_auth {}: host non configurato (collega una risorsa LDAP)", ctx.node_id.0);
        ctx.emit_failed(m.clone());
        return Err(m);
    }

    // Attributi da recuperare: quelli richiesti + memberOf se serve requireGroup.
    let mut search_attrs: Vec<String> = return_attrs.clone();
    if !require_group.is_empty() && !search_attrs.iter().any(|a| a.eq_ignore_ascii_case("memberOf")) {
        search_attrs.push("memberOf".to_string());
    }
    if search_attrs.is_empty() { search_attrs.push("cn".to_string()); }

    let out_tx    = outputs.get("output");
    let reject_tx = outputs.get("reject");

    let start = Instant::now();

    // Bind di servizio (una volta) per tutte le search.
    let mut service_ldap = crate::ldap_connect_and_bind(&service_conn).await.map_err(|e| {
        let m = format!("ldap_auth {}: {}", ctx.node_id.0, e);
        ctx.emit_failed(m.clone());
        m
    })?;

    let mut rows_in = 0u64;
    let mut rows_out = 0u64;
    let mut rows_rejected = 0u64;

    while let Some(mut row) = rx.recv().await {
        if ctx.cancel.is_cancelled() { break; }
        rows_in += 1;

        let username = row.get(&username_field).map(|v| v.as_str_repr()).unwrap_or_default();
        let user_password = row.get(&password_field).map(|v| v.as_str_repr()).unwrap_or_default();

        let outcome = authenticate(
            &mut service_ldap, &service_conn, &base_dn, &login_attr, &user_filter,
            &search_attrs, &require_group, &username, &user_password,
        ).await;

        // La password non deve restare nella riga in uscita.
        row.set(password_field.clone(), Value::Null);

        match outcome {
            Ok(attrs) => {
                row.set("authenticated".into(), Value::Bool(true));
                for k in &return_attrs {
                    let values = attrs.get(k).cloned().unwrap_or_default();
                    row.set(k.clone(), Value::from_json(serde_json::Value::Array(
                        values.into_iter().map(serde_json::Value::String).collect())));
                }
                ctx.emit_log(&ctx.label, "ok", 0, format!("Auth OK: {}", username), "panel");
                if let Some(t) = out_tx {
                    if t.send(row).await.is_err() { break; }
                }
                rows_out += 1;
            }
            Err(reason) => {
                row.set("authenticated".into(), Value::Bool(false));
                row.set("auth_error".into(), Value::String(reason.clone()));
                ctx.emit_log(&ctx.label, "warn", 0, format!("Auth FALLITA: {} — {}", username, reason), "panel");
                if let Some(t) = reject_tx {
                    let _ = t.send(row).await;
                }
                rows_rejected += 1;
            }
        }
    }

    let _ = service_ldap.unbind().await;

    let stats = NodeStats {
        rows_in, rows_out, rows_rejected,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
