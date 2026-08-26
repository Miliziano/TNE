# 03 — Script FPEL

Dimostra il **linguaggio** e la sua caratteristica più distintiva: `emit`, che
non è un "return" ma un **fan-out** — una riga in ingresso può diventarne molte
in uscita. Verifica anche che lo schema d'uscita venga dedotto dal corpo dello
script, senza dichiararlo a mano.

**Livello L0**: nessuna dipendenza esterna.

---

## Il piano da disegnare

| Nodo | Etichetta | Configurazione |
|---|---|---|
| `source_file` | **Sorgente ordini** | `dati/ordini.csv`, CSV, separatore `,`, con intestazione |
| `script` | **Esplosione unità** | modalità **flusso**, corpo qui sotto |
| `sink_file` | **Uscita unità** | `_out/unita.csv` |

Il corpo dello script: da ogni ordine escono tante righe quante sono le unità
ordinate, ognuna con il suo numero progressivo e il prezzo della singola unità.

```
let q = cast(quantita as integer)
repeat q as i {
  numero_unita = i
  prezzo = cast(prezzo_unitario as decimal)
  emit
}
skip
```

Due cose da capire, che sono il senso dell'esempio:

- **`emit` non interrompe**: manda a valle una copia della riga *nello stato
  attuale* e prosegue il ciclo. Per questo si ottengono più righe da una sola.
- **`skip` finale**: in modalità *flusso* la riga elaborata uscirebbe **da sola**
  a fine corpo, aggiungendosi alle copie emesse. `skip` impedisce quell'uscita
  implicita — le righe già emesse escono comunque.

---

## I dati

Sei ordini con quantità **1, 2, 3, 1, 2, 1**: in totale **10 unità**. Numeri
scelti apposta perché il risultato sia una somma verificabile a mente.

## Cosa deve succedere

Uscita **0**. Lo script riceve **6** righe e ne produce **10** — è l'unico
esempio in cui le righe in uscita sono *più* di quelle in ingresso. Il file
finale ha 11 righe (intestazione + 10) e contiene la colonna `numero_unita`,
che nel CSV di partenza non esiste: la prova che lo schema è stato dedotto dal
corpo dello script.

## Come si esegue

```bash
cd examples/03-script-fpel
mkdir -p _out
# nello studio: apri piano.ffplan → "Compila" → salva artifact.ffart qui
/percorso/al/flowpilot_runner artifact.ffart > run.ndjson
echo "uscita: $?"
node ../verifica.mjs . run.ndjson --exit 0
```

## Se i numeri non tornano

I due esiti diversi da 10 sono entrambi istruttivi:

- **16 righe** (10 + 6) significa che l'uscita implicita non è stata soppressa:
  manca lo `skip` finale, o non si comporta come previsto.
- **6 righe** significa che `emit` non ha prodotto copie: da guardare la
  modalità del nodo (dev'essere *flusso*) e il ciclo `repeat`.

Anche il contatore di `repeat … as i` va tarato al primo giro: se parte da 0,
`numero_unita` andrà da 0 a q−1 (se preferisci da 1, scrivi `numero_unita = i + 1`).
Il conteggio delle righe non cambia in nessuno dei due casi.

## Cosa guardare nel monitor

Nella fila dei nodi lo script deve mostrare `6 → 10`: le righe in uscita
maggiori di quelle in ingresso è la firma visiva del fan-out.
