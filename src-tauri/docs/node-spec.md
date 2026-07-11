# FlowPilot — Node Spec (contratto di configurazione dei nodi)

**Versione spec: 1** · Stato: bozza iniziale (source_db, sink_db)

Questo documento è il gemello di `docs/monitoring-schema.md` sul lato
*input*: come quello norma gli eventi che gli esecutori emettono, questo
norma la configurazione che gli esecutori ricevono. È neutro rispetto al
linguaggio: i consumatori previsti sono il motore live Rust
(`src-tauri/src/engine/`) e i futuri generatori di codice (Rust, Java,
Python) per artifact headless.

---

## 1. Principi

1. **Spec completa.** Lo studio fotografa *per intero* i tab
   Configurazione + Avanzate di ogni nodo e li spedisce nel plan.
   Lo studio può **compilare** (trasformare una rappresentazione, es.
   TMapConfig → TMapPlan) ma mai **selezionare** (scegliere quali campi
   passare). La scelta di quali campi usare spetta all'esecutore.
2. **La chiave del pannello è il contratto.** Le props viaggiano
   verbatim, con le chiavi camelCase scritte dai pannelli
   (`updateNodeProp`). Nessun layer di rinomina TS→snake_case: è lì che
   nascevano i drop silenziosi (`querySchema`→`schema`,
   `hasHeader`→`has_header`).
3. **Valori stringa, parse lassista.** Le props sono stringhe così come
   il pannello le salva (`"true"`, `"1000"`). L'esecutore le converte
   con accessor tipizzati tolleranti (`bool_or`, `usize_or`,
   `json_or`…). Lo studio NON normalizza i tipi.
4. **Default normati qui, non impliciti nel codice.** Ogni campo ha un
   default dichiarato in questo documento; tutti gli esecutori (live e
   codegen) devono applicare *lo stesso* default. Un campo *required*
   mancante produce un errore parlante, mai un fallback silenzioso.
5. **Campi non consumati = telemetria, non silenzio.** L'esecutore live
   traccia le chiavi lette e a fine nodo logga in debug le props
   ricevute ma mai consultate (rende visibili i drop nel Monitor).
6. **L'SQL personalizzato viaggia verbatim.** Nelle modalità custom
   l'esecutore *esegue* l'SQL dell'utente (con bind dei valori), non lo
   re-inventa. La Preview dello studio mostra il contratto, non una
   simulazione.

---

## 2. La busta (envelope)

Ogni nodo del plan porta, accanto ai campi storici, l'oggetto `spec`:

```jsonc
{
  "node_id":   "n_12",
  "node_type": "sink_db",
  "label":     "Scrivi anagrafica",

  "config": { /* LEGACY: selezione per-tipo di buildRustPlan.
                 Rimosso a fine migrazione. */ },

  "spec": {
    "version": 1,

    // node.data.props VERBATIM: tutte le chiavi dei pannelli
    // (tab Configurazione + Avanzate), valori stringa.
    "props": { "table": "anagrafica", "batchSize": "1000", "...": "..." },

    // node.data.config VERBATIM: le strutture del nodo
    // (mapping, filter, alberi serializer, resourceId, displayName…).
    // Per i nodi con compilazione genuina (tmap) conterrà anche il
    // piano compilato sotto chiave dedicata (definito alla migrazione
    // del nodo).
    "config": { "resourceId": "res_pg_1", "...": "..." },

    // Risorsa di lane risolta dallo studio (l'esecutore non conosce
    // il pool). null se il nodo non referenzia risorse.
    "resource": {
      "dialect": "postgresql", "host": "…", "port": "5432",
      "database": "…", "user": "…", "password": "…", "ssl": "false",
      "connectTimeout": "…"
    },

    // Id della risorsa, per gli eventi Connection* (chiave = risorsa,
    // non nodo — v. monitoring-schema).
    "resourceId": "res_pg_1"
  }
}
```

Regole di evoluzione: campi nuovi si aggiungono senza rompere (i parser
ignorano le chiavi sconosciute); rimozioni o cambi di semantica
incrementano `version`.

### Legenda dello stato di implementazione

Per ogni campo, la colonna **Live** indica se il motore Rust attuale lo
esegue: ✅ eseguito · 🔩 struct pronta ma non ancora alimentata/cablata ·
🕐 solo spec (esecutore da fare). Il contratto descrive il *target*; lo
stato è una fotografia che si aggiorna a ogni migrazione. Molti campi
sono 🕐 by design: l'approccio del progetto è per fasi di affinamento
successive, e la spec li norma *prima* che vengano implementati.

---

## 3. `source_db` — sorgente database

Risorsa: **required** (`spec.resource` ≠ null, da `config.resourceId`).

### Props (tab Configurazione + Query)

| Chiave         | Tipo    | Default        | Semantica                                                          | Live |
|----------------|---------|----------------|--------------------------------------------------------------------|------|
| `dialect`      | string  | `"postgresql"` | Dialetto SQL (informativo: fa fede `resource.dialect`)             | ✅   |
| `querySchema`  | string  | `"public"`     | Schema della tabella                                               | 🕐 (oggi il builder legge la chiave errata `schema` → sempre `public`) |
| `table`        | string  | — *(required se `query` vuota)* | Tabella sorgente                                  | ✅   |
| `query`        | string  | `""`           | SQL custom **verbatim**. Se non vuota vince su tabella/limit/orderBy/offset | ✅ |
| `limit`        | int     | `0`            | `0` = nessun limite                                                | ✅   |
| `offset`       | int     | `0`            | Offset righe (query generata)                                      | 🕐   |
| `orderBy`      | string  | `""`           | Clausola ORDER BY (senza la parola chiave)                         | 🕐   |
| `fetchSize`    | int     | `1000`         | Righe per fetch dal cursore                                        | 🕐   |
| `queryTimeout` | int (s) | `30`           | Timeout della query                                                | 🕐   |

