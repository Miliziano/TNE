# Disegno — SERVICE MODE + nodo `stop` funzionale

> Capitolo di disegno per i **nodi-servizio**: nodi che vivono OLTRE la fine
> della lane, finché non vengono fermati. Serve a tre nodi:
> `dir_watcher` (watch, fase 2), `webhook_receiver`, `webhook_responder`.
> Nato dall'osservazione dell'utente sul watch: "deve restare in ascolto per
> l'evento successivo; la fine della lane non chiude il processo perché
> aspetta nuove righe dal watcher".

## 0. Stato attuale (verificato nel codice)

- Il motore è **strettamente finito**: `executor` attende che OGNI task-nodo
  RITORNI (`for (id, handle) in handles { handle.await }`). Un nodo che non
  ritorna tiene vivo il run finché non ritorna — di per sé è ESATTAMENTE ciò
  che serve a un servizio, MA oggi non c'è modo di fermarlo dall'esterno.
- `engine_run(plan_json)` (engine/mod.rs:111) fa `tokio::spawn` del run e
  **ritorna subito** il `run_id`; ogni lane è un `tokio::spawn` indipendente
  (`execute_lane`). Nessun handle viene conservato per fermare il run dopo.
- Cancellazione esistente: `LaneAbort` (abort.rs) = registro per-lane degli
  `AbortHandle`, ma è **interno** e lo scatena SOLO l'error handler su errore
  critico. Ha già un campo `reason` per distinguere "errore critico" da
  "regola che interrompe" — riusabile per "stop deliberato".
- `executionSemantics: 'stream'` dichiarato in nodeSemantics è **ignorato dal
  motore** (0 usi in engine/). Solo hint per lo studio.
- ❌ NON esiste un comando `stop_run`, né un bottone Stop cablato ai task.

Conclusione: il mattone (abort per-task) c'è; mancano (a) un handle di stop a
livello di RUN raggiungibile da un comando Tauri, (b) una convenzione "gira
finché non cancellato" per i nodi-servizio, (c) il nodo `stop` che scateni lo
stop dal disegno del flusso.

## 1. Architettura proposta

### 1.1 Token di cancellazione per-run (D1)
Un segnale di cancellazione clonabile e awaitable, uno per run, in un registro
globale `run_id → token`.
- **(A)** `tokio_util::sync::CancellationToken` — dep nuova `tokio-util`
  (feature `rt`), idiomatica: clonabile, `.cancelled().await`, `.cancel()`,
  `.is_cancelled()`. Ogni nodo-servizio ne tiene un clone e fa
  `select! { ev = <evento> => …, _ = token.cancelled() => break }`.
- (B) Estendere `LaneAbort` con un trigger esterno (riusa gli AbortHandle:
  `stop_run` chiama `.fire()` su tutte le lane del run). Niente dep nuove, ma
  l'abort è brutale (annulla il task a metà) invece di lasciarlo uscire pulito.
- **➡️ Raccomandato: A** per i nodi-servizio (uscita PULITA: il nodo vede il
  cancel e chiude drenando), **+ B** che resta com'è per l'abort critico
  d'errore. I due convivono: token = stop cooperativo, LaneAbort = stop forzato.
- Registro: `static RUNS: OnceLock<Mutex<HashMap<String, CancellationToken>>>`.
  `engine_run` crea il token, lo registra, lo passa nel `NodeContext` (accanto a
  `lane_abort`); a run concluso lo rimuove.

### 1.2 Comando `stop_run(run_id)` (D1)
Nuovo `#[tauri::command] stop_run(run_id: String)`: prende il token dal registro
e chiama `.cancel()`. Lo studio lo chiama dal bottone Stop (lato studio, fuori
da questo disegno). Idempotente.

### 1.3 Fine del run con nodi-servizio
Il modello "attendi tutti gli handle" già dà la semantica giusta: un
nodo-servizio resta in `handle.await` finché non esce (allo stop). Quando esce,
droppa il suo `tx` → i nodi a valle vedono fine-stream → completano → il run
finisce. Quindi **il run vive finché il servizio vive, e finisce pulito allo
stop**. Da verificare: che nessun altro meccanismo (es. lane senza altro lavoro)
chiuda il run prima; e che i nodi-servizio NON siano `interrompibile`
dall'error handler per default (o lo siano solo se collegati all'EH).

