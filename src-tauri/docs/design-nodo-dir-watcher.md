# Nodo `dir_watcher` — disegno (con la modalità WATCH CONTINUO a sessioni)

Compagno di `design-service-mode.md` (il watch continuo è un nodo-servizio) e di
`architettura-pipeline.md` (il modello a sessioni tocca lo scheduling della lane).
Stato codice: scan + watch **one-shot** già fatti (P90/P91). Questo doc fissa il
disegno del **watch continuo**, che è una tappa architetturale, non un ritocco.

## 0. Contesto
`notify` (il crate) espone la sottoscrizione nativa del SO (inotify / FSEvents /
ReadDirectoryChangesW). Oggi (fase 1) il nodo si sottoscrive, **blocca** sul primo
batch di eventi entro un tetto, emette i file, `drop(watcher)` (si dissottoscrive)
e ritorna: single-shot, gira nel motore finito. Il watch continuo è un'altra cosa:
un demone ETL che reagisce ai file finché non lo si ferma.

## 1. Tre modalità (tutte e tre restano)
- **scan** — lista la cartella UNA volta, una riga per file. Finito. Invariato.
- **watch one-shot** — l'attuale fase 1: aspetta un file/batch (tetto di sicurezza),
  emette, finisce. Utile per "aspetta che arrivi un file, elabora e chiudi".
  Invariato salvo il vocabolario eventi (§6).
- **watch continuo** — NUOVO: sempre in ascolto, non perde eventi, esegue la lane
  **una volta per gruppo** (una *sessione*) con commit/chiusura per sessione.
  Finisce solo su `stop_run`/cancel (service mode).

## 2. Il modello a SESSIONI (la chiave di tutto)
Requisito dell'utente (due precisazioni, entrambe recepite):
1. **Commit per gruppo.** Ogni riga (o gruppo di righe, se arrivano molti file
   insieme) trascina la lane fino in fondo: sink e transazioni **committano e
   chiudono PRIMA** che entri il gruppo successivo. Sono *sessioni diverse*.
2. **Non perdere input.** La sottoscrizione al SO deve restare attiva anche
   *mentre* la lane elabora la sessione precedente, e bufferizzare tutto in una
   coda propria; il watcher non si ri-sottoscrive a ogni giro, **pesca dalla coda**.

Definizione: **una sessione = un'esecuzione COMPLETA della lane su un gruppo di
eventi**, con le proprie transazioni che aprono, committano e chiudono. Le sessioni
girano in **fila indiana**.

🔑 **Perché le due precisazioni, insieme, FORZANO questa architettura.** Il commit
per gruppo (1) impone che la lane venga **ri-eseguita** per ogni gruppo — non un'unica
lane perpetua che streamma righe (lì le transazioni spanderebbero sull'intero run,
niente commit-per-gruppo). Ma se la lane si ri-esegue per gruppo, allora **il nodo
watcher NON può essere l'oggetto che tiene la sottoscrizione**: verrebbe distrutto e
ricreato a ogni sessione, e (2) perderebbe gli eventi nel mezzo. Quindi la
sottoscrizione + coda vanno **issate SOPRA la lane**, a livello di run. È esattamente
il punto in cui le due richieste si sciolgono a vicenda: **la coda disaccoppia
l'ascolto dall'elaborazione** (2), **il loop di sessione serializza l'elaborazione a
commit pieno** (1).

Effetto collaterale gratuito e desiderabile: i nodi con stato (aggregate, join, sort,
window) si **azzerano** naturalmente a ogni sessione, perché ogni sessione è
un'esecuzione pulita della lane.

## 3. Sottoscrizione persistente + coda (run-scoped)
- Vive in un **registro a livello di engine**, come `run_cancels()` di P93 — un
  `OnceLock<Mutex<HashMap<key, WatchState>>>`, chiave = (run_id, node_id). Avviato
  quando parte il run con un watcher continuo; smontato alla cancellazione.
- **Coda IN-MEMORY** (DECISIONE utente, v1). ⚠️ Limite da documentare chiaro nel
  pannello e nei doc: se il **processo muore** con eventi in coda, quegli eventi sono
  persi. "Non perdere input" qui copre lane-lenta / burst, NON il crash del processo.
  Coda durevole su disco = passo successivo, fuori v1.