**Costruzione della query (a carico dell'esecutore, non dello studio):**
se `query` non vuota → eseguirla verbatim. Altrimenti
`SELECT * FROM [querySchema.]table [ORDER BY orderBy] [LIMIT limit] [OFFSET offset]`
(clausole presenti solo se il campo è valorizzato/≠0). La Preview dello
studio deve mostrare esattamente questa forma.

### Resource

| Chiave           | Tipo   | Default       | Live |
|------------------|--------|---------------|------|
| `dialect`        | string | `postgresql`  | ✅   |
| `host`           | string | `localhost`   | ✅   |
| `port`           | int    | per dialetto  | ✅   |
| `database`       | string | — (required)  | ✅   |
| `user`/`username`| string | `""`          | ✅   |
| `password`       | string | `""`          | ✅   |
| `ssl`            | string | `"false"`     | ✅   |
| `connectTimeout` | int (s)| `30`          | 🔩   |

### Conversione tipi DB → Value (motore ed esecutori)

Regole con cui gli esecutori convertono i tipi nativi del database nel
tipo `Value` interno. Neutre rispetto al linguaggio: il codegen deve
riprodurre la stessa mappatura sul tipo equivalente del target.

| Tipo sorgente (PostgreSQL)              | Value interno       | Note / rationale                                                        |
|-----------------------------------------|---------------------|-------------------------------------------------------------------------|
| `int2` `int4` `int8` `serial`           | `Int` (i64)         | Interi nativi                                                           |
| `float4` `float8`                       | `Float` (f64)       | Binari a virgola mobile                                                 |
| `numeric` `decimal`                     | `Decimal` (esatto)  | **Mai via f64.** Precisione preservata. Regge Oracle `NUMBER`, Informix `DECIMAL` |
| `bool`                                  | `Bool`              |                                                                        |
| `json` `jsonb`                          | `Object`            | Valore JSON annidato                                                    |
| `timestamp*`                            | `DateTime` (ISO)    | Stringa ISO 8601 a livello di trasporto                                 |
| `date`                                  | `Date` (ISO)        |                                                                        |
| `text` `varchar` `bpchar` ...           | `String`            |                                                                        |
| `text[]` `int4[]` `numeric[]` `bool[]`  | array JSON          | sqlx nomina il tipo `"…[]"` (non `_…`). Elementi NULL supportati        |
| `tsvector`                              | `Null`              | Indice full-text: rappresentazione binaria interna, non testo utile. Per averlo leggibile, castare `col::text` nella query |
| tipi sconosciuti (enum, domini)         | `String` o `Null`   | Fallback UTF-8; scartato se contiene byte NUL (binario mal interpretato)|

**Mappatura per il codegen.** `Decimal` → `BigDecimal` (Java),
`decimal.Decimal` (Python), `rust_decimal::Decimal` (Rust). Non
degradare mai a `double`/`float`: vanificherebbe la precisione esatta,
che è il motivo per cui la sorgente usa NUMERIC.

---

## 4. `sink_db` — scrittura database

Risorsa: **required**.

### Props — scrittura (tab Configurazione)

| Chiave                    | Tipo   | Default    | Semantica                                                    | Live |
|---------------------------|--------|------------|--------------------------------------------------------------|------|
| `table`                   | string | — required | Tabella destinazione                                          | ✅   |
| `querySchema`             | string | `"public"` | Schema                                                        | 🕐   |
| `mode`                    | enum   | `"insert"` | `insert` \| `upsert` \| `update` \| `delete` \| `truncate_insert` \| `merge` | ✅ insert · 🕐 altri |
| `mergeCondition`          | string | `""`       | Condizione ON del MERGE (es. `target.id = source.id`)         | 🕐   |
| `passthroughMasterDetail` | bool   | `false`    | Emette le righe scritte con chiave generata (solo insert/upsert) | 🕐 |
| `onConstraintError`       | enum   | `"stop"`   | `stop` \| `skip` \| `reject` — violazioni di vincolo          | ✅   |
| `deadLetterTable`         | string | `""`       | Tabella per righe rifiutate (con `reject`)                    | 🕐   |

Nota di contratto (§5.6 handoff): con `skip`, un run che scrive 0 righe
su N ricevute deve emettere almeno un warning — il fallimento totale non
può essere indistinguibile dal successo.

### Props — DDL

| Chiave              | Tipo   | Default | Semantica                                    | Live |
|---------------------|--------|---------|-----------------------------------------------|------|
| `createIfNotExists` | bool   | `false` | `CREATE TABLE IF NOT EXISTS` da `sinkColumns` | ✅ (solo PostgreSQL) |
| `dropAndCreate`     | bool   | `false` | `DROP TABLE … CASCADE` + `CREATE`             | ✅ (solo PostgreSQL) |
| `ddlPrimaryKey`     | string | `""`    | PK esplicita per la DDL                       | 🕐   |

Convenzione quoting (bug Fase 11): DDL e DML devono usare la **stessa**
politica di quoting degli identificatori. Oggi: nessun quoting.

### Props — batch e transazioni (tab Avanzate)

| Chiave                | Tipo    | Default | Semantica                              | Live |
|-----------------------|---------|---------|-----------------------------------------|------|
| `batchSize`           | int     | `1000`  | Righe per batch                         | 🔩 (struct pronta; oggi non alimentata → fallback 500 nel motore, **da allineare a 1000**) |
| `commitInterval`      | int     | `0`     | Commit ogni N batch (`0` = a fine run)  | 🕐   |
| `parallelConnections` | int     | `1`     | Connessioni in parallelo (1–20)         | 🕐   |
| `txTimeout`           | int (s) | `60`    | Timeout transazione                     | 🕐   |

### Props — SQL custom (tab Query)

| Chiave            | Tipo   | Default     | Semantica                                            | Live |
|-------------------|--------|-------------|-------------------------------------------------------|------|
| `customQueryMode` | enum   | `"none"`    | `none` \| custom attivo (statement utente)            | 🕐   |
| `customSql`       | string | `""`        | Statement **verbatim** con placeholder; l'esecutore fa il bind | 🕐 |
| `storedProcMode`  | enum   | `"per_row"` | Invocazione stored procedure                          | 🕐   |
| `keyFields`       | string | `"id"`      | Campi chiave (CSV) per update/upsert/delete           | 🔩   |
| `preSql`          | string | `""`        | Statement eseguito prima della scrittura              | 🔩   |
| `postSql`         | string | `""`        | Statement eseguito dopo la scrittura                  | 🔩   |

### `spec.config` — strutture (tab Mapping)

| Chiave                  | Tipo   | Semantica                                                        | Live |
|-------------------------|--------|-------------------------------------------------------------------|------|
| `resourceId`            | string | Risorsa referenziata (risolta dallo studio in `spec.resource`)    | ✅   |
| props `sinkColumns`     | JSON-string → array | Mapping colonne, v. sotto                            | ✅ (mapping insert PG) |
| props `sinkColumnsSnapshot` | JSON-string | Snapshot per il diff del pannello (UI-only)               | —    |
| props `selectedConstraintName` | string | Vincolo scelto per upsert (`ON CONFLICT ON CONSTRAINT`)    | 🕐   |
| props `generatedKeyConfig` | JSON-string | Recupero chiave generata (pass-through master-detail)      | 🕐   |
| props `identityMapVarName` / `identityMapTxGroup` / `identityMapPersist` | string | Identity map per gruppi transazionali | 🕐 |

Elemento di `sinkColumns`:

```jsonc
{
  "dbColumn": "nome_colonna",   // colonna destinazione
  "dbType":   "varchar(100)",   // tipo nativo (usato dalla DDL)
  "nullable": true,
  "isPk":     false,
  "enabled":  true,             // false = colonna esclusa dalla scrittura
  "sourceField": "campo_riga",  // campo della riga in ingresso
  "dbFunction":  "",            // funzione SQL applicata al valore (es. NOW())
  "isKey": false, "keyOperator": "=", "keyLogic": "AND"  // per update/delete
}
```

Semantica di scrittura (Fase 11, confermata): la riga scritta è
`riga[sourceField] → dbColumn` per le sole colonne `enabled`; l'esecutore
non deduce mai le colonne dalle chiavi grezze della riga.

### Resource

Identica a `source_db` (§3).



## 5. Migrazione

1. **Passo 1 (fatto con questa bozza):** busta `spec` additiva in
   `buildRustPlan` per tutti i nodi; `config` legacy invariata.
2. **Passo 2:** `engine/spec.rs` (accessor + tracking chiavi consumate);
   migrazione di `sink_db` e `source_db` alla spec → i campi 🔩 diventano
   ✅, correzione dei bug `querySchema`/`hasHeader`.
3. **Passo 3:** `source_file`/`sink_file`, poi i nodi oggi a config
   vuota (`aggregate`, `transform`, …), uno alla volta con ricollaudo.
4. **Chiusura:** rimozione di `config` legacy e dello switch residuo in
   `buildRustPlan`. Le sezioni di questo documento crescono nodo per
   nodo, come `monitoring-schema.md`.

## 6. `log` — log delle righe

Nodo di attraversamento: logga (tutte o campionate) le righe verso il
LogPanel in-app e/o la finestra viewer, poi le passa invariate.
Nessuna risorsa. Evento emesso: `EngineEvent::NodeLog` (uno per riga
campionata), che porta `lane_id` per le viste per-lane e finisce anche
nel reporter NDJSON del run.

### Props (tab Configurazione)

| Chiave        | Tipo   | Default   | Semantica                                                       | Live |
|---------------|--------|-----------|-----------------------------------------------------------------|------|
| `logEnabled`  | bool   | `true`    | `false` = passthrough puro, nessun log                          | ✅   |
| `logLevel`    | enum   | `"info"`  | `info` \| `ok` \| `warn` \| `error` \| `debug`                  | ✅   |
| `logTemplate` | string | `""`      | Template `{campo}` risolto coi valori di riga. Vuoto = JSON riga | ✅   |
| `logPrefix`   | string | `"[<label>]"` | Prefisso del messaggio                                       | ✅   |
| `sampleMode`  | enum   | `"all"`   | `all` \| `first_n` \| `every_n` \| `random`                     | ✅   |
| `sampleN`     | int    | `10`      | N per `first_n`/`every_n`                                        | ✅   |
| `samplePct`   | int    | `10`      | Percentuale per `random` (0–100)                                | ✅   |
| `showRowNum`  | bool   | `true`    | Antepone `[n]` (numero riga 1-based)                            | ✅   |
| `maxChars`    | int    | `200`     | Troncamento messaggio (`0` = nessun limite)                    | ✅   |
| `logTarget`   | enum   | `"panel"` | `panel` \| `window` \| `both_window` — routing UI              | ✅   |

Nota per il codegen: il default di `logPrefix` dipende dal label del
nodo (`config.displayName` → label statico → `"Log"`); ogni esecutore
deve replicare questa catena.

## 7. `join` — join di due flussi

Unisce due input su chiave (hash join). Due handle SEPARATI:
`input_left` (flusso principale, streaming) e `input_right`
(materializzato in RAM). Nodo **bloccante**: bufferizza il lato destro
(e, per right/full, tiene traccia dei match sull'intero destro) prima
di emettere. In una lane, è un picco di memoria della lane → primo
cliente del futuro monitor memoria per-lane.

### Props (tab Configurazione)

| Chiave            | Tipo   | Default    | Semantica                                                    | Live |
|-------------------|--------|------------|---------------------------------------------------------------|------|
| `join_type`       | enum   | `"inner"`  | `inner` \| `left` \| `right` \| `full` \| `cross` \| `anti` \| `semi` | ✅ |
| `leftKey`         | string | `""`       | Campo chiave del flusso sinistro                              | ✅   |
| `rightKey`        | string | `""`       | Campo chiave del flusso destro                               | ✅   |
| `compositeKeys`   | JSON   | `[]`       | Chiavi multiple: `[{left,right}]` (AND con la chiave primaria)| ✅   |
| `caseSensitive`   | bool   | `true`     | Confronto chiavi case-sensitive                              | ✅   |
| `rightPrefix`     | string | `"r_"`     | Prefisso ai campi destra che collidono coi sinistri          | ✅   |
| `duplicates`      | enum   | `"all"`    | `all` \| `first` \| `last` \| `error` — match multipli a destra | ✅ |
| `nullKeys`        | enum   | `"exclude"`| `exclude` \| `error` — righe con chiave null                 | ✅   |
| `rightSource`     | enum   | `"stream"` | `stream` \| `materialize`                                    | 🕐 (materialize: warning, usa stream) |
| `customCondition` | string | `""`       | Regola di match arbitraria (oltre alla chiave)               | 🕐 **rimandata** (v. §note + docs/TODO.md) |

### Note

- **`customCondition` (🕐).** Il runner JS legacy la eseguiva come
  codice JavaScript arbitrario (`new Function`). In Rust servirebbe un
  interprete di espressioni dedicato: rimandata. Se valorizzata, il
  nodo **emette un warning** e la ignora — nessun match silenziosamente
  sbagliato. Tracciata in `docs/TODO.md`.
- **`rightSource=materialize` (🕐).** Dipende dal nodo `materialize`,
  non ancora migrato alla spec. Per ora il lato destro è sempre lo
  stream `input_right`; se impostato a materialize, warning + fallback.
- **Semantica per tipo** (identica al legacy): `anti` = righe sinistre
  SENZA match (soli campi sx); `semi` = righe sinistre CON match, una
  volta, soli campi sx; `right`/`full` = a fine sinistro emettono le
  righe destre rimaste senza corrispondenza (campi dx prefissati).
  
  **Il prefisso è deciso a livello di SCHEMA, non di singola riga.** Un
  campo del lato destro riceve `rightPrefix` se il suo nome esiste tra i
  nomi di colonna del lato SINISTRO (raccolti durante lo streaming),
  indipendentemente dalla riga corrente. Conseguenza: le righe fuse
  (match) e le righe right-only (right/full senza corrispondenza) hanno
  **lo stesso schema di uscita** per i campi destra. Un campo destra che
  non collide resta col nome nudo in tutte le righe; uno che collide è
  prefissato in tutte.
  - Esempio: film (con `language_id`, `last_update`) RIGHT JOIN language
    (con `language_id`, `name`, `last_update`) → in output i campi
    language collidenti diventano `r_language_id`, `r_last_update`;
    `name` (non presente in film) resta `name`. Vale identico per le
    righe delle lingue senza film.

- **Caso-limite (dichiarato):** se il lato sinistro è completamente
  vuoto (0 righe, possibile in un RIGHT join), lo schema sinistro è
  vuoto → nessuna collisione → le righe right-only escono con i campi
  destra col nome nudo. Semanticamente corretto: senza righe sinistre
  non esiste collisione da disambiguare.

- **Nota implementativa (superato bug legacy):** il runner JS legacy
  decideva il prefisso per-riga (collisione tra la singola riga sx e la
  singola dx), producendo schemi incoerenti tra righe fuse e right-only.
  Il motore Rust decide per-schema: coerenza garantita.

## 8. `explode` — da collettivo a flusso di righe

Da uno a molti: trasforma qualcosa di collettivo in un flusso di righe.
Nessuna risorsa. Nodo di attraversamento (con `flow_field`) o generatore
(con `materialize`).

**Due sorgenti** (`explodeSource`):

- `materialize` — legge un dataset pubblicato nella lane e lo emette
  riga per riga: il buffer del `materialize` torna streaming. L'input,
  se collegato, è solo un **trigger** (consumato e scartato); senza arco
  il nodo si sblocca quando il dataset viene pubblicato. Legge dal
  registro dataset per-lane (v. `docs/design-materialize-registry.md`).
- `flow_field` — per ogni riga in ingresso, esplode un campo collettivo
  (array o oggetto) in più righe.

**Cosa NON fa, per scelta (una responsabilità per nodo):**
- navigare strutture annidate (JSONPath) → mestiere di `json_parser`;
- trasformare i valori (trim, upper…) → mestiere di `transform`;
- leggere variabili di lane → caricale prima in un `materialize`.

Le sorgenti `json_path` (ex tipo struttura) e `lane_var` sono state
**rimosse**: se presenti in uno scenario vecchio, l'esecutore le rifiuta
con un errore parlante invece di ignorarle in silenzio.

### Props (tab Configurazione)

| Chiave           | Tipo   | Default         | Semantica                                                                 | Live |
|------------------|--------|-----------------|---------------------------------------------------------------------------|------|
| `explodeSource`  | enum   | `"materialize"` | `materialize` \| `flow_field`. Altri valori → errore                     | ✅   |
| `materializeName`| string | `""`            | Nome del dataset da leggere (required se `materialize`)                    | ✅   |
| `flowField`      | string | `""`            | Campo collettivo da esplodere (required se `flow_field`)                  | ✅   |
| `structureType`  | enum   | `"array"`       | `array` \| `object_values` \| `object_entries`. `json_path` → errore     | ✅   |
| `includeParent`  | bool   | `false`         | Ripete i campi della riga padre (meno quello esploso) su ogni riga generata | ✅ |
| `onEmpty`        | enum   | `"skip"`        | `skip` \| `null_row` \| `error` — campo null o collezione vuota            | ✅   |
| `onPrimitive`    | enum   | `"wrap"`        | `wrap` \| `skip` \| `error` — il campo non è una collezione                | ✅   |
| `limit`          | int    | `0`             | Massimo righe generate per riga padre (`0` = nessun limite)               | ✅   |

**Semantica dell'esplosione** (invariata dal comportamento verificato):
- `array` → una riga per elemento; se l'elemento è un oggetto i suoi
  campi diventano la riga, se primitivo finisce in un campo `value`.
- `object_values` → una riga per valore dell'oggetto.
- `object_entries` → una riga `{key, value}` per coppia.

Una stringa che *contiene* JSON (es. un campo `["a","b"]` letto da un CSV
come testo) viene parsata come collezione. Se il parse fallisce o il
valore non è una collezione, si applica `onPrimitive`.

Con `flow_field` + `includeParent`, i campi del padre sono propagati
**tranne** quello esploso (sarebbe ridondante e in conflitto con i campi
generati).

### Migrazione (Fase 12)

Primo nodo migrato alla spec dopo la fondazione, insieme ad `aggregate`.
Il `case 'explode'` di `buildRustPlan` — che rinominava le chiavi in
snake_case (`flowField`→`field`, `explodeSource`→`source`, …) — è
**rimosso**: l'esecutore legge le chiavi del pannello verbatim via
`Spec`. Le validazioni che il builder faceva a design-time (rifiuto di
`json_path`/`lane_var`, campi obbligatori) sono ora errori a runtime del
motore.

## 9. `aggregate` — GROUP BY, collassa le righe

Un gruppo, una riga: `SELECT group_by, fn(campo) FROM t GROUP BY group_by`.
Nessuna risorsa. Nodo **bloccante**: materializza (non sa se arriverà
un'altra riga del gruppo finché il flusso non finisce). Distinzione da
`window` (che TIENE le righe e affianca un totale) e dalle finestre
temporali (streaming, modello opposto — non stanno qui).

**Sorgente** (`dataSource`), come `window`/`pivot`:
- `flow` — bufferizza le righe dell'input;
- `materialize` — l'input è un trigger (scartato); le righe vengono da un
  dataset della lane (senza arco, si sblocca alla pubblicazione).

### Props — scalari (tab Configurazione, verbatim via Spec)

| Chiave            | Tipo   | Default     | Semantica                                                    | Live |
|-------------------|--------|-------------|--------------------------------------------------------------|------|
| `dataSource`      | enum   | `"flow"`    | `flow` \| `materialize`                                      | ✅   |
| `materializeName` | string | `""`        | Nome dataset (required se `materialize`)                     | ✅   |
| `group_by`        | string | `""`        | Campi di raggruppamento, CSV (`"region, category"`). Vuoto = un solo gruppo | ✅ |
| `orderBy`         | string | `""`        | Campo di ordinamento dei gruppi in uscita (gratis: materializza comunque) | ✅ |
| `orderDir`        | enum   | `"asc"`     | `asc` \| `desc`                                             | ✅   |
| `limit`           | int    | `0`         | Max gruppi in uscita (`0` = nessun limite)                   | ✅   |
| `nullGroups`      | enum   | `"include"` | `include` \| `exclude` — righe con null nei `group_by`      | ✅   |
| `window`          | enum   | `"none"`    | Se ≠ `none` → **errore** (finestre temporali non supportate qui) | ✅ (rifiuto) |

### `spec.config` — strutture compilate (IR)

Le espressioni FPEL sono **compilate in IR dallo studio** e viaggiano in
`spec.config`, non nelle props (contratto §2 + `docs/expr-ir-schema.md`).
Il motore esegue l'IR, non compila.

| Chiave      | Tipo             | Semantica                                                        | Live |
|-------------|------------------|-----------------------------------------------------------------|------|
| `functions` | array            | Funzioni di aggregazione (v. sotto). **Required**, ≥ 1          | ✅   |
| `having`    | IR (ExprNode)    | Filtro sui valori aggregati (`totale > 1000 and n > 5`)         | ✅   |

Elemento di `functions`:

```jsonc
{
  "field":     "importo",     // campo su cui opera (ignorato da count(*))
  "fn":        "sum",          // sum|avg|count|count_distinct|min|max|
                               // first|last|median|std_dev|variance|
                               // string_agg|array_agg|json_agg
  "alias":     "totale",       // colonna in uscita (default: fn_field)
  "separator": ", ",           // solo string_agg
  "filter":    { …IR… }        // opzionale: FILTER WHERE, IR compilato.
                               // Solo le righe che passano contribuiscono
}
```

Semantica: `count` con `field` vuoto = `count(*)` (conta le righe, non i
valori). `filter` per-funzione è un FILTER WHERE: valutato su ogni riga
del gruppo, solo le passanti contribuiscono a *quell'*aggregazione.
L'ordine di uscita è quello di prima apparizione dei gruppi (deterministico).

### Migrazione (Fase 12)

Migrato alla spec insieme a `explode`. Primo nodo con **compilazione
genuina** portato alla spec: gli scalari vanno nelle props (verbatim), le
strutture compilate (`functions`, `having`) in `spec.config` sotto chiave
dedicata. È il pattern per tutti i nodi FPEL successivi (filter, transform,
tmap). Il `case 'aggregate'` del builder ora scrive l'IR in `specConfig`,
non più nel `config` legacy.

## 10. `pivot` — righe ↔ colonne

Due modalità in un nodo (`pivotMode`):
- **pivot** (righe → colonne): raggruppa per identità; i valori distinti
  di un campo diventano colonne, aggregando un campo valore.
- **unpivot** (colonne → righe): l'inverso; le colonne scelte diventano
  coppie chiave/valore, le altre restano fisse su ogni riga generata.

Nodo **bloccante**: materializza (deve vedere tutte le righe per
raggruppare, e in modalità dinamica per scoprire quali colonne creare).
Nessuna compilazione FPEL → **tutto nelle props**, niente `spec.config`.

**Sorgente** (`dataSource`), come `window`/`aggregate`: `flow` |
`materialize` (l'input diventa trigger scartato; le righe dal dataset di
lane).

### Props (tab Configurazione + Mapping, verbatim via Spec)

| Chiave              | Tipo   | Default            | Semantica                                                        | Live |
|---------------------|--------|--------------------|-----------------------------------------------------------------|------|
| `pivotMode`         | enum   | `"pivot"`          | `pivot` \| `unpivot`                                            | ✅   |
| `dataSource`        | enum   | `"flow"`           | `flow` \| `materialize`                                         | ✅   |
| `materializeName`   | string | `""`               | Nome dataset (se `materialize`)                                 | ✅   |
| **pivot**           |        |                    |                                                                 |      |
| `identityField`     | string | `""`               | Campi identità (GROUP BY), CSV                                  | ✅   |
| `pivotField`        | string | `""`               | I suoi valori distinti diventano colonne. **Required (pivot)**  | ✅   |
| `valueField`        | string | `""`               | Campo aggregato nelle celle. **Required (pivot)**              | ✅   |
| `aggFn`             | enum   | `"sum"`            | Funzione di aggregazione delle celle                           | ✅   |
| `pivotType`         | enum   | `"static"`         | `static` (colonne dichiarate) \| `dynamic` (dai valori a runtime) | ✅ |
| `pivotColumns`      | json   | `[]`               | JSON-string: `[{value, alias}]` — colonne in modo static       | ✅   |
| `pivotSort`         | enum   | `"asc"`            | Ordine colonne dinamiche: `asc` \| `desc` \| `natural`         | ✅   |
| `nullValue`         | string | `""`               | Valore celle senza dati. **Tipizzato dal motore** (vuoto→Null, `42`→Int, `3.14`→Float, `true`/`false`→Bool, altro→String) | ✅ |
| `addRowTotal`       | bool   | `false`            | Aggiunge colonna totale di riga                                | ✅   |
| **unpivot**         |        |                    |                                                                 |      |
| `unpivotColumns`    | json   | `[]`               | JSON-string: `string[]` colonne da ruotare. **Required (unpivot)** | ✅ |
| `unpivotKeyField`   | string | `"chiave"`         | Nome colonna chiave in uscita                                  | ✅   |
| `unpivotValueField` | string | `"valore"`         | Nome colonna valore in uscita                                  | ✅   |
| `unpivotNullMode`   | enum   | `"include"`        | `include` \| `exclude` \| `zero` — celle null                  | ✅   |
| `unpivotOrder`      | enum   | `"identity_first"` | `identity_first` \| `key_first`                                | ✅   |

### Validazione (doppio strato — v. `design-validazione.md`)

- **pivot**: `pivotField` e `valueField` obbligatori.
- **unpivot**: almeno una colonna in `unpivotColumns`.

Errori bloccanti nel builder a design-time **e** errori parlanti nel
motore a runtime. Il builder emette inoltre un **warning non bloccante**
se `nullValue` è testuale in una pivot (potrebbe rompere colonne
numeriche a valle) — predisposto per la validazione live (Fase 13).

### `nullValue`: chi tipizza

Il pannello salva `nullValue` come stringa; **il motore la tipizza**
(non più il builder). Coerente col principio "props verbatim, motore
interpreta": lo studio manda testo, il motore deduce il tipo con parsing
lassista. Vedi TODO ORDER BY multi-campo (condiviso con aggregate/window).

### Migrazione (Fase 12)

Migrato dopo aggregate. Caso "senza FPEL": nessun `spec.config`, tutte le
props verbatim; le liste (`pivotColumns`, `unpivotColumns`) già
JSON-string nel pannello, lette via `json_or`. Il `case 'pivot'` del
builder si riduce alle sole validazioni (non costruisce più `config`).

## 11. `window` — funzioni finestra (analitiche)

Le righe restano (a differenza di aggregate che le collassa): affianca a
ogni riga una o più colonne calcolate su una partizione ordinata —
`row_number`, `rank`, `lag`/`lead`, `moving_avg`, `ntile`, `streak`,
`sessionize`, ecc. `SELECT *, fn() OVER (PARTITION BY … ORDER BY …)`.

Nodo **bloccante**: materializza (serve l'intera partizione ordinata).
**Sorgente** (`dataSource`), come `pivot`/`aggregate`: `flow` |
`materialize`.

Ha compilazione FPEL (la funzione `streak` valuta una condizione): come
aggregate, gli scalari vanno nelle props, le `windows` compilate in
`spec.config`.

### Props — scalari (tab Configurazione, verbatim via Spec)

| Chiave            | Tipo   | Default   | Semantica                                                | Live |
|-------------------|--------|-----------|----------------------------------------------------------|------|
| `dataSource`      | enum   | `"flow"`  | `flow` \| `materialize`                                  | ✅   |
| `materializeName` | string | `""`      | Nome dataset (se `materialize`)                          | ✅   |
| `partitionBy`     | string | `""`      | Campi di partizione (PARTITION BY), CSV                  | ✅   |
| `orderBy`         | string | `""`      | Campo di ordinamento nella partizione                    | ✅   |
| `orderDir`        | enum   | `"asc"`   | `asc` \| `desc`                                         | ✅   |

### `spec.config` — strutture compilate (IR)

| Chiave    | Tipo  | Semantica                                    | Live |
|-----------|-------|----------------------------------------------|------|
| `windows` | array | Funzioni finestra. **Required**, ≥ 1        | ✅   |

Elemento di `windows`:

```jsonc
{
  "fn":           "lag",        // row_number|rank|dense_rank|lag|lead|
                                // moving_avg|moving_sum|ntile|nth_value|
                                // topn_flag|streak|sessionize|…
  "field":        "importo",    // campo sorgente (se la fn opera su un campo)
  "output_field": "prec",       // colonna calcolata (default: win_<fn>)
  "offset":       1,            // lag/lead: righe di spostamento
  "n":            3,            // ntile/nth_value/moving_*: dimensione/posizione;
                                // sessionize: gap massimo in secondi
  "expr":         { …IR… },     // solo streak: condizione FPEL compilata
  "null_default": "0"           // lag/lead: valore se la riga non esiste
}
```

`streak` richiede `expr` (condizione FPEL, compilata in IR dallo studio;
il motore esegue l'IR). `null_default` è un valore grezzo dentro la
struttura `windows`: viaggia in `spec.config` con il resto della sua
struct (non si separa dall'unità che il builder produce).

### Validazione (doppio strato)

- almeno una funzione in `windows`;
- `streak` richiede una condizione (`expr` non vuota) — errore a
  design-time nel builder (con dettaglio del parse FPEL) e ri-validato
  dal motore.

### Migrazione (Fase 12)

Migrato dopo pivot. Caso "misto": FPEL (come aggregate → `windows` in
`spec.config`) + scalari (come pivot → props). Il `case 'window'` del
builder scrive `windows` in `specConfig` e non costruisce più `config`
legacy. Ordinamento: v. TODO ORDER BY multi-campo (condiviso con
aggregate/pivot); window ha `orderDir` esplicito nel pannello.

## 12. `data_quality` — regole di qualità, score, riparazione

Valuta ogni riga contro un insieme di regole raggruppate in quattro
dimensioni (completeness, conformity, consistency, accuracy), calcola uno
score pesato, classifica la riga (valid/warning/invalid secondo le
soglie) e opzionalmente ripara i valori. Aggiunge un campo di esito
(`output_field`, default `_dq`).

Streaming (non bloccante): valuta riga per riga. Ha compilazione FPEL —
le regole `custom` e i repair `expression` sono espressioni compilate
in IR dallo studio.

### Dove vive la config: `spec.config` (blob intero — Approccio A)

A differenza di pivot/window, data_quality **non ha props scalari
verbatim**: il pannello salva tutto in un'unica prop `dqConfig` (un JSON
con rules + pesi + soglie + scalari) che il builder **elabora e compila**.
L'intero DqConfig compilato va quindi in `spec.config` come unità — è
"materiale compilato", non props grezze. Il motore legge tutto da
`spec.config()`.

| Chiave (in spec.config) | Tipo   | Default | Semantica                                          |
|-------------------------|--------|---------|----------------------------------------------------|
| `rules`                 | array  | `[]`    | Regole (v. sotto). Nessuna regola → ogni riga passa con score 1.0 |
| `weights`               | object | 30/30/20/20 | Pesi delle 4 dimensioni (completeness, conformity, consistency, accuracy) |
| `thresholds`            | object | 0.80 / 0.60 | Soglie `valid` / `warning`                     |
| `output_field`          | string | `"_dq"` | Nome del campo di esito aggiunto                    |
| `show_original`         | bool   | `false` | Mantiene i valori originali accanto ai riparati     |
| `score_before_repair`   | bool   | `false` | Calcola lo score prima della riparazione            |

Elemento di `rules`:

```jsonc
{
  "id": "...", "field": "email", "label": "...", "dimension": "conformity",
  "severity": "error",          // error | warn
  "enabled": true,
  "check_type": "custom",       // not_null|pattern|range|in_list|referential|
                                // compare|custom|…
  "pattern": "...", "min": "...", "max": "...", "list": "a,b,c",
  "mat_name": "...", "ref_field": "...",       // referential / lookup materialize
  "compare_field": "...", "compare_op": "...",
  "expression": { …IR… },       // solo check_type=custom: FPEL compilata
  "repair": "none",             // none|default|field|expression|…
  "repair_default": "...", "repair_field": "...", "repair_fields": "a,b",
  "repair_separator": " ",
  "repair_expression": { …IR… } // solo repair=expression: FPEL compilata
}
```

### Validazione (doppio strato)

- `check_type=custom` richiede `expression` non vuota;
- `repair=expression` richiede `repair_expression` non vuota;
- `repair=lookup_from_file` **non supportato** → errore parlante che
  indirizza a `source_file → materialize → lookup_from_materialize`.

Errori a design-time nel builder (con dettaglio del parse FPEL) e
ri-validati dal motore.

### Migrazione (Fase 12)

Ultimo nodo del blocco "registro dataset" migrato alla spec. Caso "blob
compilato": nessuna prop scalare verbatim, l'intero DqConfig va in
spec.config. Il `case 'data_quality'` del builder scrive in `specConfig`
e non costruisce più `config` legacy.

## 13. `source_file` — lettura da file

Legge un file (CSV oggi pienamente supportato dal motore; altri formati
sono nel pannello ma non ancora nel motore) e produce righe tipizzate.
Nodo sorgente (nessun input). Nessuna risorsa DB.

### Props — scalari (verbatim via Spec)

| Chiave       | Tipo   | Default | Semantica                                              | Live |
|--------------|--------|---------|--------------------------------------------------------|------|
| `path`       | string | `""`    | Percorso del file                                      | ✅   |
| `delimiter`  | string | `","`   | Separatore (prima char); es. `;` `\t`                 | ✅   |
| `hasHeader`  | bool   | `true`  | Prima riga = intestazione                              | ✅   |

### `spec.config` — schema-proiezione

| Chiave   | Tipo  | Semantica                                                     |
|----------|-------|---------------------------------------------------------------|
| `fields` | array | `[{name, type}]` — tipi per colonna. **Elaborato dal builder** |

`fields` è la proiezione per l'esecuzione dello schema del pannello: il
builder mappa il nome logico → `physicalName` (il nome nell'header del
CSV, perché source_file legge l'header e non rinomina). Essendo materiale
elaborato (non props verbatim), va in `spec.config`. Serve per tipizzare:
un CSV è tutto testo, ma `età: integer` deve produrre `Value::Int(45)`,
non `Value::String("45")` (altrimenti `età * 5` dà null).

**Bug corretto in migrazione**: il vecchio builder leggeva `has_header`
(chiave mai prodotta dal pannello, che salva `hasHeader`) → l'opzione era
di fatto sempre `true`. Ora si legge la chiave vera.

Le altre props del pannello (`skipRows`, `commentChar`, `quoteChar`,
`jsonPath`, `pathSource`, `glob`, formati non-CSV…) non sono ancora
gestite dal motore: `log_unconsumed` le segnala. Feature future.

## 14. `sink_file` — scrittura su file

Scrive le righe in un file (csv/tsv/json/jsonl/xml/html/excel_b64), o il
contenuto raw di un campo. Nodo terminale. Nessuna risorsa DB.

Caso **"tutto props"**: nessuna struttura elaborata né FPEL. Tutte le
props vanno verbatim nella busta spec; il motore le legge via Spec con le
**chiavi camelCase del pannello**. Il `case 'sink_file'` del builder (che
le rinominava in snake_case) è stato **rimosso**.

### Props (verbatim via Spec — chiavi del pannello)

| Chiave (pannello) | Default      | Semantica                                          |
|-------------------|--------------|----------------------------------------------------|
| `path`            | — **required** | Percorso di output (vuoto → errore parlante)     |
| `format`          | `"csv"`      | csv \| tsv \| json \| jsonl \| xml \| html \| excel_b64 |
| `mode`            | `"overwrite"`| overwrite \| append                                |
| `writeMode2`      | `"rows"`     | rows \| raw_field                                  |
| `rawField`        | `"content"`  | campo sorgente in modalità raw_field               |
| `rawEncoding`     | `"text"`     | text \| base64                                     |
| `outputMode`      | `"signal"`   | modalità di uscita del nodo                        |
| `delimiter`       | csv:`,` tsv:`\t` | separatore                                     |
| `quoteChar`       | `"`          | carattere di quoting                               |
| `writeHeader`     | `true`       | scrive la riga di intestazione                     |
| `lineEnding`      | `"lf"`       | lf \| crlf                                         |
| `jsonIndent`      | `"none"`     | none \| 2 \| 4                                     |
| `jsonStructure`   | `"array"`    | array \| lines                                     |
| `encoding`        | `"utf-8"`    |                                                    |
| `partition`       | `"none"`     | ⚠ configurabile ma non ancora attivo (warning motore) |
| `postCommand`     | `""`         | ⚠ configurabile ma non ancora attivo               |
| `webhookUrl`      | `""`         | ⚠ configurabile ma non ancora attivo               |

I default vivono nel corpo del motore (`unwrap_or`), non più nel builder.

### Validazione (doppio strato)

`path` obbligatorio: il vecchio builder aveva un default fantasma
`/tmp/output.csv` che nascondeva l'errore; ora il motore dà un errore
parlante su path vuoto. (Il builder può aggiungere il blocco a
design-time quando il canale è pronto.)

### Migrazione (Fase 12)

`source_file` (misto leggero: scalari props + `fields` in config) e
`sink_file` (tutto props) migrati in coppia. Executor JS di entrambi
(erano **inline** in `src/runner/executors.ts`, non file separati)
rimossi con le loro registrazioni.

## 15. `transform` — calcola/rimappa campi (FPEL)

Versione semplificata del TMap a un solo input: per ogni riga, calcola un
insieme di campi tramite espressioni FPEL. Streaming (non bloccante).

Ha compilazione FPEL → gli `expr` sono compilati in IR dallo studio; il
motore valuta l'IR. Materiale elaborato → `spec.config`.

### `spec.config`

| Chiave   | Tipo   | Default   | Semantica                                              |
|----------|--------|-----------|--------------------------------------------------------|
| `mode`   | enum   | `"add"`   | `select` (solo campi calcolati) \| `add` (calcolati + originali) |
| `fields` | array  | `[]`      | `[{name, expr}]` — `expr` è IR FPEL compilata          |

**Default opposti da conoscere:** il pannello dice `unmappedFields`
(default `drop`), il motore dice `mode` (default `add`). Il builder
traduce: `drop → select`, `passthrough → add`. Questa traduzione è
elaborazione → il `mode` risultante va in spec.config.

### Validazione (doppio strato)

Gli errori di compilazione FPEL bloccano il run a design-time nel builder
(con dettaglio per campo). Un errore NON degrada a config vuota: il nodo
produrrebbe dati sbagliati in silenzio.

### Migrazione (Fase 12)

Caso "misto con IR" (come aggregate/window): `fields` (IR) + `mode`
(scalare derivato) in spec.config. Il `case 'transform'` scrive in
specConfig; executor JS (`mapExecutor`, inline in executors.ts) rimosso.

## 16. `filter` — filtra le righe

Lascia passare o scarta le righe secondo una o più condizioni. Streaming.
**Non usa FPEL**: le condizioni sono clausole strutturate o template
predefiniti, non espressioni compilate.

### `spec.config`

| Chiave          | Tipo   | Default     | Semantica                                       |
|-----------------|--------|-------------|-------------------------------------------------|
| `conditions`    | array  | `[]`        | Condizioni (v. sotto)                            |
| `null_behavior` | enum   | `"exclude"` | Come trattare i null: `exclude` \| `include`     |

Elemento di `conditions` — tre modi (`mode`):
- `visual` — clausole `[{field, operator, value, logic}]` (logic AND/OR
  connette con la clausola precedente);
- `template` — template predefinito (`template_id` + `template_params`),
  es. `date_is_today`, `date_is_past`;
- `code` — testo JS/Python **non eseguibile nel motore** (la condizione
  ritorna false, con warning all'avvio). Predisposizione, non attivo.

### Migrazione (Fase 12)

Caso "struttura senza FPEL": tutto il FilterPlan (`conditions` +
`null_behavior`) in spec.config. Il `case 'filter'` scrive in specConfig;
executor JS (`filterExecutor`, inline) rimosso.

## 17. `union` — impila flussi (merge di schema per nome+tipo)

Fonde N flussi **verticalmente**: impila le righe, unendo lo schema.
Diversa dal Join (che fonde orizzontalmente correlando per chiave): stesso
valore di chiave in due input → due righe (una per input), non una.

**Modello di allineamento (deciso a design-time nel MappingPanel):**
- campi con **stesso nome E stesso tipo** → si fondono in una colonna sola;
- campo con nome già usato ma **tipo diverso** → il secondo prende un
  suffisso automatico (`codice` → `codice_2`), NON si fonde;
- l'utente può **separare** due campi fusi rinominandone uno (o
  **fonderne** due dando lo stesso nome).

Il MappingPanel produce `fields` (mappatura già risolta); il motore la
applica **meccanicamente**, senza inferenze a runtime. Non c'è merge
cieco by-name: l'allineamento è una decisione esplicita dell'utente,
assistita dall'auto-fusione nome+tipo. Questo elimina by-design le due
ambiguità classiche (omonimia non voluta, collisione di tipo): la prima
si separa rinominando, la seconda non fonde in automatico.

### `spec.config` (blob elaborato dal MappingPanel)

| Chiave              | Tipo   | Default          | Semantica                                          |
|---------------------|--------|------------------|----------------------------------------------------|
| `mode`              | enum   | `"concat"`       | `concat` (impila) \| `zip` (affianca per posizione) |
| `fields`            | array  | `[]`             | `[{name, type, from}]` — mappatura schema risolta. **Required** |
| `missing_field`     | enum   | `"null"`         | Campo assente in un flusso: `null` \| `omit`        |
| `add_source_field`  | bool   | `false`          | Aggiunge una colonna con la provenienza            |
| `source_field_name` | string | `"_union_source"`| Nome di quella colonna                              |
| `zip_mismatch`      | enum   | `"truncate"`     | mode=zip, lunghezze diverse: `truncate`\|`pad_null`\|`error` |
| `handle_labels`     | object | `{}`             | handle → etichetta leggibile (per `_union_source`)  |

`UnionField.from` è `handle → nome del campo IN QUEL FLUSSO`; un handle
assente da `from` non alimenta il campo → null.

### Tipi misti in una colonna

Se l'utente forza la fusione di campi con tipo diverso (rinominandoli
uguali), il motore **impila i valori verbatim, senza coercere**: una
colonna può contenere Int in una riga e String in un'altra (Value li
ospita entrambi). La coercizione, se serve, è un `transform` a valle. Un
warning sui tipi incompatibili è compito del builder/validazione live.

### Migrazione (Fase 12)

Caso "blob elaborato" (come data_quality): tutta la config in
spec.config. Nessun executor JS da rimuovere (union non ne aveva). Le due
"decisioni di semantica" del vecchio TODO erano **già risolte** dal
modello nome+tipo del MappingPanel.

## 18. `json_serializer` — righe → JSON

Serializza uno o più flussi in JSON, con supporto a strutture annidate
**master-detail** (un flusso master con array di dettaglio innestati) via
un albero di composizione definito nel pannello. Emette il JSON in un
campo di uscita.

Caso **"blob elaborato"**: la config è assemblata dal builder da un
editor ad albero (`tree`, `mappings`, `inputs` da
`node.data.config.jsonSerializer`) più scalari. Tutto va in `spec.config`.

### `spec.config`

| Chiave         | Tipo   | Default     | Semantica                                         |
|----------------|--------|-------------|---------------------------------------------------|
| `output_field` | string | `"content"` | Campo in cui scrivere il JSON                      |
| `pretty`       | bool   | `false`     | Indentazione leggibile                             |
| `envelope`     | string | `""`        | Wrapper esterno opzionale                          |
| `null_default` | string | `"null"`    | Rappresentazione dei null                          |
| `on_error`     | enum   | `"reject"`  | Comportamento su errore                            |
| `tree`         | array  | `[]`        | Albero di composizione (master-detail). Dall'editor |
| `mappings`     | object | `{}`        | handle → mappatura campi (`json_key`, `source_field`, `transform`, `nullable`) |
| `inputs`       | object | `{}`        | metadati input                                     |

## 19. `xml_serializer` — righe → XML

Come json_serializer ma produce XML: elemento radice, namespace,
dichiarazione XML, struttura annidata via albero di composizione.

Caso **"blob elaborato"**: config assemblata dal builder (`tree`,
`legacy`, `mappings` dall'editor + scalari) → `spec.config`.

### `spec.config`

| Chiave            | Tipo   | Default        | Semantica                                    |
|-------------------|--------|----------------|----------------------------------------------|
| `output_field`    | string | `"xml_output"` | Campo in cui scrivere l'XML                   |
| `pretty`          | bool   | `false`        | Indentazione                                 |
| `root_element`    | string | `"record"`     | Nome dell'elemento radice                     |
| `root_ns_prefix`  | string | `""`           | Prefisso namespace della radice               |
| `root_namespace`  | string | `""`           | URI namespace della radice                    |
| `namespaces`      | string | `""`           | **Stringa** `prefix=uri` per riga (NON JSON)  |
| `xml_declaration` | bool   | `true`         | Include `<?xml … ?>`                          |
| `encoding`        | string | `"UTF-8"`      |                                              |
| `on_error`        | enum   | `"reject"`     |                                              |
| `tree`            | array  | `[]`           | Albero di composizione. Dall'editor           |
| `legacy`          | array  | `[]`           | Struttura legacy (`xmlStructure`), compat      |
| `mappings`        | object | `{}`           | handle → mappatura campi                       |

### Migrazione (Fase 12)

`json_serializer` e `xml_serializer` migrati in coppia. Casi "blob
elaborato" (come union/data_quality): tutta la config in spec.config.
Executor JS di entrambi (file separati in `src/runner/`) rimossi.

**Nota — parser vs serializer:** i due *serializer* erano già
pienamente implementati nel motore Rust (580/619 righe). I due *parser*
(json/xml) invece hanno nel motore solo un flatten basilare: la loro
logica ricca (multi-flusso, master-detail) vive ancora nell'executor JS
del runner e va **reimplementata in Rust** (porting dedicato, non
semplice migrazione alla spec). V. sezioni future.