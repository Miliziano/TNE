# 06 — Aggregazione

Dimostra un nodo che lavora **sull'intero dataset** invece che riga per riga:
raggruppa i movimenti per cliente e somma gli importi. È l'esempio con il
risultato più piccolo e quindi il più facile da controllare a occhio.

**Livello L0**: nessuna dipendenza esterna.

---

## Il piano da disegnare

| Nodo | Etichetta | Configurazione |
|---|---|---|
| `source_file` | **Movimenti** | `dati/movimenti.csv` |
| `aggregate` | **Totali per cliente** | raggruppa per `cliente`; somma di `importo`; conteggio dei movimenti |
| `sink_file` | **Uscita totali** | `_out/totali.csv` |

---

## I dati

Gli stessi 12 movimenti del quinto esempio, su **5 clienti distinti** (C001,
C005, C012, C016 e l'orfano C999). Qui gli orfani non danno fastidio: si
raggruppa per codice, esista o no in anagrafica.

**I totali attesi**, verificabili a mente:

| cliente | movimenti | somma |
|---|---|---|
| C001 | 3 | 180.50 |
| C005 | 3 | 38.00 |
| C012 | 2 | 22.25 |
| C016 | 2 | 260.00 |
| C999 | 2 | 35.00 |
| **totale** | **12** | **535.75** |

Il controllo più forte non è una singola somma: è che **i movimenti dei gruppi
sommino a 12** e i totali a **535.75**. Se un gruppo si perde o una riga viene
contata due volte, quel numero cambia.

## Cosa deve succedere

Uscita **0**: 12 righe in ingresso, **5** in uscita, file di 6 righe
(intestazione + 5).

## Come si esegue

```bash
cd examples/06-aggregazione
mkdir -p _out
# nello studio: apri piano.ffplan → "Compila" → salva artifact.ffart qui
/percorso/al/flowpilot_runner artifact.ffart > run.ndjson
echo "uscita: $?"
node ../verifica.mjs . run.ndjson --exit 0
```

Poi apri `_out/totali.csv` e confronta le cinque somme con la tabella qui sopra:
è l'unico esempio in cui il **contenuto** si verifica per intero, non solo il
conteggio delle righe.

## Se i numeri non tornano

- **12 righe in uscita**: il raggruppamento non è avvenuto (chiave sbagliata, o
  il nodo sta lavorando riga per riga).
- **4 righe**: manca un gruppo — quasi certamente C999, se qualcosa filtra i
  clienti non presenti in anagrafica.
- **somme diverse**: attenzione al tipo di `importo` — se venisse letto come
  intero, i decimali sparirebbero (o i valori diventerebbero NULL). È
  esattamente il difetto che abbiamo corretto nell'inferenza dei tipi.

## Cosa guardare nel monitor

La fila dei nodi deve mostrare `12 → 5`: l'aggregazione è l'unico nodo, insieme
allo script del terzo esempio, in cui il numero di righe cambia per costruzione.
