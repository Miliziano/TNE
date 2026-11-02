# Studio — prestazioni del motore e near real time

> Scritto il 31 ottobre 2026 (P382). Misure fatte nel sandbox, su codice reale, non stime.
> Requisiti dell'utente da tenere sempre presenti: **prestazioni, sicurezza, elasticità**.
> Da leggere con `docs/ARCHITETTURA-coordinatore.md` (runtime, agente, coordinatore).

---

## 1. Come si è misurato

**Banco di prova:** 1 milione di righe CSV (5 colonne, 35 MB) → *Transform* con tre
espressioni FPEL (`to_float(qty) * to_float(price)`, `upper(name)`, `concat(city, "-", id)`)
→ *Filter* (`total > 100`) → *File Output* CSV (958.592 righe, 68 MB). Piano costruito a
mano con gli stessi nodi e lo stesso IR che produce lo studio, eseguito con `engine_run`.
Codice del banco in appendice.

**Macchina:** sandbox, 2 vCPU Xeon 2,1 GHz. I numeri assoluti su un server saranno più
alti; contano i rapporti. Ogni misura ripetuta 2-3 volte; l'output è identico byte per
byte prima e dopo le modifiche (stesso md5).

**Profilo:** `valgrind --tool=callgrind` su 100.000 righe, per sapere dove va il tempo.

**Dal P386, confronto alternato.** Su questa macchina due misure della stessa versione a
distanza di minuti differiscono anche del 20%. Per questo le versioni si confrontano con
due binari compilati nella stessa sessione ed eseguiti a turno (A, B, A, B…, cinque giri
per banco), guardando la mediana. Tre banchi: Transform+Filter senza mapping, lo stesso
con il mapping di sorgente e di uscita (il caso reale dello studio), TMap.

---

## 2. Risultati

| | righe/s | tempo (1M) | memoria di picco |
|---|---:|---:|---:|
| Prima (P381) | 86.000 | 11,7 s | 26 MB |
| + allocatore mimalloc | 180.000 | 5,6 s | 36 MB |
| + hash veloce (ahash) per le righe | 196.000 | 5,1 s | 37 MB |
| **P382 (release)** | **200.000** | **5,0 s** | **38 MB** |
| P382 con il profilo del runner di prima (`opt-level "z"`) | 150.000 | 6,7 s | 35 MB |
| **P383** (espressioni compilate, contesto senza HashMap, Transform senza copia della riga) | **230.000** | **4,3 s** | **37 MB** |
| **P385** (righe con schema condiviso: nomi una volta sola, valori in un vettore) | **310.000** | **3,2 s** | **33 MB** |
| **P386** (posizioni per schema, sorgente e uscita CSV senza copie, lotti fra lettura e nodo) | **380.000** | **2,6 s** | **33 MB** |

**TMap (P383).** Secondo banco: 500.000 ordini × 9.000 clienti (join), una trasformazione,
due uscite con filtro, espressioni con `upper`, `concat`, `CASE`, `var()`. Da **120.000 a
200.000 righe/s** (+65%). Il guadagno viene soprattutto dalle copie tolte: ogni riga di
lookup veniva clonata due volte (sotto id e sotto etichetta) per ogni riga main che la
usava, e la riga main e quella delle trasformazioni una volta per combinazione. Output
identico byte per byte anche con join *left*, *first*, uno-a-molti e uscita degli scarti.
Col P385 (righe con schema) il TMap passa a circa **235.000 righe/s** (+27% sul P384,
misurato nella stessa sessione: 185.000). Col P386, nel confronto alternato, **+22% sul
P385**.

| Avvio e chiusura del runner | prima | P382 |
|---|---:|---:|
| Ammissione (`--admit-only`: firma, policy, configurazione) | 3 ms | 3 ms |
| Run di un piano minimo, processo completo | 106 ms | 17 ms (min 8) |

Cosa è cambiato nel P382:

- **Allocatore mimalloc** (globale, tutti i binari). Il profilo diceva il 40% del tempo in
  `malloc`/`free`: il motore crea molte piccole strutture per ogni riga. Da solo raddoppia
  il throughput. Costo: circa 10 MB di memoria in più, costante.
