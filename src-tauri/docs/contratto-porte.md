# Il contratto delle porte — il modello

**Stato**: seconda stesura, **17 luglio — a fase porte CHIUSA**. Prima stesura
il 16 luglio al commit `931545d`. Dati estratti interrogando
`src/ir/nodeSemantics.ts` (non con regex).

La fase è chiusa: il contratto è la fonte unica, **tutti lo leggono** — chi
disegna, chi valida, chi risolve le connessioni, chi genera il piano — e
`connectionResolver` deriva invece di riscrivere. Delle 13 divergenze della
prima stesura ne restano 5, tutte fuori dallo studio: motore e fase porting.
Una (§9.8) si è rivelata **falsa**.

Questo documento è **il modello**, non il resoconto del codice. Dove i due
divergono, diverge il codice: le divergenze note sono elencate in §9 con il
lavoro che le chiude.

Perché esiste: finora il modello delle porte viveva **solo** dentro
`nodeSemantics.ts`, cioè come codice. Il codice che descrive il mondo cresce
per eccezioni, e ogni eccezione si aggiunge in silenzio. Il risultato è che
per "controllare il modello" bisognava rileggerlo — ed è la ragione per cui
sembrava confuso a ogni ripresa. Da qui in poi il modello si controlla
leggendo **questo**, e `nodeSemantics.ts` lo implementa.

Da leggere insieme a: `node-spec.md` (la busta spec),
`design-validazione.md` (il doppio strato), `architettura-pipeline.md` (D1/D2/D3).

---

## 1. Cos'è una porta, cosa non è

Una **porta** è un punto dichiarato di ingresso o di uscita di un nodo.
`nodeSemantics.ts` è la **fonte unica**: chi disegna, chi valida, chi propaga
lo schema e chi genera il piano **derivano** da lì. Nessuno riscrive.

Non è una porta:
- un **handle di servizio** dell'interfaccia (`input_new`) — è un affordance
  di disegno, non un canale;
- un **arco**. L'arco si attacca a una porta; non la crea. Dove oggi accade
  il contrario (§9) è un difetto.

**`id` è il nome del filo**, e deve combaciare con l'handle disegnato e con
ciò che cerca il motore (`take_primary_output` prova `"output"` per primo).
**`label` è cosa esce** (id `output`, label `passthrough`). Confonderli
significa archi scollegati in silenzio.

---

## 2. I principi

- **Fonte unica.** Quando due componenti descrivono la stessa cosa, divergono,
  e nessuno se ne accorge finché qualcosa non si rompe in silenzio. Su 43 tipi
  ne divergevano 16.
- **Copertura.** Tutti i nodi in palette devono essere implementati nel motore.
  Se qualcosa va rifatto, **va programmato**, non lasciato implicito.
- **Dichiarare, non indovinare.** Se lo studio deve tirare a indovinare cosa
  fa un nodo, la risposta è chiedere all'utente di dichiararlo, non inventare
  un'euristica.
- **Mai una bugia silenziosa.** Un comportamento dichiarato e non implementato
  è peggio di un comportamento assente: il primo si scopre in produzione.

---

## 3. Il modello

Le regole seguenti sono la spec. Sono state dettate dall'utente il 16 luglio;
dove Claude ha aggiunto una conseguenza tecnica, è marcato.

### R1 — Porte statiche o dinamiche, in ingresso e/o in uscita
Ogni nodo può avere porte statiche o dinamiche, solo in uscita, solo in
ingresso, o entrambe: **dipende dalla funzionalità del nodo**. Non esiste una
forma "normale" da cui gli altri derogano.

### R2 — Una porta dichiarata e non collegata è legittima
In particolare il **reject**: alcuni nodi ne hanno uno, e può non essere
usato. Una porta scollegata **non è un problema** e non genera warning. Dove
i reject sono stati dichiarati **servono** e vanno implementati; dove non ci
sono, non servono.

### R3 — I terminali hanno due lati
**Source e sink** — i capi di un flusso — possono avere sia ingressi sia
uscite. I source ricevono **configurazioni** (un `source_file` può ricevere il
path da monte, un `source_db` la query o un parametro). I sink distribuiscono
**segnali di stato**. Il `[]` che avevano un tempo veniva da `HANDLE_MAP` e
non era mai stato verificato.

