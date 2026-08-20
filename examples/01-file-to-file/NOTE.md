# 01 — Da file a file

Il "ciao mondo" di FlowPilot: leggi un CSV, aggiungi due campi calcolati, scrivi
un CSV. È il ciclo minimo completo — e la prova che l'intera catena (studio →
export → runner → monitor → verificatore) funziona.

**Livello L0**: nessuna dipendenza esterna, gira ovunque.

---

## Il piano da disegnare

Tre nodi in fila. **Le etichette contano**: il verificatore confronta le
statistiche per etichetta, quindi vanno scritte esattamente così.

| Nodo | Etichetta | Configurazione |
|---|---|---|
| `source_file` | **Sorgente clienti** | `dati/clienti.csv`, formato CSV, separatore `,`, prima riga = intestazione |
| `transform` | **Arricchimento** | due campi nuovi (sotto) |
| `sink_file` | **Uscita clienti** | `_out/clienti_arricchiti.csv`, CSV con intestazione |

I due campi calcolati nel transform, in FPEL:

```
nome_completo  =  concat(nome, " ", cognome)
importo_ivato  =  round(cast(importo as decimal) * 1.22, 2)
```

I percorsi sono **relativi alla cartella dell'esempio**: esegui il runner da qui.

---

## I dati

`dati/clienti.csv` — 20 righe più l'intestazione, valori fissi (nessuna data,
nessun valore casuale: due esecuzioni devono dare gli stessi numeri).
Per curiosità: 17 clienti sono maggiorenni e 3 minorenni — servirà all'esempio 02.

---

## Cosa deve succedere

Uscita **0**, esito **completato**, 20 righe dentro e 20 fuori da ogni nodo, e un
file di 21 righe (intestazione + 20) che contiene la colonna `nome_completo`.

## Come si esegue

```bash
cd examples/01-file-to-file
mkdir -p _out
# nello studio: apri piano.ffplan → "Compila" → genera artifact.ffart qui
/percorso/al/flowpilot_runner artifact.ffart > run.ndjson
echo "uscita: $?"
node ../verifica.mjs . run.ndjson --exit 0
```

## Se qualcosa non torna

Il verificatore dice **quale** numero non torna. Prima di correggere il piano,
verifica le attese sui valori veri:

```bash
node ../verifica.mjs . run.ndjson --exit 0 --taratura
```

stampa ciò che ha osservato, nella forma di `atteso.json`. Alla **prima**
esecuzione è normale doverlo usare: le righe attese del file di uscita
dipendono da come il sink scrive l'intestazione, e vanno tarate una volta sola.

## Cosa guardare nel monitor

Il riepilogo deve dire *completato*, durata di poche centinaia di millisecondi,
**righe (max per nodo) 20**, 3 nodi. Con il livello di log *normale* non deve
comparire nessun contenuto di riga: nessun nome, nessun importo.
