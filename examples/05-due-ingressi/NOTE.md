# 05 — Due ingressi

Dimostra un nodo che riceve da **due sorgenti** e le mette in relazione su una
chiave: i movimenti vengono arricchiti con i dati dell'anagrafica. È anche
l'unico esempio in cui alcune righe **non trovano corrispondenza**, e questo è
previsto.

**Livello L0**: nessuna dipendenza esterna.

---

## Il piano da disegnare

| Nodo | Etichetta | Configurazione |
|---|---|---|
| `source_file` | **Anagrafica clienti** | `dati/clienti.csv` |
| `source_file` | **Movimenti** | `dati/movimenti.csv` |
| `join` (o `tmap`) | **Unione** | chiave: `cliente` (movimenti) = `codice` (anagrafica), tipo **interno** |
| `sink_file` | **Uscita arricchita** | `_out/movimenti_arricchiti.csv` |

L'uscita deve contenere almeno una colonna che viene **dall'anagrafica** (per
esempio `cognome`): è la prova che la relazione è stata risolta davvero e non si
sono solo affiancate le righe.

---

## I dati

**12 movimenti** su 4 clienti esistenti (C001, C005, C012, C016) più **2
movimenti orfani** che citano un cliente inesistente (`C999`). I numeri sono
scelti perché il tipo di join si veda dal risultato:

- **join interno** → **10** righe: gli orfani cadono;
- **join sinistro** → **12** righe: gli orfani restano, con i campi
  dell'anagrafica vuoti.

Le attese sono scritte per il **join interno**. Se preferisci il sinistro,
cambia `Unione.rows_out` in 12 e le righe del file in 13: entrambe le scelte
sono legittime, l'importante è che il piano e le attese dicano la stessa cosa.

## Cosa deve succedere

Uscita **0**, 10 righe in uscita, file di 11 righe con la colonna `cognome`.

## Come si esegue

```bash
cd examples/05-due-ingressi
mkdir -p _out
# nello studio: apri piano.ffplan → "Compila" → salva artifact.ffart qui
/percorso/al/flowpilot_runner artifact.ffart > run.ndjson
echo "uscita: $?"
node ../verifica.mjs . run.ndjson --exit 0
```

## Se i numeri non tornano

- **12 invece di 10**: è un join sinistro, non interno (o gli orfani vengono
  tenuti). Scegli quale dei due vuoi e allinea le attese.
- **più di 12**: attenzione, è il sintomo classico della **duplicazione**: la
  chiave non è univoca da un lato e ogni movimento si moltiplica. Qui
  l'anagrafica ha codici unici, quindi non dovrebbe accadere — se accade, è una
  scoperta.
- **0 righe**: la chiave non combacia (nomi di campo invertiti, o tipi diversi).

## Cosa guardare nel monitor

Nella fila dei nodi l'unione deve mostrare due ingressi che convergono e
`→ 10` in uscita.