- **Forma a canale (raddrizza la fase 1).** La callback di `notify` gira sul suo
  thread; oggi spinge su una `std::sync::mpsc` e il nodo blocca in `spawn_blocking`.
  Per il continuo la callback spinge su una **`tokio::sync::mpsc` unbounded** (il suo
  `send` è sincrono, chiamabile dal thread di notify), e il lato engine consuma in
  `select!` col `cancel`. Sparisce lo `spawn_blocking`, la cancellazione è esatta.
  (unbounded → sotto alluvione la coda cresce; mitigato da coalescing §5 e `limit`.
  Se servisse tetto rigido: bounded + `try_send` con conteggio dei drop.)

## 4. Il loop di sessione (scheduling dell'engine)
Quando un run contiene una lane con source = dir_watcher watch **continuo**, per quella
lane l'engine passa dal "esegui una volta" a:

```
avvia sottoscrizione+coda (run-scoped)
loop:
    attendi (BLOCK, non busy) finché la coda ha ≥1 evento   ── oppure cancel → esci
    piccola finestra di debounce per coalescere il burst
    SNAPSHOT: prendi tutti gli eventi accumulati, svuota la coda
    coalescing di gruppo (§5) → gruppo
    esegui la LANE una volta (sessione) col gruppo in ingresso
        └─ apre connessioni, elabora, commit/rollback, chiude   (§7, riusa lane_txns)
    (gli eventi arrivati DURANTE la sessione sono già nella coda per il giro dopo)
smonta sottoscrizione+coda
```

- Il **nodo watcher**, dentro la sessione, non ascolta il SO: riceve il gruppo dallo
  scambio che l'engine gli passa per QUELLA sessione ed **emette le righe**. È un
  adattatore sottile sopra la coda run-scoped.
- **Auto-regolazione del gruppo (backpressure per raggruppamento, gratis).** Lane
  veloce → gruppi piccoli (spesso un file). Lane lenta + pioggia di file → il gruppo
  dopo raccoglie tutto l'arretrato. La dimensione del gruppo NON la decide l'utente:
  la decide quanto è arretrata la coda. Risponde direttamente al "una row o più row
  insieme".
- **Cancellazione**: `stop_run`/`cancel` (P93) sia nell'attesa (esci subito, nessuna
  sessione a metà) sia fra le sessioni (finisci quella in corso, poi esci). Chiusura
  pulita: droppa gli output → valle vede fine-stream → finalize dell'ultima sessione.

## 5. Coalescing di gruppo — PRIMO evento per path (DECISIONE utente)
Dentro UN gruppo, se lo stesso path compare più volte (es. create poi modify poi
delete prima che la sessione parta), **vince il PRIMO evento visto** per quel path;
gli altri si scartano. Dedup per path, first-wins.

⚠️ **Conseguenza da dichiarare (delete/create+delete).** First-wins significa che se
un file è stato creato e poi cancellato *dentro lo stesso gruppo*, la riga porta
`new` ma il file **non esiste più** quando la sessione lo elabora. La valle che apre
il file deve gestire l'assenza (o filtrarla). Se un domani mordesse, la rifinitura
naturale è "un `delete` terminale supera il primo evento sullo stesso path" — ma NON
è la v1: la v1 è first-wins liscio, come richiesto.

