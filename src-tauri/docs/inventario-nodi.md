# Inventario nodi — stato verso FlowPilot 1.0

Rilevato dal codice (commit 067f72e). Tre dimensioni indipendenti:
- **Dichiarato**: esiste in `src/nodes/registry.ts` (l'utente lo vede nel canvas)
- **Implementato**: esiste `src-tauri/src/engine/nodes/<nome>.rs`
- **Collegato**: l'executor lo istanzia (`match node_type { "<nome>" => ... }`)
- **Spec**: usa `Spec::from_ctx` (fondazione §6.0) invece della config legacy

## A. PRONTI — implementati, collegati, migrati alla spec (4)

| Nodo | Note |
|---|---|
| `source_db` | pool condiviso, tipi PG completi, query custom |
| `sink_db`   | transazioni native+XA, master-detail, DDL in tx |
| `join`      | hash join 7 tipi; `customCondition` e `materialize` a TODO |
| `log`       | template, sampling, target panel/window |

## B. FUNZIONANTI ma NON migrati alla spec (13)
Implementati e collegati all'executor, ma leggono la config con il vecchio
meccanismo (cherry-picking nel builder TS). Funzionano, ma il builder deve
mantenere due logiche in parallelo → fragilità.

`aggregate` `explode` `filter` `json_parser` `json_serializer`
`materialize` `sequencer` `sink_file` `source_file` `tmap` `window`
`xml_parser` `xml_serializer`

Priorità di migrazione: `source_file`/`sink_file` (i più usati), poi `tmap`
(il più complesso), poi gli altri.

## C. ORFANI — file .rs esiste, executor NON li istanzia (4)
⚠ Se l'utente li mette nel grafo, non vengono eseguiti.

| Nodo | Righe | Note |
|---|---|---|
| `transform` | 97 | "Transform Field" — usa `ctx.config`, non la spec. Da collegare + migrare. |
| `data_quality` | 107 | Da collegare |
| `pivot` | 169 | Da collegare |
| `union` | 44 | Da collegare; semantica merge by-name da normare |

## D. GESTITI INLINE nell'executor (3)
Non hanno file .rs, la logica è nell'executor. OK così.

`bridge_in` `bridge_out` `error_handler`

## E. DICHIARATI ma NON implementati (24)
L'utente li vede nel canvas ma il motore non li esegue.

**Sorgenti**: `source_ftp` `source_http` `source_kafka` `source_mqtt`
`source_activemq` `dir_watcher` `webhook_receiver`

**Sink**: `sink_ftp` `sink_kafka` `sink_mqtt` `sink_activemq` `mail_sink`
`webhook_responder` `report_generator`

**Trasformazione**: `map` `select` `number` `text` `code` `script`

**Controllo**: `lane_start` `lane_end` `sequencer`(?) `watchdog`
`shell_exec` `ssh_exec`

## Riepilogo numerico
- Dichiarati: **48**
- Implementati: **21** (di cui 4 orfani → **17 eseguibili**)
- Migrati alla spec: **4**
- Mai implementati: **24 + 3 inline**

## Cosa serve per il 1.0 ("tutti i nodi perfettamente funzionanti")

**Interpretazione stretta** (tutti i 48): mesi di lavoro, 24 nodi da zero.

**Interpretazione pragmatica** (tutti i nodi ESPOSTI funzionano):
1. **Collegare i 4 orfani** (transform, data_quality, pivot, union) —
   lavoro contenuto, chiude un buco grave (nodi che non fanno nulla).
2. **Nascondere/marcare i 24 non implementati** nel registry, oppure
   implementarli. Un utente non deve poter mettere nel canvas un nodo
   che il motore ignora.
3. **Migrare i 13 alla spec** — non blocca il 1.0 ma riduce fragilità.
   Necessario prima del CODEGEN (il generatore legge la spec, non i
   `case` legacy del builder).

## Impatto sul CODEGEN (artifact Rust autonomo)

Il generatore di artifact leggerà la **spec** dei nodi. Ogni nodo non
migrato è un caso speciale nel codegen. Quindi:
- migrare i 13 alla spec **prima** di scrivere il codegen
- i 24 non implementati: se non sono nel 1.0, vanno rimossi dal registry
  (non generabili)
