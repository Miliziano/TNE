// ─── src-tauri/src/engine/nodes/ssh_exec.rs ───────────────────────
//
// Nodo SSH — esegue comandi su host remoto via SSH (ssh2). Porting di
// CABLAGGIO, gemello di shell_exec: l'infrastruttura reale
// (`crate::ssh_exec_impl`, ex corpo del comando Tauri `ssh_exec`) esisteva già
// in lib.rs — qui si aggiunge solo il nodo del motore.
//
// Riferimento del flusso: `src/runner/sshExecutor.ts` ("identico a shell +
// host/user/auth"). La connessione arriva dalla RISORSA SSH collegata (se c'è)
// oppure, in fallback, dai prop del nodo — stessa priorità del runner.
// Gli helper `resolve_template` / `non_empty_lines` sono condivisi con
// shell_exec (fonte unica, niente copia-incolla della regola).
//
// Ogni riga emessa porta i meta `ssh_host / ssh_user / ssh_command /
// ssh_exit_code / ssh_duration_ms` (come il runner), poi i campi specifici
// della modalità. Modalità: lines (default) / json / jsonl / summary.
//
// ⚠️ SICUREZZA: esegue comandi arbitrari su un host remoto con le credenziali
// della risorsa. auth password/key/key_passphrase gestita da ssh2 in lib.rs.
// La cancellazione (ctx.cancel) agisce FRA un'esecuzione e la successiva.

use std::collections::HashMap;
use std::time::Instant;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::engine::nodes::shell_exec::{resolve_template, non_empty_lines};
use crate::{SshConnection, SshExecRequest, ShellResult, ssh_exec_impl};

/// "" → None, valore → Some (come `p(...) || undefined` del runner).
fn opt(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}

/// Riga base coi meta SSH sovrapposti alla riga in ingresso.
fn meta_row(base: &Row, host: &str, user: &str, cmd: &str, exit: i32, dur: u64) -> Row {
    let mut r = base.clone();
    r.set("ssh_host".into(),        Value::String(host.to_string()));
    r.set("ssh_user".into(),        Value::String(user.to_string()));
    r.set("ssh_command".into(),     Value::String(cmd.to_string()));
    r.set("ssh_exit_code".into(),   Value::Int(exit as i64));
    r.set("ssh_duration_ms".into(), Value::Int(dur as i64));
    r
}

