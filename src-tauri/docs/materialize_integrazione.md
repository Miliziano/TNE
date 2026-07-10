# Integrazione del registro dataset — le modifiche

## 1. `src-tauri/src/engine/mod.rs`

    pub mod datasets;

## 2. `src-tauri/src/engine/types.rs` — il plan porta i dataset dichiarati

Accanto a `TransactionPlan`:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DatasetPlan {
    /// nome con cui il dataset è pubblicato nella lane
    pub name: String,
    /// id del nodo materialize che lo pubblica
    pub node_id: String,
}
```

E in `LanePlan`, dopo `transactions`:

```rust
    #[serde(default)]
    pub datasets: Vec<DatasetPlan>,
```

## 3. `src-tauri/src/engine/executor.rs`

### a) Campo nel `NodeContext`

```rust
    pub lane_txns: std::sync::Arc<super::txregistry::LaneTransactions>,
    /// Registro dei dataset materializzati, per-lane. I nodi che pubblicano
    /// (materialize) e quelli che leggono (window, aggregate, pivot,
    /// explode, join) lo condividono.
    pub lane_datasets: std::sync::Arc<super::datasets::LaneDatasets>,
```

### b) Costruzione, accanto a `lane_resources` (riga ~236)

```rust
    let lane_resources = super::pool::LaneResources::new(sizing);

    // ── Registro dataset materializzati ────────────────────────────
    // Uno slot Pending per ogni dataset DICHIARATO: un consumer che chiede
    // un nome non dichiarato riceve un errore invece di attendere per sempre.
    let declared_datasets: Vec<String> = lane_plan.datasets.iter()
        .map(|d| d.name.clone())
        .collect();

    // Rifiuta le dipendenze circolari PRIMA di partire:
    //   window → materialize("A")   e   window legge "A"
    // sarebbe un'attesa infinita.
    {
        let producers: std::collections::HashMap<String, String> = lane_plan.datasets.iter()
            .map(|d| (d.name.clone(), d.node_id.clone()))
            .collect();

        let mut consumers: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        for n in &lane_plan.nodes {
            // Un nodo legge un dataset se la sua config ha
            // data_source == "materialize" e un materialize_name.
            let reads_ds = n.config.get("data_source")
                .and_then(|v| v.as_str()) == Some("materialize");
            if !reads_ds { continue }
            if let Some(name) = n.config.get("materialize_name").and_then(|v| v.as_str()) {
                consumers.entry(n.node_id.0.clone()).or_default().push(name.to_string());
            }
        }

        let flow_edges: Vec<(String, String)> = lane_plan.edges.iter()
            .map(|e| (e.source_node.0.clone(), e.target_node.0.clone()))
            .collect();

        super::datasets::check_dataset_cycles(&producers, &consumers, &flow_edges)?;
    }

    let lane_datasets = super::datasets::LaneDatasets::new(&declared_datasets);
```

⚠ Il blocco va messo **prima** che `lane_plan.nodes` e `lane_plan.edges`
vengano spostati in variabili locali (`let nodes = lane_plan.nodes;`).

### c) Passaggio al `NodeContext` (riga ~319)

```rust
            lane_resources: lane_resources.clone(),
            lane_txns:      lane_txns.clone(),
            lane_datasets:  lane_datasets.clone(),
```

### d) Finalizzazione a fine lane (riga ~388)

```rust
    lane_txns.finalize_with_outcome(lane_result.is_ok()).await;

    // Chi attende un dataset mai pubblicato viene risvegliato con un
    // errore, invece di restare appeso: rete di sicurezza se il
    // materialize è fallito o non è mai stato eseguito.
    lane_datasets.finalize().await;

    lane_resources.close_all().await;
```

**Nota**: `lane_resources.close_all()` è chiamato **due volte** nel codice
attuale (righe 390 e 393). Innocuo (è idempotente), ma va tolta la seconda.

## 4. `src/components/Toolbar.tsx` — il plan porta i dataset

Il builder oggi appiattisce le variabili in `{name: value}`, **perdendo il
tipo**: il motore riceve `{"clienti": "node_7"}` e non sa se è una stringa
o un dataset. Va separato.

Dove costruisce `variables` (riga ~355):

```typescript
    // Variabili della lane — solo scalari.
    // Le variabili di tipo 'materialize' NON sono valori: dichiarano che
    // un nodo pubblica un dataset con quel nome. Vanno in `datasets`.
    const variables: Record<string, unknown> = {}
    const datasets: Array<{ name: string; node_id: string }> = []

    for (const v of laneConfig?.variables ?? []) {
      if (v.type === 'materialize') {
        datasets.push({ name: v.name, node_id: v.value })
      } else {
        variables[v.name] = v.value
      }
    }
```

E nell'oggetto lane del plan, accanto a `transactions`:

```typescript
      variables,
      transactions,
      datasets,
```

## 5. `case 'materialize'` nel builder

Non esiste. Il nodo riceve config vuota e usa i default.

```typescript
        case 'materialize': {
          // matName non vuoto ⇒ il dataset è pubblicato nella lane
          // (l'utente ha premuto "Pubblica" nel tab Configurazione).
          config = {
            mode:        props['matMode']  ?? 'passthrough',
            name:        props['matName']  ?? '',
            key_field:   props['keyField'] ?? '',
            max_rows:    Number(props['maxRows'] ?? 0),
            on_overflow: props['onOverflow'] ?? 'error',
          }
          break
        }
```

## 6. Limite noto — da annotare nel TODO

Un nodo non può distinguere «il monte ha finito» da «il monte è fallito»:
in entrambi i casi il canale si chiude.

Conseguenza: se il source a monte muore a metà, `materialize` pubblica un
dataset **parziale** credendolo completo, e `window` calcola `rank` su dati
incompleti. In silenzio.

Mitigazione attuale: se la lane fallisce, `finalize()` dà errore a chi non
ha ancora letto. Chi ha già letto non se ne accorge.

Soluzione vera: propagare «chiusura per errore» lungo i canali. È un lavoro
sul modello di esecuzione, non su questo nodo — lo stesso limite già
annotato per le transazioni.
