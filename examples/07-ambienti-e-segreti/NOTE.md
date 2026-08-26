# 07 — Ambienti e segreti

Chiude la serie verificando due promesse che riguardano la **distribuzione**, non
i dati: che **cambiando profilo cambi il comportamento** dello stesso piano, e
che il **valore di un segreto non finisca dentro l'artifact** — un file che si
copia sui server.

È l'unico esempio in cui si controlla anche il `.ffart`, non solo il log.

**Livello L0**: nessuna dipendenza esterna.

---

## Preparazione (editor "Ambienti")

1. **Variabile di pool** `AMBIENTE`, valore di default `TEST`.
2. Due **profili**: `test` con `AMBIENTE = TEST`, `prod` con `AMBIENTE = PROD`.
   Profilo attivo: **test**.
3. Un **segreto** chiamato `PAROLA_SEGRETA` (bottone "+ segreto"). Il suo
   **valore** va messo sulla macchina, non nel progetto: nella sezione *Segreti —
   valori su questa macchina* scrivi esattamente
   **`non-deve-uscire-di-qui`**.
   Quel valore serve al controllo di sicurezza: il verificatore cercherà quella
   stringa dentro l'artifact e fallirà se la trova.

---

## Il piano da disegnare

| Nodo | Etichetta | Configurazione |
|---|---|---|
| `source_file` | **Sorgente clienti** | `dati/clienti.csv` |
| `transform` | **Marca ambiente** | campo nuovo `ambiente = var("AMBIENTE")` |
| `sink_file` | **Uscita marcata** | `_out/clienti_marcati.csv` |

> Nota tecnica utile: i `${VAR}` vengono risolti **solo nelle configurazioni
> delle risorse** (host, porte, credenziali). Nei campi dei nodi il valore di una
> variabile si legge con **`var("NOME")`** in FPEL: è la via che questo esempio
> usa, e funziona perché i valori del profilo attivo vengono passati al motore
> come variabili di lane.

---

## Cosa deve succedere

Con il profilo **test** congelato: 20 righe, e ogni riga ha `ambiente = TEST`.
Nell'artifact: `profile` vale `test`, `requiredSecrets` contiene
`PAROLA_SEGRETA`, e **il valore del segreto non compare da nessuna parte**.

## Come si esegue

```bash
cd examples/07-ambienti-e-segreti
mkdir -p _out
# nello studio: profilo attivo "test" → "Compila" → salva artifact.ffart qui
/percorso/al/flowpilot_runner artifact.ffart > run.ndjson
echo "uscita: $?"
node ../verifica.mjs . run.ndjson --exit 0
```

### La seconda metà: il profilo cambia davvero?

Ri-esporta lo **stesso piano** con il profilo **prod** e riesegui. Nel file di
uscita `ambiente` deve valere `PROD`. Nessuna modifica al flusso: solo il
profilo congelato. Se il valore non cambia, il congelamento non sta funzionando.

*(Per verificarlo col verificatore basta cambiare `TEST`→`PROD` e `test`→`prod`
in `atteso.json`; oppure guardarlo a occhio, sono 20 righe.)*

## Cosa dimostra il controllo sui segreti

Il piano **dichiara** di aver bisogno di `PAROLA_SEGRETA`; il **valore** vive sulla
macchina. Se un giorno una modifica facesse finire quel valore nell'artifact —
per esempio "risolvendo" i segreti troppo presto, nello studio — questo esempio
diventerebbe rosso subito, con un messaggio esplicito. È una promessa di
sicurezza resa verificabile a macchina, invece che affidata alla memoria.
