# Design — nodo Union

Unisce N flussi in uno. Lo schema di uscita si decide a **design-time**,
non a runtime: il motore applica una mappatura già risolta, non indovina.

## Principio

> "Lo studio compila, il motore esegue."

Il vecchio executor JS decideva a runtime: campionava il tipo del primo
valore, fondeva o rinominava al volo. Non deterministico (il risultato
dipendeva dai dati) e non traducibile dal codegen.

Ora: il pannello calcola lo schema unificato, l'utente lo conferma, e la
mappatura finisce nella config. Il motore la applica meccanicamente.

## Handle

- `input_main` — il primo flusso (fisso)
- `union_input_<id>` — flussi aggiuntivi, creati dal connectionResolver
- `config.unionInputs: [{id, label, color}]` — l'elenco dei dinamici

L'infrastruttura esiste già (pattern identico al TMap).

## Schema unificato — regole

Per ogni campo di ogni input, chiave = `nome::tipo`.

1. **Stesso nome, stesso tipo** → si fondono in un'unica colonna.
2. **Stesso nome, tipo diverso** → il secondo è rinominato (`codice_2`).
3. **Nome presente in un solo input** → colonna propria; le righe degli
   altri input avranno `null`.

L'utente può **rinominare** un campo nel pannello, separandolo dal fuso
(caso: due `codice` string che significano cose diverse).

## Config prodotta dal pannello

    {
      "mode": "concat" | "mix" | "zip",
      "fields": [
        { "name": "id",       "type": "integer",
          "from": { "input_main": "id", "union_input_x": "id" } },
        { "name": "città",    "type": "string",
          "from": { "union_input_x": "città" } },
        { "name": "codice_2", "type": "string",
          "from": { "union_input_x": "codice" } }
      ],
      "missing_field": "null",          // "null" | "omit"
      "add_source_field": true,
      "source_field_name": "_union_source",
      "zip_mismatch": "truncate"        // "truncate" | "pad_null" | "error"
    }

`from` mappa handle → nome del campo IN QUEL FLUSSO. Un campo assente da
`from` per un dato handle produce `null` (o è omesso).

## Modalità — tutte streaming

**concat** — legge `input_main` fino alla fine, poi il secondo, ecc.
Ordine deterministico. Il caso più comune.

**mix** — legge da qualunque input abbia righe pronte (`tokio::select!`).
Ordine non deterministico, dipende dalla velocità dei flussi.

**zip** — legge una riga da ciascun input, fonde i campi, emette una riga.
Se un input finisce prima:
  - `truncate` (default): si ferma al più corto
  - `pad_null`: continua, i campi mancanti sono null
  - `error`: fallisce

## Fuori dal 1.0

**`outputOrder`** (ordinamento del risultato) — richiede di materializzare
tutte le righe. Ordinare non è mestiere di `union`: è un nodo `sort`, che
non esiste ancora. Va rimosso dal pannello.

## Nel motore

    per ogni riga dall'handle H:
        out = Row::new()
        per ogni campo dello schema di uscita:
            valore = match field.from.get(H) {
                Some(src) => row.get(src) oppure Null,
                None      => Null,           // (o omesso se missing_field = "omit")
            }
            out.set(field.name, valore)
        se add_source_field:
            out.set(source_field_name, label dell'handle H)
        emetti out

Nessuna inferenza. Deterministico. Il codegen lo traduce in un `match`.