- **`ahash` per le righe** al posto dell'hash standard (SipHash): più veloce e comunque con
  chiave casuale, quindi resistente a chi manda JSON con chiavi costruite apposta (HashDoS).
- **Profilo del runner `opt-level = 3`** invece di `"z"`: il binario distribuito era
  ottimizzato per la dimensione e girava il 25% più lento.
- **Nome della funzione FPEL**: non si alloca più una stringa minuscola a ogni chiamata.
- **Runner**: guarda gli eventi ogni 10 ms invece di 100 (un run breve aspettava fino a
  100 ms solo per accorgersi di essere finito); al monitor spedisce a lotti ogni 250 ms.
- **File Output su database (`sink_db`), near real time**: vedi §4.1, era un difetto vero.

---

## 3. Dove va il tempo adesso

Dal profilo dopo il P382, in ordine:

1. **Allocazioni** (~20%): ogni riga è una `HashMap<String, Value>` e **ogni nome di campo
   è una `String` copiata in ogni riga, a ogni nodo**. Un milione di righe × 8 campi × 4
   nodi = decine di milioni di stringhe create e distrutte.
2. **Copie delle righe** (~8%): un nodo che aggiunge campi (Transform in modo *add*) clona
   l'intera mappa della riga.
3. **Hash dei nomi** (~8%): ogni lettura di campo calcola l'hash del nome. Il valutatore
   FPEL, in più, crea a ogni riga una piccola `HashMap` degli ingressi (`EvalContext`).
4. **Valutazione delle espressioni** (~5%): l'albero dell'espressione si interpreta a ogni
   riga, cercando la funzione per nome.
5. Lettura e scrittura CSV (~8%): codice nostro, ragionevole.

Il punto è uno solo: **la riga non sa com'è fatta**. Lo studio conosce lo schema di ogni
porta, ma al motore arrivano mappe di nomi. È anche il motivo per cui le colonne del file
di uscita escono in ordine alfabetico invece che nell'ordine del mapping.

---

## 4. Near real time

### 4.1 Difetto trovato e corretto nel P382: righe ferme nel buffer del database

`sink_db` scriveva un lotto solo a `batchSize` righe (default 1000) o a fine flusso. In una
lane di servizio (webhook, MQTT, coda, dir_watcher continuo) con poco traffico, le righe
restavano **in memoria finché non ne arrivavano mille**: con 10 messaggi l'ora, giorni.
Ora la prima riga di un lotto fissa una scadenza, `flushIntervalMs` (default 1000 ms,
nuovo campo *Flush interval* nel pannello): a scadenza si scrive quello che c'è. Vale in
tutti i percorsi di scrittura a lotti (normale, transazionale, master-detail transazionale,
ODBC). Nei
run a lotti non cambia nulla, perché lì il flusso arriva tutto di fila.

### 4.2 Cosa abbiamo già, rispetto a una runtime Java

- **Avvio**: ammissione in 3 ms, run minimo in 8-17 ms, processo compreso. Una JVM con un
  job di tipo Talend impiega tipicamente da qualche centinaio di millisecondi ad alcuni
  secondi solo per partire e caricare le classi (non misurato qui). Per micro-lotti
  frequenti è la differenza fra "ogni secondo" e "ogni minuto".
- **Memoria**: 38 MB di picco per un milione di righe in streaming. Una JVM parte da
  decine-centinaia di MB di heap prima di elaborare una riga.
- **Latenza prevedibile**: niente garbage collector, quindi niente pause. In una JVM le
  pause del GC sono la causa classica dei picchi di latenza (p99) in near real time.
- **Binario unico**, nessun runtime da installare o aggiornare.

### 4.3 Cosa manca

- **Throughput per riga**: il codice che Talend genera usa righe tipizzate (una classe per
  schema), e il JIT le rende molto veloci. Su questo terreno oggi siamo dietro. Le voci A e
  B qui sotto servono a superarlo.
- **Garanzie di consegna** per le sorgenti a messaggi (MQTT, ActiveMQ): confermare il
  messaggio solo dopo che la riga è scritta, così un crash non perde dati (at-least-once).