### 1.4 Convenzione nodo-servizio
Un nodo-servizio riceve `token` nel ctx e cicla:
```
loop {
    tokio::select! {
        ev = attesa_evento() => { emetti righe da ev; }
        _  = token.cancelled() => break,
    }
}
// uscita pulita: droppa tx, ritorna stats
```
`dir_watcher` fase 2 = fase 1 (notify) dentro questo loop, ri-armando l'attesa.
webhook_receiver = `webhook_pop` in loop fino a cancel. webhook_responder =
tiene su il server (già in lib.rs) fino a cancel, poi `webhook_responder_stop`.

## 2. Nodo `stop` funzionale (D2) — idea dell'utente

Oggi `stop` è cosmetico. Diventa il modo per chiudere il processo **dal disegno
del flusso**, consapevolmente. Riusa i meccanismi esistenti. Due semantiche,
richieste esplicitamente dall'utente ("un'eccezione o un evento di chiusura"):

- **exception** — il nodo `stop`, alla ricezione di una riga (o su condizione),
  emette una riga d'errore verso l'**error handler** (stesso canale controllo
  dei fallimenti nodo). L'autore la instrada/gestisce nell'EH; se marcata
  critica, fa scattare `LaneAbort`. È il ramo "eccezione governata".
- **close** — chiusura PULITA: scatena il **token di cancellazione del run**
  (§1.1) con un `reason` = "stop deliberato", lasciando drenare le righe in
  volo. NON marca la lane come fallita (Monitor/report NON mostrano un
  fallimento — il campo `reason` di LaneAbort nasce apposta per non spacciare
  per "errore critico" un'interruzione voluta).

**➡️ Raccomandato:** entrambe, scelte da un prop `stopMode: exception | close`
(default `close`). Il `stop` in modalità close è l'interruttore naturale della
service mode; in modalità exception è la valvola per flussi che vogliono
governare l'uscita passando dall'EH.

Semantica d'attivazione (D2b): il `stop` scatta **alla prima riga che riceve**
(default), oppure su una condizione FPEL (`when`), riusando l'espressione già
disponibile agli altri nodi. Raccomandato: prima riga per la v1, `when`
opzionale.

## 3. Fette (ordine proposto)
1. **Plumbing service mode**: token per-run + registro + `stop_run` + token nel
   NodeContext. Nessun nodo lo usa ancora → si verifica con un nodo-servizio di
   prova o direttamente con la fetta 3.
2. **Nodo `stop` funzionale** (modalità close + exception). Non dipende dai
   servizi: utile da subito anche in lane finite (uscita governata).
3. **dir_watcher fase 2**: la fase 1 (notify, già fatta in P91) dentro il loop
   di servizio, ri-armata, `select!` col token.
4. **webhook_receiver** come nodo-servizio (poll `webhook_pop` fino a cancel;
   server `webhook_server_start`/`_stop` gestito dal ciclo di vita del nodo).
5. **webhook_responder** come nodo-servizio (`webhook_responder_start`/`_stop`).

## 4. Rischi / da verificare
- Il token deve arrivare nel `NodeContext` per OGNI nodo: toccare la
  costruzione del ctx in `execute_lane` (come `lane_abort`).
- `engine_run` ritorna subito: il registro `run_id → token` va popolato PRIMA
  dello spawn e ripulito quando il run finisce (anche in caso di errore).
- Un nodo-servizio non deve stare nell'insieme `interrompibile` dell'EH per
  default, altrimenti un errore altrove lo abbatte (a meno che l'autore non lo
  colleghi apposta all'EH).
- `tokio-util` è dep nuova (feature `rt` per CancellationToken) — l'utente la
  aggiunge compilando. Alternativa senza dep: un `tokio::sync::watch<bool>` fatto
  a mano (più codice, stessa sostanza).
- La modalità `close` del `stop` che droppa i servizi mentre righe sono in volo:
  definire l'ordine (prima si smette di produrre, poi si lascia drenare).