## 6. Eventi: `new` / `update` / `rename` / `delete`
Vocabolario d'uscita unico per one-shot e continuo (oggi la fase 1 emette
"create"/"modify" → si allinea a questi quattro). Mappa da `notify`:
- **new** ← `EventKind::Create`
- **update** ← `EventKind::Modify(Data|Any)` (contenuto). Le modifiche di sole
  metadata/permessi NON contano come update (rumore per l'ETL) — da confermare.
- **rename** ← eventi di rinomina (`Modify(Name(..))` / rename From/To)
- **delete** ← `EventKind::Remove`

**Schema d'uscita, campi presenti/assenti.** Per **new/update** il file esiste →
path, filename, extension, directory, size, created_at, modified_at, event. Per
**delete** e per il lato "from" di un **rename**, il file NON esiste più → si
possono dare solo path + filename + directory + extension + event; size/date restano
**NULL**. Va dichiarato nello schema del nodo, non lasciato implicito (oggi il codice
fa `metadata()` e salterebbe la riga: per delete/rename NON deve saltare, deve emettere
la riga "magra").

⚠️ **rename è dipendente dal SO** (area da rifinire in implementazione, non qui): a
seconda della piattaforma arriva come un evento unico con due path (from→to) o come
due eventi separati (delete del vecchio + create/modify del nuovo). Proposta v1: se la
piattaforma dà entrambi i path in un colpo → una riga `rename` con `path`=nuovo e un
campo extra `old_path`=vecchio; se li dà separati → emergono come `delete`(vecchio) +
`new`/`update`(nuovo), documentato per-OS. Da confermare quando ci arriviamo.

## 7. Connessioni: RIAPERTE per sessione (DECISIONE utente)
Niente pool tra sessioni: ogni sessione apre le sue connessioni, committa, chiude —
coerente col ciclo transazionale per-gruppo (§2) e col rollback già sistemato (P95/P96,
`lane_txns.finalize_with_outcome`). Costo: una riapertura per gruppo, accettato ("non
costa realmente molto"). Pool tra sessioni = ottimizzazione futura, non v1.

## 8. Monitor / eventi — N sessioni (area da rifinire, parte del lavoro)
Oggi gli eventi sono per-run/per-nodo, con l'assunto di UN'esecuzione. Il continuo
esegue la lane N volte: il Monitor deve poter mostrare più sessioni senza sovrascrivere
la precedente. Approccio leggero proposto: un **indice di sessione** che accompagna gli
eventi di nodo (Started/Completed/stat), così la UI le distingue/somma. NON un nuovo
tipo di run. Il dettaglio (contatore sessioni, stat cumulative vs per-sessione, cosa fa
lampeggiare) è una decisione a sé, da chiudere prima della fetta che tocca l'eventing.

## 9. Scoping v1 e FETTE (proposta)
Scoping v1: **un watcher continuo come driver della SUA lane**; il loop di sessione è
per-lane. Interazione con altre lane nello stesso run (una continua, altre finite) =
da definire, probabilmente fuori v1 (v1 = focus single-lane / un continuo per run).
Fette candidate (da rivedere insieme):
1. **Eventi + schema** (one-shot e continuo): new/update/rename/delete, riga "magra"
   per delete/rename, vocabolario unico, schema d'uscita dichiarato. TS + Rust, piccola.
2. **Sottoscrizione persistente + coda run-scoped** (registro engine, canale tokio,
   callback → coda). Isolata, testabile con un log.
3. **Loop di sessione dell'engine** (attesa/debounce/snapshot/coalescing/esegui-lane/
   commit-close/ripeti + cancel). Il cuore. Riusa lane_txns e P93.
4. **Nodo watcher continuo** come adattatore che pesca il gruppo dalla coda ed emette
   (lato studio: sotto-modo "una volta / continuo" nel pannello watch).
5. **Monitor a sessioni** (indice di sessione negli eventi) — dopo aver chiuso §8.

## 10. Rischi / trappole
- **Coda in-memory + crash = perdita** (§3): documentare, non nascondere.
- **first-wins + create→delete nello stesso gruppo** (§5): riga `new` su file assente;
  la valle deve reggere l'assenza.
- **rename per-OS** (§6): non promettere semantica uniforme prima di provarla.
- **Stato dei nodi tra sessioni**: azzerato per costruzione (bene), ma i nodi-servizio
  o le risorse a vita-run (se mai) non seguono questa regola — per ora nessuno nel watch.
- **Ordine degli eventi nella coda**: preservare l'ordine d'arrivo per il first-wins;
  la `tokio::mpsc` lo garantisce FIFO per singolo producer (la callback è un solo
  producer) — ok.
- **Debounce vs latenza**: la finestra di coalescing del burst aggiunge un piccolo
  ritardo prima di far partire la sessione; tenerla corta e configurabile.

## 11. DECISIONI FISSATE (riepilogo)
- 3 modalità: scan · watch one-shot · watch continuo. Tutte mantenute. ✅
- Continuo = modello a **sessioni** (una esecuzione lane completa per gruppo, commit/
  chiusura per sessione). ✅
- Sottoscrizione + coda **run-scoped** (sopra la lane), non nel nodo. ✅
- Coda **in-memory** v1 (crash = perdita, documentato). ✅ [utente]
- Coalescing di gruppo: **primo evento per path** (first-wins). ✅ [utente]
- Eventi: **new/update/rename/delete**. ✅ [utente]
- Connessioni **riaperte per sessione**, niente pool v1. ✅ [utente]
- Cancellazione via **P93** (`stop_run`/token). ✅
### Da confermare prima di implementare
- Monitor a sessioni: indice di sessione sugli eventi? (§8)
- rename per-OS: forma della/e riga/righe? (§6)
- update = solo Modify(Data)? (metadata escluse) (§6)
- scoping multi-lane: v1 = un continuo per run / single-lane? (§9)
