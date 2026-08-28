# 08 — TMap

Il TMap è il nodo più importante dello studio, e finora nessun esempio lo
esercitava davvero. Questo lo mette alla prova su tutto ciò che sa fare in un
colpo solo: **due ingressi** messi in relazione, **campi calcolati** con le
espressioni FPEL, un **valore intermedio** riusato, e **due uscite** con filtri
diversi.

**Livello L0**: nessuna dipendenza esterna.

---

## Il piano da disegnare

| Nodo | Etichetta | Configurazione |
|---|---|---|
| `source_file` | **Movimenti** | `dati/movimenti.csv` — ingresso **principale** |
| `source_file` | **Anagrafica clienti** | `dati/clienti.csv` — ingresso di **lookup** |
| `tmap` | **Arricchimento TMap** | relazione `cliente` = `codice`, **solo corrispondenze**; due uscite (sotto) |
| `sink_file` | **Tutti i movimenti** | `_out/movimenti_tmap.csv` |
| `sink_file` | **Sopra soglia** | `_out/sopra_soglia.csv` |

### Il valore intermedio

Nel TMap, una *transform* (variabile intermedia) chiamata **`imponibile`**:

```
cast(importo as decimal)
```

Serve a due cose: si usa in più campi senza riscriverla, ed è il modo di provare
che le variabili intermedie del TMap entrano nell'inferenza dei tipi.

### I campi in uscita

Gli stessi per entrambe le uscite:

| Campo | Espressione |
|---|---|
| `movimento` | `upper(replace(movimento, "M", "MOV-"))` |
| `cliente` | `cliente` |
| `nome_completo` | `concat_ws(" ", nome, cognome)` |
| `citta` | `citta` |
| `imponibile` | `imponibile` *(la transform)* |
| `importo_ivato` | `round(imponibile * 1.22, 2)` |
| `sopra_soglia` | `imponibile > 50` |

Le funzioni scelte non sono casuali: `replace`, `concat_ws` e `round` sono tra
quelle che **prima non avevano un tipo** dentro il TMap (v. in fondo).

### Le due uscite

- **principale** → nessun filtro, va in `Tutti i movimenti`;
- **sopra soglia** → filtro `imponibile > 50`, va in `Sopra soglia`.

---

## I dati

12 movimenti, di cui **10** riferiti a clienti esistenti e 2 orfani (`C999`).
Con la relazione a **sole corrispondenze** gli orfani cadono.

Dei 10 abbinati, **4** superano la soglia di 50: `M001` (100,00), `M002`
(50,50), `M007` (200,00), `M010` (60,00).

## Cosa deve succedere

Uscita **0**. Il TMap riceve **12** righe ed emette **14**: attenzione, non è un
errore — `rows_out` del TMap è la **somma su tutte le uscite** (10 + 4), perché
le righe sopra soglia escono da entrambe. I due file hanno 11 e 5 righe.

Nel primo file deve comparire `MOV-001`: è la prova che `replace` e `upper`
hanno lavorato davvero sul campo, non che sia passato inalterato.

## Come si esegue

```bash
cd examples/08-tmap
mkdir -p _out
# nello studio: apri piano.ffplan → "Compila" → salva artifact.ffart qui
/percorso/al/flowpilot_runner artifact.ffart > run.ndjson
echo "uscita: $?"
node ../verifica.mjs . run.ndjson --exit 0
```

## Se i numeri non tornano

- **12 righe in uscita invece di 10**: la relazione tiene anche le righe senza
  corrispondenza (join sinistro invece di sole corrispondenze).
- **più di 12 righe nell'uscita principale**: chiave non univoca nell'anagrafica
  → ogni movimento si moltiplica. Qui i codici sono unici, quindi sarebbe una
  scoperta.
- **`rows_out` diverso da 14**: ricorda che è la somma delle uscite; se una
  delle due non emette, il totale cala.
- **`MOV-001` assente**: il campo calcolato non è stato applicato — controlla
  l'espressione del campo `movimento`.

---

## Una verifica in più, che il runner non può fare

L'inferenza dei tipi del TMap **non si vede nel log**: il motore non converte i
valori in base al tipo dichiarato, quindi il risultato su disco è identico sia
che il tipo sia dedotto bene sia che manchi. Si controlla **nello studio**:

1. collega un nodo qualsiasi a valle di un'uscita del TMap e aprine il pannello;
2. guarda i tipi dei campi in ingresso.

`nome_completo` dev'essere **string**, `importo_ivato` un tipo **numerico** e
`sopra_soglia` **boolean**. Prima dell'unificazione dell'inferenza (P213)
`concat_ws` e `replace` non avevano tipo, e un confronto come
`imponibile > 50` veniva dedotto *numerico* invece che booleano.
