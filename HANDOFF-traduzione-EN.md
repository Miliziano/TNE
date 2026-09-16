# FlowPilot — passata di traduzione in inglese (handoff per continuare)

Repo: github.com/Miliziano/TNE — tool ETL visuale React/Tauri + motore Rust.
PRIMA DI TUTTO: clona il repo, controlla `git log --oneline -8 origin/main` per
vedere l'ultima patch pushata, leggi `HANDOFF.md` (NON aggiornato: è fermo alla
fase motore/porting, non copre questa passata inglese — questo file la copre).

## Cos'è il lavoro
Tradurre in inglese TUTTE le stringhe UI/utente hardcoded, sia nel frontend
(`src/`) sia nel motore Rust (`src-tauri/src/`). Mantengo il dizionario-seed
`src/i18n/it-en.json` in modo ADDITIVO (riscritto con `sort_keys`, indent 2,
`ensure_ascii=false`, newline finale; diff di sole-aggiunte). Il dizionario è
SOLO per il frontend (le stringhe Rust NON vanno nel dizionario).

## Stato attuale (fatto)
Frontend COMPLETO: nodi (panel), tutti i 7 Modal (tmap, json/xml serializer,
json/xml parser, filter, bridge), FieldTransformEditor + FunctionPicker,
catalogo FPEL `src/ir/functions.ts`, script Panel + templates.ts (metadati +
codice-esempio), log (viewer + messaggi `addLog` in Toolbar/flowStore),
PropertyPanel, MonitorPanel (+ grafici responsive/griglia/timeline), canvas
(LaneCanvas)/BottomDock/ProblemsPanel/menu Toolbar, errori di compilazione in
`buildRustPlan` (Toolbar.tsx). Dizionario ~2357 voci.
Motore Rust COMPLETO: `lib.rs`, orchestrazione (executor/mod/spec/bridge/pool/
txregistry), TUTTI i nodi `engine/nodes/*.rs`, layer DB (`db_transactions.rs`,
`db_stream.rs`), `engine/datasets.rs`, e il binario monitor
`bin/flowpilot_monitor.rs`.
Patch consegnate: P261→P310. La prossima patch è **P311**.
Extra fatti fuori lista: rimozione tasto "open node editor" in error_handler
(P284), fix robustezza `buildRustPlan` case tmap che ora blocca il run con
errore chiaro invece di ingoiarlo (P300), grafici Monitor responsive+griglia
(P298), asse Timeline sulla finestra nodi (P299).

### ⚠️ Attenzione: P303 (orchestrazione) è stata REVERTATA
Nella history c'è `P303-en-engine-orchestration` **applicata e poi**
`Revert "P303…"`, e **P304 non esiste**. Il motivo quasi certo del revert è nel
diff di P303: in `executor.rs` una resa era `"preview not supported for node
"{}""` → **virgolette nude dentro una stringa Rust** = compilazione rotta.
NON serve però rifare P303 in blocco: le stringhe dell'orchestrazione
risultano comunque in inglese perché **P305 ha ri-toccato `executor.rs` dopo
il revert**. Lezione: sul motore fai SEMPRE il check "virgolette bilanciate"
prima di consegnare (vedi convenzioni Rust) — è esattamente ciò che ha fatto
saltare P303.

### P310 — residui motore (consegnata)
Sweep finale del motore: l'affermazione "in teoria 0 residui" NON reggeva.
Trovate e tradotte 41 sostituzioni su 22 file (solo-contenuto), tra cui:
`datasets.rs` (dataset non dichiarato), `error_handler.rs` (regola «interrompi»
+ "interrotti N nodi ancora in esecuzione" — guillemet → apici dritti),
`report_generator.rs` ("{} per {}" titolo grafico, "Valori unici"),
`sink_db/activemq/mqtt/ftp/kafka`, `source_db/ftp`, `ssh_exec`, `stop`, `union`,
`txregistry`, `watchdog` (6 log su panel, incluso "ogni {}s"),
`webhook_receiver/responder`, `dir_watcher`, `shell_exec`, `watch_subs`,
`mod.rs` (ping + label "anteprima"→"preview"), `lib.rs` (GitHub connesso,
Shell timeout).

## Cosa resta
Sul motore la passata statica è ora PULITA da stringhe user-facing italiane
(ri-verificato con lo sweep). Il residuo prevedibile:
1. MEZZI-TRADOTTI di vecchie patch o stringhe generate a runtime, che l'utente
   stana testando l'app (`npm run tauri dev`) e segnala → tradurre il punto
   preciso.