- **Metriche di latenza** per nodo (tempo di attraversamento p50/p99), non solo righe/s.
- **Scadenza anche negli altri sink** (File Output tiene un buffer di 8 KB fino alla fine
  della lane; da portare alla stessa regola di `sink_db`).
- **Runner "caldo"**: un processo che resta acceso e lancia i run senza ripartire. Oggi
  il motore ha stato globale pensato per un run alla volta (bus eventi, reporter). Il
  pezzo di motore che serve all'agente futuro è togliere quello stato globale.

---

## 5. Migliorie sostanziali, in ordine

Ogni voce è applicabile da sola e non cambia i formati (artifact, eventi, configurazione):
nessuna rifà lavoro esistente.

| | Cosa | Guadagno atteso | Costo | Rischio |
|---|---|---|---|---|
| **A** ◐ P385-P386 | **Righe con schema**: `Row` = schema condiviso (`Arc`) + vettore di valori; i nomi si risolvono in posizioni una volta per nodo. L'API `get`/`set` per nome resta, così i nodi si migrano uno alla volta. | 2-3× sul throughput; meno memoria; colonne nell'ordine del mapping | alto (tocca tutti i nodi, ma a passi) | medio: serve un banco di non regressione per nodo |
| **B** ✅ P383 | **Espressioni compilate una volta** all'avvio del nodo: costanti calcolate, `var()` e nomi risolti, valori letti in prestito; niente `HashMap` per riga nel valutatore. Fatto per Transform, Filter, TMap; lo Script usa ancora l'interprete (gode del contesto nuovo). | misurato: +24% sul banco Transform/Filter, +65% sul TMap (con le copie tolte) | medio | basso: test di equivalenza con l'interprete |
| **C** | **Parallelismo per partizione** dei nodi senza stato (Transform, Filter, TMap, Script): N copie su N core, ordine preservato se richiesto. | lineare coi core (su un server da 16 core, fino a 10× su quei nodi) | medio | medio: ordine e lookup condivisi |
| **D** ◐ P386 (solo sorgente file) | **Canali a lotti adattivi**: si passano blocchi di righe invece di righe singole, con invio immediato quando il flusso rallenta (non peggiora la latenza). | 10-20% | basso-medio | basso |
| **E** | **Garanzie di consegna** per MQTT/ActiveMQ: conferma dopo la scrittura; con sink idempotenti (upsert) l'effetto è "una volta sola". | affidabilità, non velocità | medio | medio |
| **F** | **Metriche di latenza** per nodo negli eventi (campi facoltativi, contratto rispettato). | osservabilità near real time | basso | basso |
| **G** | **Stato del run invece di stato globale** (bus, reporter, registri): prerequisito del runner caldo e dell'agente. | avvio dei run in microsecondi dentro un processo acceso | medio | medio |
| **H** | **Operatori colonnari** (Apache Arrow) per aggregate, join, sort, window su grandi volumi. | 5-20× su quei nodi | alto | alto: da valutare dopo A |

**Nota dopo il P383.** La valutazione delle espressioni pesava circa il 22% del banco: la
compilazione da sola non poteva dare di più. Il resto del tempo sta nel modello della riga
(nomi copiati e cercati per hash), nella lettura e nella scrittura CSV. Per questo A resta
il passo che conta di più.

**Ordine consigliato:** B (rapido, rischio basso) → A (il salto vero) → F e la scadenza
negli altri sink (near real time) → E (garanzie) → C (scala sui core) → G → H.
Dopo A e B l'obiettivo, sullo stesso banco e sulla stessa macchina, è 600.000-1.000.000
di righe/s (stima da verificare con le misure, non una promessa), con memoria costante e
senza pause: alla pari o oltre un job Java, con una frazione della memoria e un avvio di
millisecondi invece che di secondi.

**Regola di lavoro:** prima di ogni voce si fissa il banco di prova come test di non
regressione (stesso output, byte per byte), e si misura prima e dopo.

---

## 6. Regole per le righe con schema (voce A), decise il 2 novembre

Requisito dell'utente: **nessuna rigidità alla Talend**, dove un job può fallire a runtime
perché gli schemi di ingresso e di uscita di un componente non coincidono nella posizione
dei campi. E la compatibilità con i progetti esistenti non è un vincolo (prototipo v1).

