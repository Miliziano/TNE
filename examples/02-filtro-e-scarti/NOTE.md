# 02 — Filtro e scarti

Dimostra la **porta reject**: le righe che non passano una condizione non vengono
perse né fatte fallire, ma escono da una seconda porta e finiscono in un file a
parte. È il modo corretto di trattare i dati sporchi in produzione — e finora non
l'avevamo mai esercitato.

**Livello L0**: nessuna dipendenza esterna.

---

## Il piano da disegnare

| Nodo | Etichetta | Configurazione |
|---|---|---|
| `source_file` | **Sorgente clienti** | `dati/clienti.csv`, CSV, separatore `,`, con intestazione |
| `filter` | **Filtro maggiorenni** | condizione `eta >= 18`, **porta reject ATTIVA** |
| `sink_file` | **Clienti validi** | `_out/validi.csv` (dalla porta principale) |
| `sink_file` | **Clienti scartati** | `_out/scartati.csv` (dalla porta **reject**) |

Il punto dell'esempio è il quarto nodo: senza di lui le righe scartate
svanirebbero silenziosamente, ed è proprio quello che non si vuole.

---

## I dati

Gli stessi 20 clienti del primo esempio: **17 maggiorenni** e **3 minorenni**
(`C004` 17 anni, `C009` 16, `C020` 15). I numeri sono scelti perché la verifica
sia inequivocabile.

## Cosa deve succedere

Uscita **0**. Il filtro riceve 20 righe, ne lascia passare **17** e ne scarta
**3**. Il controllo che conta davvero: **17 + 3 = 20**, cioè nessuna riga si è
persa per strada. I due file hanno 18 e 4 righe (intestazione compresa).

## Come si esegue

```bash
cd examples/02-filtro-e-scarti
mkdir -p _out
# nello studio: apri piano.ffplan → "Compila" → salva artifact.ffart qui
/percorso/al/flowpilot_runner artifact.ffart > run.ndjson
echo "uscita: $?"
node ../verifica.mjs . run.ndjson --exit 0
```

## Se i numeri non tornano

Da tarare al primo giro: il motore potrebbe contare le righe scartate in modo
diverso (per esempio `rows_out` 20 e `rows_rejected` 3, invece di 17 e 3).
`--taratura` mostra i valori osservati. Attenzione a distinguere: una **diversa
contabilità** è una taratura, righe che **spariscono** (17 + 3 < 20) è un difetto.

## Cosa guardare nel monitor

Nel riepilogo deve comparire la voce **scartate 3**, e nella fila dei nodi il
filtro mostra `20 → 17` con l'indicazione delle scartate. È anche il primo
esempio in cui quel numero non è zero.
