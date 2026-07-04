// ─── src-tauri/src/memory_monitor.rs ───────────────────────────────
//
// Modulo dedicato al monitoraggio memoria dell'intera applicazione Tauri.
//
// Costruisce l'albero completo dei processi (Tauri + WebKitWebProcess +
// WebKitNetworkProcess + WebKitGPUProcess + eventuali nipoti) tramite
// PPID, e per ognuno legge RSS e PSS da /proc/<pid>/smaps_rollup quando
// disponibile (più accurato di VmRSS perché conta la memoria condivisa
// proporzionalmente, evitando il doppio conteggio tra processi).
//
// Cross-platform: su Linux usa /proc, su macOS/Windows usa sysinfo
// come fallback per il solo processo principale (PSS non disponibile).
//
// Da aggiungere in Cargo.toml: nessuna nuova dipendenza richiesta
// oltre a sysinfo già presente.
//
// Uso in lib.rs:
//   mod memory_monitor;
//   use memory_monitor::{get_app_memory_info, AppMemoryInfo};
//
//   #[tauri::command]
//   async fn get_memory_info() -> Result<AppMemoryInfo, String> {
//       Ok(memory_monitor::get_app_memory_info())
//   }

use serde::{Serialize, Deserialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProcessMemoryInfo {
    pub pid:      u32,
    pub name:     String,
    pub role:     ProcessRole,
    pub rss:      u64,   // bytes — Resident Set Size
    pub pss:      u64,   // bytes — Proportional Set Size (0 se non disponibile)
    pub private:  u64,   // bytes — memoria esclusiva del processo (Private_Clean + Private_Dirty)
    pub shared:   u64,   // bytes — pagine condivise con altri processi (Shared_Clean + Shared_Dirty)
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum ProcessRole {
    Main,             // processo Tauri/Rust principale
    WebKitWeb,        // renderer JS/React/DOM
    WebKitNetwork,    // gestione rete
    WebKitGpu,        // compositing/rendering GPU
    Other,            // altri processi figli non classificati
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppMemoryInfo {
    /// Dettaglio per processo — utile per debug e per il pannello "Nodi" esteso
    pub processes:      Vec<ProcessMemoryInfo>,
    /// Somma RSS di tutti i processi dell'app (Rust + WebKit*)
    pub total_rss:      u64,
    /// Somma PSS di tutti i processi — più accurata di total_rss,
    /// evita il doppio conteggio delle pagine condivise tra processi.
    /// 0 se PSS non è disponibile sulla piattaforma corrente.
    pub total_pss:      u64,
    /// RSS del solo processo principale (per retrocompatibilità)
    pub main_rss:       u64,
    /// RSS di tutti i processi WebKit sommati (per retrocompatibilità)
    pub webkit_rss:     u64,
    /// Somma memoria privata (esclusiva) di tutti i processi dell'app —
    /// è la metrica più indicativa per i memory leak: cresce solo
    /// se l'app sta davvero allocando memoria propria, non per via
    /// di librerie/pagine condivise col sistema.
    pub total_private:  u64,
    /// Somma memoria condivisa (librerie, pagine mappate) — di norma
    /// stabile nel tempo, non dovrebbe crescere durante l'esecuzione.
    pub total_shared:   u64,
    pub total_ram:      u64,
    pub used_ram:       u64,
    pub timestamp:      u64,
    /// true se PSS è stato letto correttamente (solo Linux con smaps_rollup)
    pub pss_available:  bool,
}

pub fn get_app_memory_info() -> AppMemoryInfo {
    let our_pid = std::process::id();

    #[cfg(target_os = "linux")]
    let (processes, pss_available) = linux::collect_process_tree(our_pid);

    #[cfg(not(target_os = "linux"))]
    let (processes, pss_available) = fallback::collect_main_only(our_pid);

    let total_rss:     u64 = processes.iter().map(|p| p.rss).sum();
    let total_pss:     u64 = processes.iter().map(|p| p.pss).sum();
    let total_private: u64 = processes.iter().map(|p| p.private).sum();
    let total_shared:  u64 = processes.iter().map(|p| p.shared).sum();
    let main_rss:      u64 = processes.iter()
        .find(|p| p.role == ProcessRole::Main)
        .map(|p| p.rss).unwrap_or(0);
    let webkit_rss:    u64 = processes.iter()
        .filter(|p| matches!(p.role, ProcessRole::WebKitWeb | ProcessRole::WebKitNetwork | ProcessRole::WebKitGpu))
        .map(|p| p.rss).sum();

    let (total_ram, used_ram) = system_ram();

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    AppMemoryInfo {
        processes, total_rss, total_pss, total_private, total_shared,
        main_rss, webkit_rss,
        total_ram, used_ram, timestamp, pss_available,
    }
}

fn system_ram() -> (u64, u64) {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    (sys.total_memory(), sys.used_memory())
}

// ═══════════════════════════════════════════════════════════════════
// IMPLEMENTAZIONE LINUX — albero processi via PPID + PSS via smaps_rollup
// ═══════════════════════════════════════════════════════════════════

#[cfg(target_os = "linux")]
mod linux {
    use super::{ProcessMemoryInfo, ProcessRole};

    /// Legge un campo numerico da /proc/<pid>/status (es. "VmRSS:", "PPid:")
    fn read_status_field(pid: u32, field: &str) -> Option<u64> {
        let content = std::fs::read_to_string(format!("/proc/{}/status", pid)).ok()?;
        content.lines()
            .find(|l| l.starts_with(field))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
    }

    fn read_ppid(pid: u32) -> Option<u32> {
        read_status_field(pid, "PPid:").map(|v| v as u32)
    }

    fn read_rss_kb(pid: u32) -> u64 {
        read_status_field(pid, "VmRSS:").unwrap_or(0)
    }

    fn read_name(pid: u32) -> String {
        std::fs::read_to_string(format!("/proc/{}/comm", pid))
            .unwrap_or_default()
            .trim()
            .to_string()
    }

    /// Memoria dettagliata letta da /proc/<pid>/smaps_rollup (valori in kB
    /// nel file, convertiti subito in struct con campi separati).
    pub struct SmapsRollup {
        pub pss:     u64,   // kB — Proportional Set Size
        pub private: u64,   // kB — Private_Clean + Private_Dirty (memoria esclusiva)
        pub shared:  u64,   // kB — Shared_Clean + Shared_Dirty (pagine condivise)
    }

    /// Legge smaps_rollup in un solo parse — PSS, Private e Shared insieme.
    /// Richiede permessi di lettura — se mancanti restituisce None
    /// (es. in container senza CAP_SYS_PTRACE verso altri processi,
    /// o con yama/ptrace_scope molto restrittivo).
    fn read_smaps_rollup(pid: u32) -> Option<SmapsRollup> {
        let content = std::fs::read_to_string(format!("/proc/{}/smaps_rollup", pid)).ok()?;

        let field = |name: &str| -> u64 {
            content.lines()
                .find(|l| l.starts_with(name))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|s| s.parse().ok())
                .unwrap_or(0)
        };

        let pss = field("Pss:");
        let private_clean = field("Private_Clean:");
        let private_dirty = field("Private_Dirty:");
        let shared_clean  = field("Shared_Clean:");
        let shared_dirty  = field("Shared_Dirty:");

        Some(SmapsRollup {
            pss,
            private: private_clean + private_dirty,
            shared:  shared_clean + shared_dirty,
        })
    }

    fn classify(name: &str) -> ProcessRole {
        let n = name.to_lowercase();
        if n.contains("webkitnetwork") || n == "webkitnetworkpr" {
            ProcessRole::WebKitNetwork
        } else if n.contains("webkitgpu") || n.contains("webkitwebgpu") {
            ProcessRole::WebKitGpu
        } else if n.contains("webkit") {
            ProcessRole::WebKitWeb
        } else {
            ProcessRole::Other
        }
    }

    /// Costruisce l'albero completo: trova tutti i discendenti del
    /// processo principale (figli, nipoti, ecc.) tramite BFS su PPID,
    /// classifica ognuno per ruolo e legge RSS/PSS.
    ///
    /// Ritorna (lista processi, pss_disponibile).
    pub fn collect_process_tree(root_pid: u32) -> (Vec<ProcessMemoryInfo>, bool) {
        // Step 1: mappa pid → ppid per tutti i processi visibili
        let mut all_pids: Vec<u32> = Vec::new();
        if let Ok(dir) = std::fs::read_dir("/proc") {
            for entry in dir.flatten() {
                if let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() {
                    all_pids.push(pid);
                }
            }
        }

        // Step 2: BFS dai discendenti del root
        let mut descendants: Vec<u32> = vec![root_pid];
        let mut frontier: Vec<u32> = vec![root_pid];

        while !frontier.is_empty() {
            let mut next_frontier = Vec::new();
            for &pid in &all_pids {
                if descendants.contains(&pid) { continue }
                if let Some(ppid) = read_ppid(pid) {
                    if frontier.contains(&ppid) {
                        descendants.push(pid);
                        next_frontier.push(pid);
                    }
                }
            }
            frontier = next_frontier;
        }

        // Step 3: per ogni discendente, raccoglie nome/rss/pss/ruolo
        let mut result = Vec::new();
        let mut any_pss = false;

        for &pid in &descendants {
            let name = read_name(pid);
            let rss_kb = read_rss_kb(pid);
            let smaps = read_smaps_rollup(pid);
            if smaps.is_some() { any_pss = true }

            let role = if pid == root_pid { ProcessRole::Main } else { classify(&name) };

            result.push(ProcessMemoryInfo {
                pid, name,
                role,
                rss:     rss_kb * 1024,
                pss:     smaps.as_ref().map(|s| s.pss).unwrap_or(0) * 1024,
                private: smaps.as_ref().map(|s| s.private).unwrap_or(0) * 1024,
                shared:  smaps.as_ref().map(|s| s.shared).unwrap_or(0) * 1024,
            });
        }

        (result, any_pss)
    }
}

// ═══════════════════════════════════════════════════════════════════
// FALLBACK macOS / Windows — solo processo principale via sysinfo
// ═══════════════════════════════════════════════════════════════════

#[cfg(not(target_os = "linux"))]
mod fallback {
    use super::{ProcessMemoryInfo, ProcessRole};
    use sysinfo::{System, Pid};

    /// Su macOS/Windows non leggiamo l'albero dei processi WebKit/Edge
    /// per evitare logica fragile e non testata. Restituisce solo il
    /// processo principale — il frontend nasconderà il pannello WebKit.
    pub fn collect_main_only(our_pid: u32) -> (Vec<ProcessMemoryInfo>, bool) {
        let mut sys = System::new_all();
        sys.refresh_all();

        let rss = sys.process(Pid::from(our_pid as usize))
            .map(|p| p.memory())
            .unwrap_or(0);

        let processes = vec![ProcessMemoryInfo {
            pid:     our_pid,
            name:    "main".to_string(),
            role:    ProcessRole::Main,
            rss,
            pss:     0,
            private: 0,
            shared:  0,
        }];

        (processes, false)
    }
}