1. **Le posizioni non escono mai da un nodo.** Ogni confine resta per nome: elenco delle
   colonne SQL, intestazione CSV, chiavi JSON, mapping, espressioni. Nessuna istruzione
   verso un sistema esterno usa la posizione di un campo (oggi già così: `INSERT INTO t
   (col_a, col_b)` coi valori presi per nome).
2. **Lo schema non è un contratto dichiarato, è una descrizione dei dati.** Lo crea chi
   produce le righe (una sorgente dalla sua intestazione, un nodo dai campi che scrive) e
   viaggia attaccato alla riga. Nessun nodo pretende uno schema "giusto": se le righe
   cambiano forma, il nodo si adatta.
3. **Il controllo d'identità sta in un solo posto, la riga.** Un nodo usa le posizioni
   calcolate solo se la riga ha lo stesso schema per cui le ha calcolate (confronto di
   puntatori); altrimenti le ricalcola o legge per nome. Impossibile leggere "il campo
   sbagliato".
4. **Campo assente = null, campo in più = passa.** Come oggi. Mai un errore di run perché
   una riga ha un campo in più o in meno.
5. **Forme molto variabili** (JSON con chiavi diverse a ogni riga): oltre un tetto di
   schemi diversi la riga torna a comportarsi come oggi; più lenta, mai sbagliata.
6. **Ogni passo si dimostra col banco di non regressione** (sotto). Un cambiamento voluto
   dell'output si registra rigenerando gli attesi e guardando il diff.

### Banco di non regressione (P384)

`src-tauri/tests/motore_regressione.rs` + `src-tauri/tests/regressione/` (file attesi):
dati deterministici, piani reali, confronto byte per byte. Scenari: Transform+Filter con
scarti, TMap inner/left/first con uno-a-molti e scarti, Aggregate, Pivot dinamico, JSON
Parser con campi del padre, Script (campi dentro `if`, `emit`, `reject`, `let`), Union di
schemi diversi, CSV irregolare, Join. Gira in 0,3 s; in CI prima della build del runner.

### Primo passo fatto (P385): la riga nuova dietro la stessa interfaccia

`src-tauri/src/engine/row.rs`. `Row` = `Arc<Schema>` (elenco dei nomi, condiviso) +
`Vec<Value>`. L'interfaccia per nome è quella di prima (`get`, `set`, `insert`, `remove`,
`iter`, `keys`…), più `set_str`/`insert_str` che non allocano il nome quando il campo c'è
già o la forma è già stata vista: è la via usata da sorgente CSV, Transform e TMap.

- **Schemi derivati in cache.** Aggiungere o togliere un campo produce lo schema derivato
  una volta sola; le righe che cambiano forma allo stesso modo lo condividono (stesso
  puntatore). Tetto di 256 transizioni per schema: oltre, gli schemi nuovi non si tengono
  (regola 5: più lento, mai sbagliato).
- **Ricerca per nome**: scorrimento dei nomi sotto i 12 campi (più veloce di un hash su
  nomi corti), indice oltre.
- **Ordine dei campi = ordine di inserimento** (prima: ordine casuale della HashMap). Le
  uscite che ordinano esplicitamente (CSV senza mapping, JSON) non cambiano: il banco di
  non regressione è passato **identico, senza rigenerare nessun file atteso**.
- Le posizioni restano dentro `row.rs` (regola 1); nessun nodo le vede ancora.

Misure (stessa macchina, stessa sessione, release): Transform+Filter da ~230.000 a
**~310.000 righe/s** (+35%), TMap da ~185.000 a **~235.000** (+27%), memoria invariata.

**Passi successivi della voce A**, uno per nodo, ognuno col banco: i nodi caldi calcolano
le posizioni una volta per schema (controllo di puntatore, regola 3) e leggono per
posizione; le sorgenti costruiscono lo schema dall'intestazione una volta sola e creano le
righe con `Row::from_parts`; lo Script passa alle espressioni compilate.

### Secondo passo (P386): posizioni calcolate una volta per forma di riga

Mediane del confronto alternato col P385 (righe/s, 2 vCPU):

