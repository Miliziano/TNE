# 04 — Fallimento governato

Questo esempio **deve fallire**. È l'unico modo di verificare che error handler,
codice d'uscita e riepilogo del monitor si comportino bene quando le cose vanno
male — la parte che nessuno collauda mai, e che serve proprio nel momento
peggiore.

**Livello L0**: nessuna dipendenza esterna.

---

## Il piano da disegnare

| Nodo | Etichetta | Configurazione |
|---|---|---|
| `source_file` | **Sorgente mancante** | `dati/questo-file-non-esiste.csv` (di proposito) |
| `sink_file` | **Uscita mai scritta** | `_out/mai_creato.csv` |
| `error_handler` | *(quello della lane)* | collegato alla lane, per raccogliere l'errore |

La cartella `dati/` è volutamente vuota: **non creare quel file**, o l'esempio
smette di provare ciò che deve provare.

---

## Cosa deve succedere

Uscita **1**, esito **fallito**, e nel log devono comparire `NodeFailed` (il nodo
che non ha trovato il file) e `RunFailed`. Il file di uscita **non** deve essere
creato.

Nota sulle statistiche: `nodi` è volutamente **vuoto** in `atteso.json`. Un run
fallito può non avere statistiche complete per tutti i nodi, e pretenderle
renderebbe la prova fragile per il motivo sbagliato. Qui contano l'esito, il
codice d'uscita e la presenza degli eventi di fallimento.

## Come si esegue

```bash
cd examples/04-fallimento-governato
mkdir -p _out          # IMPORTANTE: senza, fallisce il SINK (cartella mancante)
                       # invece della sorgente, e l'esempio prova un'altra cosa
# nello studio: apri piano.ffplan → "Compila" → genera artifact.ffart qui
/percorso/al/flowpilot_runner artifact.ffart > run.ndjson
echo "uscita: $?"        # deve essere 1
node ../verifica.mjs . run.ndjson --exit 1
```

Le attese includono **`errore_contiene`**: non basta che il run fallisca, il
messaggio d'errore deve parlare del file sorgente mancante. Senza quel controllo
l'esempio resterebbe verde anche fallendo per tutt'altro motivo — e siccome i
nodi partono in parallelo, due difetti contemporanei fanno a gara: vince quello
che si manifesta prima.

Attenzione: qui il verde significa "ha fallito **come doveva**". Se questo
esempio passasse con uscita 0, sarebbe **quello** il problema.

## Cosa guardare nel monitor

Il run deve apparire **fallito** (badge rosso), il riepilogo deve mostrare il
messaggio d'errore in evidenza — leggibile, non sepolto nel JSON — e le righe
degli eventi di errore devono essere colorate di rosso. È anche il modo di
verificare il filtro "⚠ solo errori": deve restituire pochi eventi, tutti
pertinenti.