/// Sovrappone i campi di un oggetto JSON (spread `...item`: l'oggetto vince).
fn overlay_object(r: &mut Row, obj: &serde_json::Value) {
    if let serde_json::Value::Object(map) = obj {
        for (k, v) in map { r.set(k.clone(), Value::from_json(v.clone())); }
    }
}

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("ssh_exec {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("ssh_exec", &ctx.node_id.0);

    let command        = spec.str_or("command", "");
    let output_mode    = spec.str_or("outputMode", "lines");
    let timeout_sec    = spec.u64_or("timeoutSec", 30);
    let on_error       = spec.str_or("onError", "stop");
    let capture_stderr = spec.str_or("captureStderr", "true") == "true";
    let run_per_row    = spec.str_or("runPerRow", "false") == "true";

    // Connessione: dalla RISORSA collegata se c'è, altrimenti dai prop del nodo
    // (stessa priorità di buildConnection del runner). Le chiavi coincidono tra
    // config-risorsa e prop, così cambia solo la fonte.
    let (host, port, user, auth_type, password, key_path, key_passphrase,
         known_hosts_check, connect_timeout_sec): (
            String, u16, String, String, Option<String>, Option<String>,
            Option<String>, bool, u64,
        ) = if spec.has_resource() {
        (
            spec.res_str_or("host", ""),
            spec.res_u16_or("port", 22),
            spec.res_str_or("user", ""),
            spec.res_str_or("authType", "password"),
            opt(spec.res_str_or("password", "")),
            opt(spec.res_str_or("keyPath", "")),
            opt(spec.res_str_or("keyPassphrase", "")),
            spec.res_str_or("knownHostsCheck", "false") == "true",
            spec.res_u64_or("connectTimeout", 10),
        )
    } else {
        (
            spec.str_or("host", ""),
            spec.str_or("port", "22").parse().unwrap_or(22),
            spec.str_or("user", ""),
            spec.str_or("authType", "password"),
            opt(spec.str_or("password", "")),
            opt(spec.str_or("keyPath", "")),
            opt(spec.str_or("keyPassphrase", "")),
            spec.str_or("knownHostsCheck", "false") == "true",
            spec.str_or("connectTimeout", "10").parse().unwrap_or(10),
        )
    };

    let start = Instant::now();

    // Validazioni (come il runner: throw su comando/host/utente mancanti).
    let fail = |ctx: &NodeContext, msg: String| -> Result<NodeStats, String> {
        ctx.emit_failed(msg.clone());
        Err(msg)
    };
    if command.trim().is_empty() {
        return fail(&ctx, format!("ssh_exec {}: comando non configurato", ctx.node_id.0));
    }
    if host.is_empty() {
        return fail(&ctx, format!("ssh_exec {}: host non configurato", ctx.node_id.0));
    }
    if user.is_empty() {
        return fail(&ctx, format!("ssh_exec {}: utente non configurato", ctx.node_id.0));
    }

    let connection = SshConnection {
        host: host.clone(), port, user: user.clone(), auth_type,
        password, key_path, key_passphrase, known_hosts_check,
        connect_timeout_sec,
    };

    // Variabili di lane (per ${VAR}) come stringhe.
    let lane_vars: HashMap<String, String> = ctx.variables.iter()
        .map(|(k, v)| (k.clone(), v.as_str_repr())).collect();

    // Drena l'eventuale input.
    let mut input: Vec<Row> = Vec::new();
    if let Some(mut rxc) = rx {
        while let Some(r) = rxc.recv().await { input.push(r); }
    }
    let rows_in = input.len() as u64;

    let batch: Vec<Row> = if run_per_row && !input.is_empty() {
        input
    } else {
        vec![input.into_iter().next().unwrap_or_else(Row::new)]
    };

    let mut rows_out = 0u64;

    for row in &batch {
        if ctx.cancel.is_cancelled() { break; }

        let resolved_command = resolve_template(&command, row, &lane_vars);

        ctx.emit_log(&ctx.label, "info", 0,
            format!("SSH [{}@{}:{}]: {}", user, host, port, resolved_command), "panel");

        let result: ShellResult = match ssh_exec_impl(SshExecRequest {
            connection:  connection.clone(),
            command:     resolved_command.clone(),
            timeout_sec: if timeout_sec > 0 { Some(timeout_sec) } else { None },
        }).await {
            Ok(r) => r,
            Err(e) => {
                ctx.emit_log(&ctx.label, "error", 0,
                    format!("SSH: connessione fallita — {}", e), "panel");
                if on_error == "stop" {
                    return fail(&ctx, format!("ssh_exec {}: {}", ctx.node_id.0, e));
                }
                continue;
            }
        };

        let out_lines = non_empty_lines(&result.stdout);
        let err_lines = non_empty_lines(&result.stderr);

        ctx.emit_log(&ctx.label,
            if result.exit_code == 0 { "ok" } else { "warn" }, 0,
            format!("SSH: exit {} | {}ms | {}", result.exit_code, result.duration_ms, host), "panel");

        if result.exit_code != 0 && on_error == "stop" {
            let detail = if result.stderr.is_empty() { &result.stdout } else { &result.stderr };
            return fail(&ctx, format!(
                "ssh_exec {}: exit code {} su {}\n{}", ctx.node_id.0, result.exit_code, host, detail));
        }

        // Senza valle: eseguito per gli effetti, niente da emettere.
        let tx = match &tx { Some(t) => t, None => continue };

        let mk = |base: &Row| meta_row(base, &host, &user, &resolved_command, result.exit_code, result.duration_ms);

        match output_mode.as_str() {
            "summary" => {
                let mut r = mk(row);
                r.set("stdout".into(),       Value::String(result.stdout.clone()));
                r.set("stderr".into(),       Value::String(result.stderr.clone()));
                r.set("stdout_lines".into(), Value::Int(out_lines.len() as i64));
                r.set("stderr_lines".into(), Value::Int(err_lines.len() as i64));
                r.set("ok".into(),           Value::Bool(result.exit_code == 0));
                if tx.send(r).await.is_err() { break; }
                rows_out += 1;
            }

            "json" => {
                match serde_json::from_str::<serde_json::Value>(result.stdout.trim()) {
                    Ok(parsed) => {
                        let arr = match parsed {
                            serde_json::Value::Array(a) => a,
                            other => vec![other],
                        };
                        for item in arr {
                            let mut r = mk(row);
                            overlay_object(&mut r, &item);
                            if tx.send(r).await.is_err() { break; }
                            rows_out += 1;
                        }
                    }
                    Err(_) => {
                        for (i, line) in out_lines.iter().enumerate() {
                            let mut r = mk(row);
                            r.set("line".into(),        Value::String((*line).to_string()));
                            r.set("line_number".into(), Value::Int((i + 1) as i64));
                            r.set("stream".into(),      Value::String("stdout".into()));
                            if tx.send(r).await.is_err() { break; }
                            rows_out += 1;
                        }
                    }
                }
            }

            "jsonl" => {
                for (i, line) in out_lines.iter().enumerate() {
                    let mut r = mk(row);
                    match serde_json::from_str::<serde_json::Value>(line) {
                        Ok(parsed) => overlay_object(&mut r, &parsed),
                        Err(_) => {
                            r.set("line".into(),        Value::String((*line).to_string()));
                            r.set("line_number".into(), Value::Int((i + 1) as i64));
                        }
                    }
                    if tx.send(r).await.is_err() { break; }
                    rows_out += 1;
                }
            }

            _ => {
                // lines (default)
                for (i, line) in out_lines.iter().enumerate() {
                    let mut r = mk(row);
                    r.set("line".into(),        Value::String((*line).to_string()));
                    r.set("line_number".into(), Value::Int((i + 1) as i64));
                    r.set("stream".into(),      Value::String("stdout".into()));
                    if tx.send(r).await.is_err() { break; }
                    rows_out += 1;
                }
                if capture_stderr {
                    for (i, line) in err_lines.iter().enumerate() {
                        let mut r = mk(row);
                        r.set("line".into(),        Value::String((*line).to_string()));
                        r.set("line_number".into(), Value::Int((i + 1) as i64));
                        r.set("stream".into(),      Value::String("stderr".into()));
                        if tx.send(r).await.is_err() { break; }
                        rows_out += 1;
                    }
                }
            }
        }
    }

    let stats = NodeStats {
        rows_in, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
