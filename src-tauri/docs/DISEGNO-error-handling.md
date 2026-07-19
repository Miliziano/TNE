# Disegno — gestione errori unificata (v2, 19 lug)

Segue la ricognizione (`RICOGNIZIONE-gestione-errori.md`). Qui c'è il **target**:
come sarà, non com'è. È la spec da cui discendono le patch, una alla volta.
Repo: `origin/main` @ `6a6cef8`.

Questa è la **seconda stesura**: rispetto alla v1 l'interruzione della pipeline
non è più una modalità del nodo (la decide l'error handler), e sono emersi due
concetti portanti — i **due canali d'errore** e la **propagazione via bridge**.

---

## 1. Le decisioni prese (recap)

- Ogni nodo ha **un solo campo** di gestione errori, con **4 modalità** (§3).
- **L'interruzione della pipeline non è una scelta del nodo**: il nodo trasmette
  l'errore, è **l'error handler** a decidere se fermare o proseguire.
- **Le riprove sono del nodo**, non dell'error handler.
- **Default** = *lascia all'error handler* — che esiste sempre (§4), quindi il
  default ha sempre un destinatario.
- **Due viste sincronizzate** su un'unica verità (§7).
- **Transazioni**: il rollback della propria lane è sacro; la reazione al
  fallimento altrui è decisione locale dell'handler (§9).
- **Fallimento cross-lane**: propagato **solo via bridge** (§5).

---

## 2. I due canali d'errore (il concetto portante)

Tutto il modello si regge su una distinzione: un errore può viaggiare su due
canali diversi, che non vanno confusi.

- **Canale DATI** — le righe cattive. Una singola riga non si processa: esce dal
  nodo con lo schema `_error_*` (via la porta `catch`) e va dove l'utente la manda.
  È roba a livello di **riga**. Il nodo prosegue con le righe successive.
- **Canale CONTROLLO** — le eccezioni di nodo. Il nodo intero non può proseguire:
  file in uso, rete assente, timeout, risorsa persa. Non c'è una riga da spostare;
  c'è un'**eccezione** che sale all'error handler, il quale decide se interrompere
  la pipeline (in modo controllato) o lasciarla andare. È roba a livello di **nodo**.

Con questa lente le quattro modalità si leggono senza ambiguità: *cattura sul
nodo* governa il canale dati; *lascia all'error handler* delega il canale
controllo. E un **errore fatale-di-nodo, non avendo righe da muovere, finisce
sempre sul canale controllo** → all'error handler. Non è un caso speciale: è la
conseguenza del modello.

---

## 3. Le 4 modalità per-nodo

| # | Etichetta UI | Chi gestisce | Cosa fa |
|---|-------------|--------------|---------|
| 1 | **Lascia all'error handler** *(default)* | error handler | l'errore va all'handler della lane, che decide interrompi/prosegui e applica le sue regole |
| 2 | **Cattura sul nodo** | il nodo | la riga in errore esce dall'handle `catch` (schema `_error_*`); il nodo prosegue |
| 3 | **Riprova, poi error handler** | nodo, poi handler | riprova N volte; se ancora fallisce, l'errore va all'handler |
| 4 | **Riprova, poi cattura sul nodo** | il nodo | riprova N volte; se ancora fallisce, la riga esce dall'handle `catch` |

Note:
- Le modalità **3–4** portano **numero tentativi** e **attesa** (`retryCount` /
  `retryDelaySec`, già nel tipo), visibili solo quando selezionate.
- **Solo 2 e 4** attivano l'handle `catch` sul nodo.
- Nessuna voce "interrompi la pipeline": l'interruzione è competenza esclusiva
  dell'error handler. Nessuna voce "riprova poi error handler + retry": l'handler
  non ritenta (il retry è solo del nodo), quindi "riprova poi handler" è sensato e
  non ridondante.

---

## 4. L'error handler (per-lane, garantito, decisore)

- **Uno per lane, sempre presente, non cancellabile.** Verificato nel codice:
  `_addLaneErrorHandler(laneId)` scatta alla creazione di ogni lane
  (`flowStore.ts:1395`); l'handler nasce `deletable: false` (:220). Quindi il
  default "lascia all'error handler" ha **sempre** casa — "delega nel vuoto" è
  impossibile per costruzione, niente validazione da aggiungere.
- **Agisce a livello di nodo.** Riceve gli errori dei nodi in modalità `handler`
  (e le eccezioni di controllo, §2), e con le sue **regole** (`ErrorRule`: match
  per `always` / `node_type` / `error_code`) decide l'esito, inclusa
  l'**interruzione controllata** della pipeline.
- **Interruzione controllata** = non un kill brutale: le transazioni aperte fanno
  rollback e i nodi si chiudono in modo pulito (§9).

---

## 5. Fallimento cross-lane: la propagazione via bridge

**Problema (verificato nel motore).** Le lane girano in parallelo
(`mod.rs:182`, tokio::spawn indipendenti). Un bridge è un canale mpsc
(`bridge.rs`, buffer 5000): la lane a monte (bridge_out) pubblica, quella a valle
(bridge_in) consuma. Oggi, se la lane a monte **fallisce**, il suo estremo del
canale viene chiuso, e la lane a valle vede `recv() == None` — **lo stesso segnale
che riceve quando il monte ha finito bene**. Risultato: la lane a valle processa
dati parziali come se fossero completi e si dichiara riuscita. È il buco
silenzioso di P27 (chiusura di canale ambigua) portato tra le lane.

**Disegno.** Il bridge oggi trasporta solo il canale DATI. Gli si aggiunge il
canale CONTROLLO: quando la lane a monte fallisce, il fallimento si **propaga come
segnale** al bridge_in a valle, che lo traduce in **eccezione di nodo** → l'error
handler di quella lane decide cosa fare.

- **Solo i bridge** portano il segnale — sono l'unico punto in cui una lane
  dipende da un'altra. Niente broadcast globale: le lane non collegate non sono
  toccate.
- **Ogni error handler di valle decide** (interrompere, fare rollback, proseguire).
  Indipendenza di *governo*, non isolamento cieco.

---

## 6. Il modello dati

### 6.1 Il campo
Oggi (`types/index.ts:40`): `onError: 'stop' | 'skip' | 'retry' | 'propagate'`.
Diventa un enum a 4 valori. Nomi interni **proposti** (da confermare):

| # | Etichetta UI | valore interno |
|---|-------------|----------------|
| 1 | Lascia all'error handler | `handler` |
| 2 | Cattura sul nodo | `catch` |
| 3 | Riprova, poi error handler | `retry_handler` |
| 4 | Riprova, poi cattura sul nodo | `retry_catch` |

### 6.2 Migrazione dai 4 valori attuali
Nessun progetto salvato esiste (niente persistenza, accertato in P25): la
migrazione riguarda i default in codice e i props scritti in sessione.

| vecchio | nuovo | note |
|---------|-------|------|
| `stop` | `handler` | l'interruzione ora la decide l'handler, non il nodo |
| `skip` | `catch` | "salta" rimosso; chi l'aveva ora cattura (porta scollegata = si perdono, con avviso) |
| `propagate` | `catch` | era già "esci dall'handle catch" |
| `retry` | `retry_handler` | il retry legacy non diceva "poi cosa"; delegare all'handler è il default prudente |

Una funzione `normalizeOnError(old)` centralizza la mappa: nessun `===` sparso
conosce i vecchi nomi.

---

## 7. Le due viste sincronizzate

**Verità unica**: `node.data.advanced.onError` sul singolo nodo.

- **Pannello del nodo** (`TabAdvanced.tsx`): il dropdown a 4 voci scrive quel
  campo. Resta qui — è la vista "vicino al nodo": non si sposta, si aggiorna.
- **Pannello dell'error handler** (`error_handler/Panel.tsx`): oggi ha solo una
  policy di default documentale. Va **esteso** con l'elenco dei nodi della lane e,
  per ciascuno, la sua modalità **editabile** — che scrive **lo stesso** campo del
  nodo. "Dall'handler dico che il nodo X si gestisce da sé" → sul nodo X compare
  l'handle catch, e il suo tab Avanzate mostra "Cattura sul nodo". Nessuna seconda
  sorgente.

Le **regole automatiche** dell'handler agiscono solo sui nodi in modalità
`handler` (gli unici che gli arrivano). Sui nodi autonomi (`catch`/`retry_catch`)
l'handler non ha voce.

---

## 8. La porta `catch` come fonte unica

Oggi la catch universale è cablata in **due** posti con due `if (onError ===
'propagate')`: `schemaRegistry.ts:197` (canvas) e `lowering.ts:260` (piano) — la
divergenza viva della ricognizione.

Si **dichiara una volta** come porta condizionale in `nodeSemantics`, con `when`
su `onError ∈ { catch, retry_catch }` (le sole due modalità che la attivano), e si
tolgono i due if. Diventa una porta come le altre, che passa da `portApplies`:
canvas e piano non possono più divergere. È il principio della fase porte,
applicato all'ultima porta rimasta fuori.

---

## 9. Le transazioni e il rollback

Due situazioni distinte, entrambe coerenti:

- **La tua lane fallisce** → il rollback della tua transazione è **sacro**, si
  esegue sempre "come dovuto". È il cuore dell'"interruzione controllata": fermare
  significa prima annullare le scritture aperte e chiudere pulito, non troncare a
  metà.
- **Ti arriva via bridge il fallimento di una lane a monte** → è un evento che il
  *tuo* error handler valuta: può fare rollback (i dati ricevuti sono inaffidabili)
  o proseguire (ciò che hai già scritto è valido). **Decisione locale.**

Non è contraddizione: il rollback obbligatorio riguarda la *propria* transazione;
la reazione al guaio altrui è governo locale dell'handler.

> ⚠️ Conseguenza da affrontare a parte: le **transazioni distribuite** attraverso i
> bridge (A fa rollback, ma B ha già scritto dati derivati da A) sono un problema
> più grande del caso base — annotato, non sciolto qui.

---

## 10. Il motore (semantica runtime)

Oggi il motore non onora nulla (tranne l'`on_error` locale dei serializer): si
implementa la semantica una volta, pulita. Per ogni modalità:

- `handler` → l'errore (riga o eccezione di nodo) va al collettore error handler,
  che applica le regole e decide interrompi/prosegui.
- `catch` → la riga arricchita `_error_*` esce dall'handle catch; il nodo prosegue.
  Handle scollegato → le righe si perdono (avviso in design).
- `retry_handler` / `retry_catch` → si ritenta fino a `retryCount` con
  `retryDelaySec` di attesa; se ancora fallisce, si applica la coda (`handler` /
  `catch`).

Più i due meccanismi trasversali:
- **Canale controllo**: un'eccezione di nodo (fatale) sale sempre all'handler,
  a prescindere dalla modalità delle righe.
- **Propagazione bridge**: il fallimento di una lane diventa un segnale sul
  bridge → eccezione al bridge_in di valle → handler di quella lane (§5).

L'`error_handler` come nodo va implementato (è nella lista `NOT_IMPLEMENTED`, P30):
collettore, regole, decisione, emissione su `error_out`, interruzione controllata.

---

## 11. Ordine di implementazione proposto

Dal più sicuro al più delicato, ogni passo verificabile da solo:

1. **Modello dati + migrazione** (TS): enum a 4 valori, `normalizeOnError`,
   dropdown a 4 voci in TabAdvanced, campi retry condizionali. Zero rischio Rust.
2. **Porta catch come fonte unica** (TS): dichiararla con `when` in nodeSemantics,
   togliere i due if. Verificabile col render probe (come P33).
3. **Viste sincronizzate** (TS): estendere il pannello error handler con l'elenco
   dei nodi che scrive `advanced.onError`. Zero rischio Rust.
4. **Motore — onError + error handler** (Rust): la semantica delle 4 modalità e il
   collettore, incluso il canale controllo. Il pezzo grosso, a consegne piccole.
5. **Motore — propagazione bridge** (Rust): il segnale di fallimento sui bridge.
6. **Motore — rollback controllato** (Rust): l'incastro con l'interruzione e la
   reazione locale al fallimento cross-lane.

I primi tre sono TypeScript, rischio Rust nullo: si chiudono prima, lasciando il
modello coerente sul canvas mentre il motore insegue.

---

## 12. Domande tecniche aperte (prima del motore, non dei passi 1–3)

1. **Granularità del retry**: si ritenta la singola riga o l'intera esecuzione del
   nodo? (cambia il significato di `retryDelaySec`).
2. **`catch` e stato del nodo**: è sicura su ogni tipo, o per aggregati/transazioni
   la cattura a metà corrompe il risultato? Forse non va offerta su tutti.
3. **Ordine rollback ↔ interruzione** (§9): confermare "prima rollback, poi stop".
4. **Formato del segnale di fallimento sul bridge** (§5): cosa viaggia esattamente
   nel canale controllo del bridge.
5. **Nomi interni** dei 4 valori (§6.1): confermare o cambiare.