2. Aree UI mai toccate che l'utente segnala → trattarle come nodo/gruppo nuovo.

### DA NON tradurre (verificato — lasciare così, non sono residui)
- Valori-dato del parser booleano: `"si"|"sì"|"no"|"yes"|…` in json/xml_parser,
  json/xml_serializer, source_file. Sono confronti/serializzazione, non UI.
- Contratti: `"chiave"`/`"valore"` in `pivot.rs` (unpivotKey/ValueField),
  `"flusso"` in `script.rs` (sourceMode).
- Messaggi dentro `.expect(...)` (panic da sviluppatore): `monitor.rs:151`,
  `reporter.rs:130` → restano IT come da regola "debug resta IT".
- Falsi positivi INGLESI degli scanner: `bridge.rs:218` ("incomplete"),
  `join.rs:76/290` ("duplicates"). Già inglesi.
- `lib.rs` righe ~529/669/691/697/708: sono rumore dello scanner (char-literal
  `'"'` che spezza lo stato + doc-comment `///`), NON stringhe reali.

## METODO E CONVENZIONI (rispettare alla lettera)

### Comune
- Traduci un file/gruppo per consegna. Usa uno script Python che fa
  `str.replace` con VERIFICA DEL CONTEGGIO per ogni match (aborta se il numero
  di occorrenze ≠ quello atteso → niente sostituzioni silenziose sbagliate).
- Per evitare shadowing di sottostringhe, ordina le regole per lunghezza
  DECRESCENTE del testo cercato (es. `sink_db {}: transazioni…` PRIMA di
  `transazioni…` da solo, sennò la prima regola non trova più il match).
- Lascia i COMMENTI in italiano (anche `{/* … */}` JSX multi-riga e `//`/`/* */`
  Rust). La scansione dei residui dev'essere comment-aware.
- Consegna come patch numerata `Pxxx` + i file interi, verificando
  `git apply --check` su un albero PULITO (fai `git stash`, check, `stash pop`).
  L'utente NON pusha automaticamente: applica lui, compila, committa, pusha.
- Se il remoto non ha ancora l'ultima patch (l'utente sta ancora applicando),
  CONCATENA: committa la patch precedente in locale come base
  (`git commit`), poi taglia la successiva sopra, così le patch si applicano in
  sequenza senza conflitti sul dizionario/file condivisi. Segnala sempre
  l'ordine ("applica Pxxx → Pxxy"). (Per P310 il remoto era già a P309, albero
  pulito → applica diretta, niente concatenazione.)
- Presenta la patch col percorso REALE `/home/claude/Pxxx-....patch` a
  `present_files` (non un percorso in outputs inesistente, altrimenti il link è
  vuoto).
- Baseline TypeScript attesa: `tsc` a 110. Nessuna modifica Rust nelle patch
  frontend (e viceversa: P310 è una patch motore, nessuna modifica frontend).

### Frontend (TS/React)
- NON tradurre: i VALORI delle `<option>` che il motore consuma, né i default
  dei prop che diventano nomi-campo/contratti a runtime
  (es. `sourceMode:'flusso'/'genera'`, `unpivotKeyField:'chiave'`,
  `unpivotValueField:'valore'`). Traduci solo le label/desc/testo visibili.
- Anglicizza esempi/placeholder illustrativi con identificatori SICURI: evita
  parole riservate SQL come `table`/`row` → usa `my_table`, `rec`; `campo`→
  `field`, `nome`→`name`, ecc. Nell'interpolazione `${campo}`→`${field}`.
- I default GENERATI (con counter/random) tipo `campo_${n}`, `trasf_${...}`,
  `flusso_${idx}` NON sono contratti fissi → li anglicizzo (`field_`, `transf_`,
  `flow_`) per coerenza UI (verificato che nessun codegen li matcha come
  prefisso). I VALORI fissi che il motore confronta invece restano.
- Verifica ogni file con `esbuild` (`node_modules/.bin/esbuild file.tsx
  --outfile=/dev/null`; installa esbuild con `npm i esbuild --no-save`).
- Attenzione a: stringhe duplicate (count giusto), stringhe spezzate su più
  righe, apostrofi tipografici `'` vs ASCII, e ai GUILLEMET `«…»` nel testo
  inglese → convertili in virgolette dritte `"…"` (o apici singoli `'…'`).