| banco | P385 | P386 | |
|---|---:|---:|---:|
| Transform + Filter, 1M righe | 302.000 | 381.000 | +26% |
| stesso, con mapping di sorgente e uscita | 261.000 | 356.000 | +36% |
| TMap 500k × 9k | 223.000 | 273.000 | +22% |

Cosa è cambiato:
- **`Slots` e `Writer`** (`engine/row.rs`): un nodo che legge o scrive sempre gli stessi
  campi calcola le posizioni una volta per schema. A ogni riga si confronta lo schema con
  quello per cui le posizioni valgono (un puntatore); se la riga ha un'altra forma si
  ricalcolano. È la regola 3: il controllo sta nella riga, non nei nodi. `Writer` ha la
  stessa semantica di una sequenza di `set` (anche coi nomi ripetuti) e produce lo stesso
  schema derivato, condiviso.
- **Usati da**: Transform (tutti e tre i modi), mapping della sorgente file, intestazione
  CSV, mapping del File Output (`FieldMapping::apply`, comune ai sink che lo usano).
- **File Output CSV**: la riga non si copia più (si copiava sempre, anche quando non
  serviva rimandarla a valle); ogni riga si compone in una stringa riusata, coi valori
  presi in prestito (`Value::str_repr`); in UTF-8 il testo va al file senza ricodifica.
- **Sorgente CSV**: una riga senza virgolette si taglia sul delimitatore senza copiarla
  carattere per carattere (stesso risultato del ciclo completo, che resta per le altre).
- **Lotti fra il thread di lettura e il nodo, con posti prenotati insieme.** Questa è la
  scoperta più utile del passo: vedi sotto.

**Il costo che non si vedeva: i risvegli.** Le prime versioni del P386 eseguivano il 17% di
istruzioni in meno sul TMap ma erano più *lente* del 18-29% in tempo reale; su un solo
core erano più veloci. Le chiamate di sistema lo hanno spiegato: `futex` da 107.000 a
136.000 per run. Ogni riga che attraversa un canale fra due thread può costare un
risveglio del thread che aspetta; rendendo più veloce la sorgente, il canale verso il
TMap restava sempre pieno e ogni riga letta dal TMap risvegliava la sorgente per una sola
riga. Rimedio locale: la sorgente manda lotti di 256 righe e li inoltra prenotando i posti
del canale tutti insieme (`reserve_many`): chi scrive si risveglia una volta per lotto.

È la misura diretta della voce **D** (canali a lotti): sul TMap il coordinamento fra i
thread pesa più del lavoro sulle righe. Il prossimo guadagno grosso viene da lì, per tutti
i nodi, con una regola che non aggiunga latenza ai flussi lenti (un lotto parte subito
quando chi lo produce sta per mettersi in attesa).

**Trovati misurando, da sistemare dopo:**
- **Avanzamento troppo fitto.** Ogni nodo emette un `NodeProgress` ogni 500 righe: 2.800
  eventi in un run di 2,5 s sul TMap, 6.900 sul banco da un milione. Ogni evento passa dal
  bus (con lock), dal registro dei run su file e dal monitor. Basta un evento ogni 250 ms
  per nodo.
- **Campionatore della memoria pensato per lo studio desktop.** Ogni 150 ms legge
  `/proc/<pid>/status` di *tutti* i processi della macchina per trovare i processi WebKit.
  Nel runner non servono: basta il processo stesso. Su un server con centinaia di
  processi sono migliaia di letture al secondo.
- **Il bus degli eventi si scorre tutto a ogni lettura** (`drain_since` filtra fino a
  10.000 eventi a ogni polling).

### Comportamenti di oggi da decidere col nuovo modello

