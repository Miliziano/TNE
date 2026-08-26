# Esempi FlowPilot

Progetti di esempio che servono **due scopi insieme**: si aprono nello studio e
si leggono come documentazione, e sono la **prova ripetibile** da eseguire dopo
ogni ricompilazione.

Ogni esempio dichiara cosa deve succedere in `atteso.json`, e uno script
(`verifica.mjs`) confronta il log di un run con quelle attese. Senza un risultato
atteso, un esempio è una demo — non un test.

---

## Gli esempi

| | Cosa dimostra | Livello | Esito atteso |
|---|---|---|---|
| **01-file-to-file** | Il ciclo minimo: sorgente CSV → trasformazione → sink CSV | L0 | riuscito |
| **02-filtro-e-scarti** | Porta **reject**: le righe non valide non si perdono | L0 | riuscito |
| **03-script-fpel** | Il linguaggio e il **fan-out** con `emit` (1 riga → N) | L0 | riuscito |
| **04-fallimento-governato** | Error handler, run fallito **onestamente**, uscita 1 | L0 | **fallito** |

*(In arrivo: due ingressi, aggregazione, ambienti e segreti.)*

**Livelli.** **L0** non dipende da nulla fuori dalla macchina — è la prova di
regressione, ed è ciò che un giorno girerà in CI. **L1** richiede servizi che
puoi alzare tu, **L2** infrastruttura vera (database, code, LDAP): utili da
leggere, mai un cancello.

---

## Come si esegue un esempio

```bash
cd examples/01-file-to-file
mkdir -p _out

# 1. nello studio: apri piano.ffplan → "Compila" → salva artifact.ffart qui
# 2. esegui, tenendo il log
/percorso/al/flowpilot_runner artifact.ffart > run.ndjson
echo "uscita: $?"

# 3. confronta con le attese
node ../verifica.mjs . run.ndjson --exit 0
```

Esito verde = tutto torna. Esito rosso = il verificatore dice **quale** valore non
torna, non solo che qualcosa non va.

### Tarare le attese

Alla prima esecuzione di un esempio nuovo (o quando lo cambi di proposito) i
numeri attesi vanno presi dalla realtà, non indovinati:

```bash
node ../verifica.mjs . run.ndjson --exit 0 --taratura
```

stampa i valori **osservati** già nella forma di `atteso.json`.

---

## Cosa controlla il verificatore

- **codice d'uscita** ed **esito** del run;
- **statistiche per nodo** (righe in / out / scartate), indicate per **etichetta**
  del nodo — non per id, che cambia se ridisegni il flusso;
- **eventi richiesti**: per esempio `RunStarted` deve esserci. Sembra ovvio, ma è
  esattamente il bug che ci è sfuggito per tre giri;
- **file prodotti**: esistenza, numero di righe, un frammento atteso;
- **invarianti**, in particolare `nessun_dato_di_riga`: al livello di log normale
  nessun evento deve trasportare contenuto di riga. La protezione dati smette di
  essere una promessa e diventa un controllo.

---

## Convenzioni

- I percorsi dentro un piano sono **relativi alla cartella dell'esempio**:
  esegui il runner da lì.
- Le uscite vanno in **`_out/`** (ignorata da git): una prova non sporca il repo.
- I dati sono **finti, piccoli e fissi**: nessuna data di oggi, nessun valore
  casuale. Due esecuzioni devono dare gli stessi numeri.
- Le **etichette dei nodi** fanno parte del contratto: se le cambi, aggiorna
  `atteso.json`.

Il disegno completo della suite (principi, formato delle attese, esempi
successivi, procedura di collaudo) sta nel documento *Suite di esempi e prova di
collaudo*.