### R4 — Dati o stato, a scelta dell'utente
Ogni nodo che può emettere uno schema di **campi-dati** delle righe può anche
emettere, **a scelta dichiarata in design**, uno schema di **campi di stato
dell'esecuzione**. È il vocabolario `outputMode`:

| valore | significato |
|---|---|
| `none` | dal nodo non esce nulla verso valle |
| `passthrough` | escono le righe (proprie o inoltrate) |
| `signal` | esce lo stato dell'esecuzione (`SIGNAL_SCHEMA`) |

Il modello sa già esprimerlo senza vocabolario nuovo: **due porte con lo
stesso `id` e `when` mutuamente esclusivi sono legittime e volute** — è il
modo di dire "questa porta cambia natura secondo la configurazione". Lo
`script` lo fa già (v. tabella §8).

### R5 — Non esiste un segnale sostitutivo in assenza di dati
*(regola negativa — ritirata esplicitamente dall'utente il 16 luglio)*

Un nodo che non ha dati da emettere **non emette niente**. Non esiste un
`emitOnEmpty`, non esiste una riga di segnale che sostituisce i dati mancanti.
Il comportamento resta il più semplice.

La ragione per cui si può fare a meno del sostituto è R7: l'attesa non ha
bisogno di una riga.

> ⚠️ Eccezione già implementata e voluta, da non confondere: `sink_file` con
> `output_mode=signal` emette la riga di stato **sempre**, anche a zero righe
> scritte. Quella non è un sostituto dei dati: è il suo `outputMode` normale.

### R6 — Le variabili di lane sono immutabili
I nodi **leggono** le variabili di lane, le clonano, le usano — **nessuno le
modifica a livello globale**. Non esiste un registro di variabili mutabile
condiviso.

Conseguenza voluta: un nodo che elabora — tipicamente lo **script** — **non
può** limitarsi a fare calcoli e cambiare stato invisibile. **Deve emettere i
risultati della propria elaborazione** come campi verso valle.

*(conseguenza tecnica, Claude)* È la scelta che rende il flusso predicibile in
design. Con variabili mutabili condivise il risultato dipenderebbe dall'ordine
di esecuzione, che in un motore concorrente non è definito — e il
pre-compilatore non potrebbe dire nulla di sensato. Con variabili immutabili +
risultati espliciti sull'arco, **tutto ciò che influenza un nodo è visibile
sul canvas**.

Nel motore questo è già vero: `NodeContext.variables` è una `HashMap` clonata
per nodo, in sola lettura — mentre `lane_resources`, `lane_txns` e
`lane_datasets` sono `Arc` condivisi. La differenza è deliberata.

### R7 — L'attesa è la chiusura del canale, non una riga
*(regola sulla meccanica, verificata sul motore — v. §5)*

Un nodo a valle che legge il proprio input fino all'esaurimento **sta
aspettando, per costruzione**, che quello a monte finisca. Vale se sono
passate mille righe e vale se ne sono passate zero.

Quindi: **la barriera è gratis**. Un arco che non porta righe porta comunque
un "prima di". Non serve inventare un segnale per ordinare l'esecuzione, e
non si deve: una riga-segnale si può confondere con un dato, la chiusura di
un canale no.

### R8 — Barriera + parametri, con una sola riga
Quando un nodo **source** ha un ingresso collegato, il suo comportamento è:

1. **drena** l'input fino alla chiusura del canale (→ aspetta chi sta a monte);
2. **usa** ciò che è arrivato per configurarsi.

Le due cose insieme, non in alternativa. Il caso "barriera pura" non è una
modalità separata: è questo comportamento quando arrivano **zero righe** — il
source aspetta e poi si configura da solo, con la propria config statica.

**Cardinalità: al massimo una riga di parametri.** Se ne arrivano due o più,
è un **errore parlante**, non un comportamento.

*(motivazione, Claude — l'alternativa scartata)* "N righe = N esecuzioni"
farebbe del source un **lookup**: un altro nodo, con un'altra semantica, in
cui `rows_out` non è più predicibile in design. Merita un nome suo, se e
quando servirà. Infilarlo dentro `source_db` come comportamento implicito
secondo cosa arriva è lo stesso meccanismo che ci è esploso in mano con
`case 'aggregate'`, che smistava per operazione invece che per tipo.

### R9 — Una porta può essere logica
Una porta può esistere nel contratto **senza essere disegnata né collegabile**
dal canvas: esiste per la validazione e per il motore.

Il caso è il **`catch` dell'`error_handler`**. La raccolta degli errori è una
proprietà della lane — l'`error_handler` è un nodo fisso e non eliminabile,
infrastruttura, non un nodo di flusso — e resta **implicita**: non si cablano
archi a mano per una regola che vale già. Ma la porta si **dichiara**, perché
esiste.

Il `catch` **in uscita** dagli altri nodi è invece universale e condizionato:
appartiene alla gestione errori, non a un tipo di nodo, e c'è su qualunque
nodo con `onError='propagate'`. Lo risolve `getNodePorts`, non i singoli tipi.

---

## 4. Il vocabolario

```ts
PortSpec = {
  id:    string                                  // il nome del filo
  label: string                                  // cosa esce
  role:  'data' | 'signal' | 'reject' | 'catch'  // OBBLIGATORIO
  when?:        { prop, equals?, notEquals?, fallback? }
  maxEdges?:    1 | 'many'    // solo ingressi — quanti ARCHI.  Omesso ⇒ 1
  maxRows?:     1 | 'many'    // solo ingressi — quante RIGHE.  Omesso ⇒ 'many'
  connectable?: boolean       // false = porta LOGICA (R9).     Omesso ⇒ true
}

NodeSemantics = {
  staticInputPorts:        PortSpec[]   // obbligatorio
  staticOutputPorts:       PortSpec[]   // obbligatorio
  acceptsMultipleInputs:   boolean      // ha più di UNA porta d'ingresso
  acceptsDynamicInputs:    boolean      // le porte d'ingresso le calcola il resolver
  producesMultipleOutputs: boolean      // idem, in uscita
  …
}
```

**Le liste sono obbligatorie**, e così `role` e `acceptsDynamicInputs`: chi
aggiunge un nodo non può dimenticarli, glielo dice il typecheck. Non è una
formalità — rendere `acceptsDynamicInputs` obbligatorio ha fatto salire il
typecheck di **esattamente 43 errori**, uno per tipo, finché ognuno non ha
risposto.

**I due `Multiple`/`Dynamic` non sono la stessa cosa**, e confonderli è l'errore
che ha fatto mentire union e serializer per mesi:
- `acceptsMultipleInputs` → **ha più di una porta**. Il `join` ne ha due, e sono
  statiche.
- `acceptsDynamicInputs` → **le porte le calcola il resolver dalla config**
  (tmap, union, i due serializer). `true` implica anche che l'interfaccia
  disegna l'handle di servizio `input_new`: la convenzione, prima non scritta
  da nessuna parte, ora deriva da qui.

**`producesMultipleOutputs` disambigua il vuoto**, e il gemello
`acceptsDynamicInputs` fa lo stesso in ingresso:
- `[] + true` → porte **dinamiche**: zero è **provvisorio**, vuol dire *non
  ancora configurato* (filter, tmap, json_parser, xml_parser);
- `[] + false` → **non ne ha** (bridge_out, lane_end, webhook_responder in
  uscita; bridge_in, lane_start, error_handler in ingresso).

Questa distinzione **non è pignoleria**: senza, la regola "zero porte ⇒ rifiuta
la connessione" bloccherebbe un `filter` appena messo giù. Combacia anche con i
due regimi del motore: i 4 dinamici ricevono l'intera mappa `outputs` e
gestiscono le porte per nome; tutti gli altri passano da `take_primary_output`.

**`maxEdges` ≠ `maxRows`.** Sembrano lo stesso campo e non lo sono: **un arco
solo porta mille righe**. `maxEdges` è design-time (la regola che il canvas
applica quando trascini); `maxRows` è runtime, ed è la R8. Fonderli sarebbe
comodo oggi e velenoso fra un mese — è la forma esatta dello smistamento troppo
grosso che ci è già costato caro.

**`when`** — la porta esiste solo se la config lo dice. Due porte con lo
stesso `id` e `when` mutuamente esclusivi sono **legittime e volute**.

### Il resolver
`getNodePorts(node)` in `src/utils/schemaRegistry.ts` è **il** punto di
verità a runtime del builder. Tre pezzi, in ordine:
1. le statiche dal contratto, con `when` applicato;
2. le dinamiche, per i 4 tipi che il contratto dichiara tali;
3. il `catch` universale (`onError='propagate'`).

Chi lo consuma: `FlowNode` (disegna), `lowering.ts` → `buildOutputPorts`,
`dagValidation` → `EDGE_FROM_UNDECLARED_PORT`. `getNodeHandles` è una vista
per id.

---

## 5. La meccanica del motore che il modello presuppone

Verificata su `executor.rs` il 16 luglio. Il modello ci si appoggia, quindi
va scritta qui.

- Il motore è **concorrente a canali**: tutti i nodi della lane partono
  insieme (`tokio::spawn`), ognuno legge dal proprio `mpsc::Receiver`.
- **La chiusura del canale è il "ho finito"**. Dal codice: *"rilascia i tx
  originali. Restano vivi solo i clone nelle mani dei nodi sorgente — quando
  il sorgente termina, il canale si chiude e il target vede la fine dello
  stream."* → è il fondamento di R7.
- **Non esiste un semaforo di esecuzione.** Un nodo a valle di uno che emette
  zero righe gira comunque: riceve zero righe e finisce. Il segnale non serve
  a dare il permesso di procedere — serve, quando serve, a dare **una riga** a
  chi è guidato dalla riga e senza righe non farebbe niente.
- **Fan-out**: un task clona ogni riga su tutti i destinatari; un
  destinatario chiuso viene ignorato, gli altri continuano.
- **Attesa di più nodi a monte**: automatica. Il canale si chiude quando
  l'ultimo sender viene rilasciato.

---

## 6. Ruoli → regola di schema

| `role` | cosa porta | regola di schema a valle |
|---|---|---|
| `data` | righe di dati | lo schema del nodo, propagato |
| `signal` | una riga di stato dell'esecuzione | `SIGNAL_SCHEMA`, **non** lo schema dati |
| `reject` | righe scartate | lo schema d'ingresso (+ i campi di scarto) |
| `catch` | righe in errore | schema del nodo sorgente + campo `_catch` (object) |

Da qui la ragione per cui `role` conta: **è da lì che discende la regola di
schema**. Un `signal` dichiarato dice a `schemaPropagation` "da qui non esce
uno schema di dati, non lamentarti con chi sta a valle" — ed è ciò che ha
spento i falsi warning con P18.

> **Nota sull'"innesco".** `outputMode = signal` sullo script è, e resta, una
> **dichiarazione di design-time**: dice quale schema esce. **Non** è un
> meccanismo del motore, perché la barriera è già gratis (R7). Il nome
> "innesco" suggerisce un meccanismo che non esiste: da rivedere al restyling,
> insieme alla collocazione della sezione nel pannello.

---

## 7. Lo scenario canonico

Il caso di prova che il modello deve reggere, e che vale la pena tenere come
banco:

```
[script]  legge una variabile di lane → la elabora
          → emette il risultato IN UN CAMPO          (R6: deve emettere)
    │
    │ l'arco porta il campo, e — gratis — l'ordine    (R7: la barriera)
    ▼
[source_db]  drena l'input fino alla chiusura         (R8: barriera…)
             prende la (sola) riga di parametri       (R8: …+ parametri, card. 1)
             arricchisce la query con il parametro
             e il suo valore calcolato
```

**Il controllo viaggia sull'arco, i dati viaggiano nel campo.** Nessuno stato
invisibile: tutto ciò che influenza il `source_db` è visibile sul canvas e
verificabile in design.

Cosa deve poter dire lo studio **prima di eseguire**: che il campo citato
dalla query esiste nello schema in arrivo. Lo script dichiara già il proprio
schema d'uscita (prop `outputFields`), quindi il controllo è possibile.

**Il binding dei parametri va fatto tipizzato** (`.bind()` di sqlx), **mai per
interpolazione di stringa**: l'interpolazione apre la SQL injection sul valore
calcolato dallo script e viola "Decimal mai via f64" — un decimale che passa
per stringa e torna numero ha già perso. La sintassi con cui la query cita il
campo in arrivo è **da decidere** (§10).

---

## 8. I 43 tipi — cosa dichiara ognuno

Estratta da `nodeSemantics.ts` interrogando il modulo. *Rigenerata il 17 luglio,
a fase porte chiusa: ora la tabella descrive il codice, non il debito.*

`din. in` / `din. out` = le porte le calcola il resolver dalla config
(`acceptsDynamicInputs` / `producesMultipleOutputs`). `·1 riga` = `maxRows: 1`,
la R8. `logica` = `connectable: false`, la R9.

| tipo | ingressi | uscite | din. in | din. out |
|---|---|---|:-:|:-:|
| `aggregate` | `input` | `output` | · | · |
| `bridge_in` | — | `output` | · | · |
| `bridge_out` | `input` | — | · | · |
| `data_quality` | `input` | `output` | · | · |
| `dir_watcher` | `input` ·1 riga | `output`<br>`reject` reject | · | · |
| `error_handler` | `catch` catch **logica** | `error_out` | · | · |
| `explode` | `input` | `output`<br>`reject` reject | · | · |
| `filter` | `input` | — | · | **sì** |
| `join` | `input_left`<br>`input_right` | `output`<br>`reject` reject | · | · |
| `json_parser` | `input` | — | · | **sì** |
| `json_serializer` | `input` | `output` | **sì** | · |
| `lane_end` | `input` | — | · | · |
| `lane_start` | — | `output` signal | · | · |
| `log` | `input` | `output` | · | · |
| `mail_sink` | `input` | `output`<br>`reject` reject | · | · |
| `materialize` | `input` | `output`<br>`reject` reject | · | · |
| `pivot` | `input` | `output` | · | · |
| `report_generator` | `input` | `output`<br>`reject` reject | · | · |
| `script` | `input` | `output` *when outputMode≠signal/none*<br>`output` signal *when outputMode=signal*<br>`reject` reject *when hasReject=true* | · | · |
| `shell_exec` | `input` | `output` | · | · |
| `sink_activemq` | `input` | `output` | · | · |
| `sink_db` | `input` | `output`<br>`reject` reject | · | · |
| `sink_file` | `input` | `output`<br>`reject` reject | · | · |
| `sink_ftp` | `input` | `output`<br>`reject` reject | · | · |
| `sink_kafka` | `input` | `output`<br>`reject` reject | · | · |
| `sink_mqtt` | `input` | `output` | · | · |
| `source_activemq` | `input` ·1 riga | `output`<br>`reject` reject | · | · |
| `source_db` | `input` ·1 riga | `output` | · | · |
| `source_file` | `input` ·1 riga | `output` | · | · |
| `source_ftp` | `input` ·1 riga | `output` | · | · |
| `source_http` | `input` ·1 riga | `output`<br>`reject` reject | · | · |
| `source_kafka` | `input` ·1 riga | `output` | · | · |
| `source_mqtt` | `input` ·1 riga | `output` | · | · |
| `ssh_exec` | `input` | `output` | · | · |
| `tmap` | `input_main` | — | **sì** | **sì** |
| `transform` | `input` | `output` | · | · |
| `union` | `input_main` | `output` | **sì** | · |
| `watchdog` | `input` ·1 riga | `output` | · | · |
| `webhook_receiver` | `input` ·1 riga | `output` | · | · |
| `webhook_responder` | `input` | — | · | · |
| `window` | `input` | `output` | · | · |
| `xml_parser` | `input` | — | · | **sì** |
| `xml_serializer` | `input` | `output` | **sì** | · |

Lo `script` è l'esempio vivo di R4: **due porte con lo stesso `id`**, `when`
mutuamente esclusivi, ruoli diversi.

## 9. Dove il codice diverge dal modello

**La fase porte è chiusa.** Delle 13 divergenze della prima stesura ne restano
aperte 5, e sono tutte **motore** o **fase porting** — nessuna è nello studio.
Questa resta la lista del debito, non un elenco di idee.

### Chiuse

| | cos'era | chi l'ha chiusa |
|---|---|---|
| 9.1 | gli ingressi non erano derivati da nessuno: `FlowNode` disegnava `<Handle id="input">` cablato | **P20a** (FlowNode) + **P20b** (join/union/tmap) |
| 9.2 | `union` dichiarava `input_1`/`input_2`, mai esistiti | **P19b** — statica `input_main` + dinamiche; tolto il ramo morto in `schemaUtils` |
| 9.3 | i serializer derivavano le porte **dagli archi** | **P25** — `config.serializerInputs`, scritto dal resolver e ripulito alla cancellazione |
| 9.4 | mancava il vocabolario per gli ingressi dinamici | **P19b** — `acceptsDynamicInputs`, `maxEdges`, `maxRows`, `connectable` |
| 9.5 | la quinta copia: `NO_OUTPUT` vuoto, `NO_INPUT` senza `bridge_in`, `JOIN_HANDLES` a mano | **P21** — tutto derivato; + `EDGE_TO_UNDECLARED_PORT` |
| 9.6 | `role` dichiarato su un quinto delle porte, e `isReject` diceva la stessa cosa due volte | **P19a** — `role` obbligatorio, `isReject` derivato con `isRejectPort()` |
| 9.8 | «`bridge_in` disegna un handle nascosto» | **era falso** — v. sotto |

**9.8 non era vero, ed è la correzione più istruttiva di tutta la fase.**
L'handle `opacity: 0` di `bridge_in` sta in `BridgeNode.tsx`, che **non viene
mai renderizzato**: `bridgeInNode`, `bridgeOutNode`, `webhookReceiverNode`,
`webhookResponderNode` e `watchdogNode` sono registrati in `nodeTypes`
(`LaneCanvas`) ma il `rfType` di `flowStore` **non li assegna mai** — quei nodi
passano tutti da `FlowNode`. `WebhookNode.tsx` ha perfino il commento con la
mappa che *sarebbe andata aggiunta*. Il vero handle di `bridge_in` lo disegnava
`FlowNode` cablato, e P20a l'ha tolto per la strada giusta.
→ **Da verificare**: un JSON salvato da una versione vecchia potrebbe portarsi
dietro quei `rfType`, e allora i componenti morti tornano vivi.

### Aperte — tutte fuori dallo studio

**9.7 — I reject sono asimmetrici** (*decisione*). `sink_mqtt` e `sink_activemq`
non hanno `reject` mentre `sink_db`/`file`/`ftp`/`kafka` sì; `source_http`,
`source_activemq` e `dir_watcher` ne hanno uno che gli altri source non hanno.
Da decidere una per una, non a colpi di regex.

**9.9 — I source non consumano il loro ingresso** (*motore*).
```rust
"source_db" => { let tx = take_primary_output(&mut outputs);
                 super::nodes::source_db::run(ctx, tx).await }
```
La mappa `inputs` non è **mai** toccata: l'ingresso dato ai source da P18 è
dichiarato e non consumato, quindi **R8 non è implementata**. Il receiver
droppato chiude il canale e le `let _ = tx.send(row).await` a monte falliscono
**in silenzio** — righe che spariscono.

**9.10 — Nessun binding di parametri** (*motore*). `source_db.rs` fa
`sqlx::query(query).fetch(pool)`: stringa verbatim, nessun `.bind()`. R8 non ha
con cosa configurarsi.

**9.11 — I reject dichiarati non sono implementati** (*motore*) per
explode/join/materialize/sink_*. Solo `filter` e i parser ricevono l'intera
mappa `outputs` e gestiscono le porte per nome. Modello da copiare: quelli.

**9.12 — `outputMode` è implementato solo da `sink_file`** (*fase porting*).
Tutti e 7 i sink dichiarano `output` **senza `when`**: il pallino verde esiste
sempre, anche quando il motore non ci manda niente. Ma il campo che governa
l'uscita è diverso per ciascuno — `sink_db` va a `passthroughMasterDetail`
(default `false`), `sink_file` a `outputMode`, e gli altri 5 non hanno **niente**
nel motore. Mettere un `when` dove il motore non legge nulla sarebbe un'altra
bugia: prima il porting, poi il `when`. `SIGNAL_SCHEMA` è **duplicato**
(`sink_file.rs` e `sink_file/Panel.tsx:80`): fonte unica da fare.

**9.13 — Lo `script` è uno stub** (*fase porting*). Inoltra le righe tal quali e
finge di funzionare; in `Cargo.toml` non c'è **nessun motore JS**. R6 gli chiede
di emettere i risultati: non può. È programmato.

### Il muro che è emerso due volte

`validateDAG(plan)` e `propagateSchema(plan)` ricevono **solo il piano, non le
lane**. Ma i nomi dei dataset materializzati vivono **solo** in `lane.variables`
(tipo `materialize`, `value` = nodeId di chi pubblica); il nodo materialize non
si tiene nemmeno il proprio nome. Perciò l'IR non può risolvere
`materializeName`, e si passa da `props.outputSchema` persistito dal pannello —
che le lane le vede.

Funziona, ma dipende dal fatto che **qualcuno abbia aperto il pannello**. E
lascia una domanda senza risposta: *«questo window legge `ds_film` — chi lo
pubblica?»*. Passare le lane a `validateDAG`/`propagateSchema` è un cambio di
firma su tutti i chiamanti, ed è **il pezzo che manca al pre-compilatore**.

### Una cosa che non c'è

**FlowPilot non ha persistenza.** Nessun `localStorage`, nessun dialogo file, e
tra i 45 comandi Tauri non c'è né `save_project` né `load_project`. Un flusso
vive solo nella sessione. Va scritto qui perché ha smentito un rischio che
questo stesso documento dichiarava — la "migrazione dei progetti salvati" del
vecchio §9.3, che ha pesato su una decisione senza esistere.

---

## 10. Decisioni

**Prese** (utente, 16 luglio):
- R5 — niente segnale sostitutivo in assenza di dati. *Ritirata dopo averla
  proposta: il comportamento resta il più semplice.*
- R6 — variabili di lane immutabili; i nodi che elaborano emettono i risultati.
- R8 — barriera + parametri, cardinalità **una riga** (scartata "N righe = N
  esecuzioni").
- R9 — `catch` dell'error_handler: porta logica, raccolta implicita.
- 9.6 — `role` obbligatorio, `isReject` derivato. *Era una proposta di Claude:
  approvata e fatta con P19a.*
- 9.3 — serializer normalizzato al pattern union. *La migrazione, che era il
  perno della scelta, non esisteva.*
- Ordine di porting: **error_handler → script → report_generator**.

**Aperte**:
- La **sintassi** con cui una query cita un campo in arrivo (`:param` di sqlx?
  `${campo}` FPEL compilato a binding?). Tocca `node-spec.md` §3, che oggi dice
  "SQL custom eseguito verbatim". Il binding va **tipizzato**, mai per
  interpolazione di stringa: SQL injection, e "Decimal mai via f64".
- 9.7 — i reject asimmetrici tra i sink e tra i source: uno per uno.
- Il `when` sui sink (9.12): **dopo** il porting, non prima.
- Le lane a `validateDAG`/`propagateSchema`.
- **Se la dipendenza `window ← materialize` debba vedersi sul canvas.** Oggi è
  invisibile: guardando il flusso non si vede che quel window dipende da quel
  materialize. È in tensione con la R6 — *tutto ciò che influenza un nodo è
  visibile sul canvas*. Le strade: (A) resta invisibile ma dichiarata e
  validata; (B) un arco **logico** tratteggiato, derivato dalla config e non
  cablato a mano — parente stretto della porta logica della R9.

**Rimandate**:
- La sezione "Uscita verso valle" del pannello script: **da ridiscutere e
  spostare**, al restyling. Con lei il nome "innesco" (§6).
- Revisione generale delle regole.