Il banco li ha resi visibili (sono registrati negli attesi così come sono oggi):
- **CSV con due colonne dallo stesso nome**: la seconda sovrascrive la prima in silenzio
  (`name,name` → resta solo l'ultimo valore).
- **Righe CSV più corte**: i campi mancanti non ci sono proprio (non null); **più lunghe**:
  nascono `col_5`, `col_6`…
- **Colonne in uscita in ordine alfabetico** quando non c'è un mapping.

Proposta per la voce A: nomi duplicati resi univoci (`name`, `name_2`) con avviso; campi
mancanti come null (forma costante); ordine naturale delle colonne. Si decidono quando si
arriva lì, e il diff degli attesi mostrerà esattamente cosa cambia.

---

## Appendice — banco di prova

Esempio usa-e-getta (`src-tauri/examples/bench_motore.rs`, non nel repo), da lanciare con
`cargo run --release --no-default-features --example bench_motore -- 1000000 /tmp/bench`.

```rust
use app_lib::engine::{engine_run, engine_poll_events};
use serde_json::json;
use std::io::Write;
use std::time::Instant;

fn vmhwm() -> String {
    std::fs::read_to_string("/proc/self/status").ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM")).map(|l| l.split_whitespace().nth(1).unwrap_or("?").to_string()))
        .unwrap_or("?".into())
}

fn main() {
    let rows: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(1_000_000);
    let dir = std::env::args().nth(2).unwrap_or("/tmp/bench".into());
    std::fs::create_dir_all(&dir).unwrap();
    let input = format!("{dir}/in.csv");
    if !std::path::Path::new(&input).exists() {
        let mut f = std::io::BufWriter::new(std::fs::File::create(&input).unwrap());
        writeln!(f, "id,name,qty,price,city").unwrap();
        let cities = ["Milano", "Roma", "Torino", "Napoli", "Bari"];
        for i in 0..rows {
            writeln!(f, "{},cliente {},{},{}.{:02},{}", i, i % 9973, i % 17 + 1, i % 500, i % 100, cities[i % 5]).unwrap();
        }
    }
    let lit = |v: serde_json::Value| json!({"kind":"Literal","value": v});
    let field = |f: &str| json!({"kind":"DirectFieldRef","field": f});
    let plan = json!({ "run_id": "bench", "bridges": [], "lanes": [{
        "lane_id": "l1", "label": "L", "variables": {},
        "edges": [
            {"edge_id":"e1","source_node":"src","source_handle":"output","target_node":"tr","target_handle":"input"},
            {"edge_id":"e2","source_node":"tr","source_handle":"output","target_node":"fl","target_handle":"input"},
            {"edge_id":"e3","source_node":"fl","source_handle":"keep","target_node":"out","target_handle":"input"}
        ],
        "nodes": [
            {"node_id":"src","node_type":"source_file","label":"in","config":{},"spec":{"props":{"path": input, "format":"csv","hasHeader":"true"}}},
            {"node_id":"tr","node_type":"transform","label":"tr","config":{},"spec":{"props":{},"config":{"mode":"add","fields":[
                {"name":"total","expr":{"kind":"BinaryOp","op":"MUL","left":{"kind":"FunctionCall","name":"to_float","args":[field("qty")]},"right":{"kind":"FunctionCall","name":"to_float","args":[field("price")]}}},
                {"name":"name_up","expr":{"kind":"FunctionCall","name":"upper","args":[field("name")]}},
                {"name":"tag","expr":{"kind":"FunctionCall","name":"concat","args":[field("city"), lit(json!("-")), field("id")]}}
            ]}}},
            {"node_id":"fl","node_type":"filter","label":"fl","config":{},"spec":{"props":{},"config":{"conditions":[{"id":"keep","label":"keep","mode":"code","expr":{"kind":"BinaryOp","op":"GT","left":field("total"),"right":lit(json!(100))}}]}}},
            {"node_id":"out","node_type":"sink_file","label":"out","config":{},"spec":{"props":{"path": format!("{dir}/out.csv"),"format":"csv"}}}
        ]}]});
    let rt = tokio::runtime::Runtime::new().unwrap();
    let t0 = Instant::now();
    rt.block_on(async {
        engine_run(plan.to_string()).await.unwrap();
        let mut cursor = 0;
        loop {
            let r = engine_poll_events(cursor).await.unwrap();
            cursor = r.cursor;
            for e in &r.events {
                let v = serde_json::to_value(&e.event).unwrap();
                let t = v["type"].as_str().unwrap_or("");
                if t == "NodeFailed" { eprintln!("{}", v); }
                if t == "RunCompleted" || t == "RunFailed" {
                    let s = t0.elapsed().as_secs_f64();
                    println!("{t} rows={rows} secs={s:.2} rows/s={:.0} VmHWM_kB={}", rows as f64 / s, vmhwm());
                    return;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    });
}
```
