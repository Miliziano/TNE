# Vettori dei contratti

File fissi che descrivono formati su cui altri programmi fanno affidamento. Un test li
rilegge a ogni compilazione: se fallisce dopo una modifica, **si è rotto un contratto e si
corregge il codice, non il vettore**. Un vettore nuovo si aggiunge con un nome nuovo
(`_v2`, `_v3`…), quelli vecchi restano finché le versioni che li producono sono in uso.

| Vettore | Cosa fissa | Test |
|---|---|---|
| `canonical_plan_v1.json` | forma canonica del piano e `planHash` (TS ⟷ Rust) | `src/ir/canonicalPlan.test.ts`, `signing/canonical.rs` |
| `artifact_v2.ffart` + `artifact_v2_trust_store.json` | artifact firmato `formatVersion: 2`: ogni runner futuro deve ammetterlo così com'è | `runtime/admission.rs` (`vettore_artifact_v2`), `tests/runner_contract.rs` |
| `engine_events_v1.ndjson` | un esempio per ogni evento del motore, com'è serializzato | `engine/events.rs` (`contract_tests`) |

L'interfaccia del runner (codici d'uscita, `--admit-only`, intestazione del log) è fissata
da `src-tauri/tests/runner_contract.rs`, che usa `artifact_v2.ffart`.

Contratti e regole di evoluzione: `docs/ARCHITETTURA-coordinatore.md` §4.
