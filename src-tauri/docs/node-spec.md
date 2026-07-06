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