- Dopo l'apply, RE-SCAN comment-aware con denylist AMPIA e case-insensitive
  (attenzione alle forme flesse: `connessione`/`fallita` — usa match a
  sottostringa, non confini di parola rigidi, o li perdi). Itera fino a 0
  residui reali (i falsi positivi sono parole inglesi tipo file/format/broker).
- Il dizionario può avere CONFLITTI su parole ambigue (es. `Ora`→Hour vs Time,
  `Stato`→State vs Status): NON sovrascrivere la voce esistente; metti la resa
  giusta nel `.tsx` e lascia il seed com'è.

### Motore Rust (src-tauri)
- Modifica SOLO il contenuto dentro `"…"`, preservando i placeholder `{}` /
  `{0}` / `{id}` (conta i `{}`: dev'essere invariato). Un edit di solo-contenuto
  non rompe la compilazione.
- MAI mettere `"` nude dentro una stringa Rust `"…"` (rompe la sintassi): usa
  apici singoli `'…'` o `\"`. Le raw string `r#"…"#` reggono `"` interne ma non
  toccare i delimitatori. Fai un controllo "virgolette bilanciate" prima di
  consegnare — è la rete che manca a chi ha rotto P303. Nel `.replace`, invariante
  utile: `repl.count('"') == search.count('"')` (l'edit non aggiunge/toglie `"`).
  Io non posso lanciare `cargo` (mancano le dipendenze) → l'utente compila con
  `npm run tauri dev`; string-only + quote-check sono la rete.
- NON tradurre: statement SQL (`COMMIT PREPARED '{}'`, `DELETE FROM …`,
  frammenti in `push_str`/`sqlx::query`), i messaggi `eprintln!`/`println!`/
  `dbg!`/`log::*` e i messaggi dentro `.expect(...)`/`panic!` (debug, restano
  IT), e i VALORI-DATO che il motore confronta: il parser booleano accetta
  `"si"|"sì"|"no"|"yes"|...`, `sourceMode` usa `"flusso"/"genera"`,
  `log_level="diagnostico"` arriva dal runner. Questi restano.
- REGOLA CHIAVE emersa in P310: `ctx.emit_log(…, "panel")` manda la stringa al
  VIEWER dei log nell'app → è UI, VA TRADOTTA. `eprintln!`/`.expect()` invece
  no. Distinguere sempre dove finisce la stringa, non solo la macro.
- ATTENZIONE agli stati DISPLAYATI: es. in flowpilot_monitor `esito` è
  `'in corso'/'completato'/'fallito'` ed è sia confrontato che MOSTRATO → va
  tradotto coerentemente ovunque (set + confronto).
- Gli IDENTIFICATORI di codice italiani (variabili/funzioni JS o Rust:
  `filtro`, `righe`, `dedotto`, `campiona`, `mostraDettaglio`…) RESTANO. Traduci
  solo il testo mostrato.
- Scanner necessario (lezioni P310, tutte indispensabili o perdi stringhe):
  1. MULTI-RIGA aware: le stringhe Rust con continuazione `\` a fine riga
     sfuggono a uno scanner mono-riga.
  2. eprintln/expect-aware: traccia le macro debug ANCHE multi-riga per
     escluderle — guarda ~5 righe indietro dalla stringa, non 2 (in
     `runner.rs` la macro `eprintln!` era 3 righe sopra il letterale).
  3. no-SQL/push_str.
  4. char-literal aware: un `'"'` (o `'\''`) manda in confusione il tokenizzatore
     di stringhe e fa "mangiare" codice/commenti come se fossero stringa (è
     successo in `lib.rs`) → gestisci i letterali di carattere.
  5. denylist per FORME FLESSE e AVVERBI: parole come `interrotti`, `nodi`,
     `esecuzione`, e avverbi `dopo`/`ogni`/`prima`/`ancora` non hanno una radice
     comoda → o li elenchi, o usi anche segnali ortografici (`-zione`, accenti,
     `«»`) + funzionali (` su `, ` di `, ` del `, ` che `, ` nella `). Un solo
     denylist "di parole piene" li perde (a me sono sfuggiti al primo giro).

## Come lavora l'utente
Guida con messaggi brevi ("via", "prosegui", "ok"). Applica le patch, compila,
e segnala i residui che vede a runtime (spesso mezzi-tradotti da patch vecchie o
errori del motore). Rispondere in italiano.
