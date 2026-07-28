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

## 2. Nodo `stop` funzionale (D2) — DISEGNO CHIUSO (28 lug)

Diventa il modo per chiudere il processo **dal disegno del flusso**,
consapevolmente. Nasce dall'idea dell'utente ("un'eccezione o un evento di
chiusura") ma è stato **ridotto a una cosa sola** dopo la discussione: pool e
restart sono stati eliminati (chiedevano capacità nuove al motore), e le due
semantiche `exception`/`close` sono collassate in **un'azione unica**.

### 2.1 Un'azione sola: ferma la lane
Il nodo `stop` **ferma la lane** — niente altro. Ferma-lane =
`LaneAbort::fire` (`engine/abort.rs`), che GIÀ porta **rollback delle
transazioni attive + chiusura connessioni** (§6.1 di HANDOFF: il `fire` fa
scattare l'abort dei task ancora vivi, e a fine lane `finalize_with_outcome`
esegue il rollback perché l'esito non è Ok, poi `close_all`). Non c'è niente da
inventare nel motore: si riusa il mattone dell'abort critico, con un **motivo**
diverso.

Il `fire` conserva il `reason`: qui è **"stop deliberato"**, non "errore
critico". I nodi interrotti compaiono nel Monitor come *interrotti* (evento
`NodeInterrupted`, warning grigio — v. P53), con quel motivo accanto: è
un'uscita voluta, non un fallimento.

### 2.2 Due modalità di INNESCO
Il nodo scatta **quando gli arriva una riga**; la modalità decide *quando*:

- **`immediate`** (default) — scatta alla **prima riga** ricevuta. "Se il
  flusso arriva qui, fermati subito."
- **`after_input`** — scatta **dopo che il monte ha esaurito le righe** (drena
  l'ingresso fino a EOF, poi ferma). Serve a lasciar **processare/loggare tutte
  le righe del ramo** prima di chiudere (es. un `log` fra il reject e lo stop
  finisce di scrivere tutte le righe scartate, poi la lane si ferma).

Convenzione di innesco: entrambe le modalità richiedono **≥1 riga**. Un ramo che
non produce righe (EOF a 0) NON innesca — coerente con "scatta quando gli arriva
una riga". (Se un domani serve "ferma comunque a fine ramo anche a 0 righe" è un
solo `if`.)

Multi-istanza: se ne mettono quante se ne vuole per lane, tipicamente **a valle
di un `reject` o di un handle di un `filter`**.

### 2.3 Cancellabile (vincolo utente)
Il nodo `stop` parte in parallelo come ogni altro. Deve **NON scattare
all'avvio** e rispondere al `cancel` del run (§1.1): attende in
`tokio::select!` fra la **riga d'innesco** e `ctx.cancel.cancelled()`. Se il
ramo non viene mai raggiunto, o se un altro `cancel` scatta prima, esce
**pulito** senza fermare niente. (⚠️ il `fire` può abortire anche il task del
nodo stop, che è registrato come interrompibile: per questo il `fire` è
l'**ultima** azione, senza `.await` dopo — il task conclude normalmente prima
che la cancellazione di sé stesso prenda effetto.)

### 2.4 Passa dall'error handler per gli EFFETTI (amplificatore, non requisito)
Gli effetti collaterali di una chiusura (log su file, mail, http, `sink_db`) non
si duplicano sul nodo stop: si **riusano quelli dell'error handler**. Il nodo
`stop`, all'innesco, manda all'EH una riga di **"chiusura deliberata"** sul
canale di controllo (il collettore, come i fallimenti di nodo, ma marcata
`_error_source = "stop"` e **non critica**): l'EH la registra e la emette su
`error_out`, dove la **sotto-pipeline disegnata dall'utente** esegue gli
effetti. Così gli effetti si disegnano **una volta** e valgono per errori E
stop; il `reason` "stop deliberato" li tiene distinti da un fallimento.

Ordine corretto: **prima** la sotto-pipeline dell'EH esegue gli effetti,
**poi** rollback+close. È già garantito dal modello a canale: l'EH e la sua
sotto-pipeline sono ESCLUSI dall'abort, quindi `fire` ferma solo la pipeline
principale; il collettore si chiude, l'EH drena la riga di chiusura, la
sotto-pipeline conclude, e solo allora `finalize_with_outcome` fa il rollback.

**FALLBACK senza EH** — se la lane non ha (o non usa) l'EH, lo stop **ferma
comunque** la lane in modo pulito (rollback+close, motivo deliberato), solo
senza effetti ricchi. L'EH è un **amplificatore, non un requisito**.

⚠️ **Avvertenza salva-stato.** Un eventuale "salva lo stato su stop" che deve
**sopravvivere** alla chiusura va tenuto **fuori dal gruppo transazionale**: sta
nel gruppo → il rollback se lo porta via. Stesso avvertimento del sink d'errore
dell'EH (§6.1).

### 2.5 Cosmetici (nota, non parte dell'implementazione motore)
Esiste già una coppia di nodi rotondi ▶/⏹ (`StartNode`/`EndNode`,
`lane_start`/`lane_end`): **NON sono decorativi**, sono gli **ancoraggi di
boundary della lane** (→ `lane_boundary` nell'IR, `non eliminabile`, usati dalla
validazione). Il nuovo `stop` è un **nodo di palette distinto** (sezione
"Flusso"), non una trasformazione di quegli ancoraggi. Ogni ripulitura estetica
dei rotondi resta una decisione a parte e non tocca questo disegno.

## 3. Fette (ordine aggiornato)
1. ✅ **Plumbing service mode** (P93/P93b): token per-run + registro +
   `stop_run` + `cancel` nel NodeContext. FATTO.
2. **Nodo `stop` funzionale** — spezzato in due:
   - **2a — ferma-lane (path base/fallback).** Studio (voce palette "Flusso" +
     `nodeSemantics` + pannello innesco `immediate`/`after_input` + messaggio
     opz.) + motore (`stop.rs`: `select!` innesco-vs-`cancel`; immediate = 1ª
     riga, after_input = drena fino a EOF; poi `LaneAbort::fire("stop
     deliberato")`). È già utile da sé: ferma la lane pulito, cancellabile,
     anche senza EH. **← questa fetta.**
   - **2b — amplificatore EH.** La riga di "chiusura deliberata" al collettore →
     effetti via `error_out`; e il "non è un fallimento" a livello di **Run**
     (oggi una lane con `fire` scattato è riportata come interrotta col motivo
     onesto, ma il Run la conta comunque fra le non-riuscite: rendere il Run
     onesto sull'interruzione-voluta è parte di 2b).
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
- Il nodo `stop` è registrato come **interrompibile** (ha il sender del
  collettore ⇒ è nel registro degli AbortHandle): il suo `fire` può abortire
  anche il proprio task. È benigno solo perché `fire` è l'**ultima** azione,
  senza `.await` dopo (v. §2.3). Se in futuro serve del lavoro *dopo* il `fire`,
  o si esclude il `stop` dal registro (come l'EH) o si sposta quel lavoro prima.
- Ordine effetti-EH → rollback (§2.4): garantito dal fatto che l'EH e la sua
  sotto-pipeline sono esclusi dall'abort. Vale finché quell'esclusione (BFS
  `eh_subpipe` in `executor`) resta corretta — è la stessa su cui poggia
  l'abort critico.
