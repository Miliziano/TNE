# TMap — Revisione della sezione trasformazioni

Proposta nata dal tuo screenshot e dalle difficoltà incontrate costruendo
l'esempio 08. Parto da cosa non funziona *guardandolo*, non da cosa manca.

---

## 1. Cosa non torna, guardando lo screenshot

Cinque trasformazioni in fila, tutte con lo stesso peso visivo. Ma non fanno la
stessa cosa:

- tre sono **derivate da campi d'ingresso** (`movimento`, `nome_completo`,
  `imponibile`);
- due sono **derivate da altre trasformazioni** (`importo_ivato` e
  `sopra_soglia` usano `imponibile`).

Questa differenza — che è la struttura del calcolo — **non si vede**. Le prime
tre sono collassate e leggibili, le altre due occupano quattro righe ciascuna
perché non hanno ingressi collegati e quindi non si potevano collassare. Il
risultato è che la parte più semplice occupa poco e la parte più interessante
occupa tutto.

E manca un'informazione che serve sempre: **da dove viene un valore**. Guardando
`imponibile` non si capisce che `importo_ivato` e `sopra_soglia` dipendono da
lui, né che l'ordine conta.

---

## 2. Le tre correzioni immediate (già fatte)

- **Collasso sempre disponibile.** Prima serviva almeno un ingresso collegato:
  proprio le trasformazioni scritte a mano restavano aperte. *(P226)*
- **Il nome della funzione nelle voci del menu**: `Unisci con separatore ·
  concat_ws`. Su 42 voci, 40 ora dichiarano la funzione che scriveranno. Non è
  cosmesi: senza, si sceglie a tentativi. *(P226)*
- **Parametri che accettano un campo** e separatori che non perdono gli spazi.
  *(P225)*

Restano i due problemi veri, che non si risolvono con ritocchi.

---

## 3. Il problema di fondo: una riga che fa quattro cose

Oggi, in una trasformazione inline, convivono: i campi collegati, una funzione
per ciascuno, la casella espressione, una funzione finale. Sono quattro
meccanismi con precedenze implicite, disposti su righe diverse ma **senza un
ordine visibile**. Da qui vengono entrambe le tue difficoltà:

- *"applico una funzione che prende due campi e uno resta fuori"* — perché la
  funzione si applica **a un campo**, e il secondo operando è un parametro
  testuale. Il modello è "un valore + parametri", ma l'interfaccia lascia credere
  che sia "n campi + funzione";
- *"non si capisce molto"* — perché non c'è una direzione di lettura.

### La proposta: la scaletta che dicevi

Una trasformazione diventa **una sequenza di passi**, letti dall'alto in basso,
ciascuno con il suo risultato:

```
  imponibile                                    decimal
  ┌──────────────────────────────────────────────────┐
  │ 1  da        main.importo                        │
  │ 2  converti  → decimale                          │
  └──────────────────────────────────────────────────┘
    risultato:  cast(main.importo as decimal)
```

```
  nome_completo                                  string
  ┌──────────────────────────────────────────────────┐
  │ 1  da        "Anagrafica clienti".nome           │
  │ 2  unisci    con  "Anagrafica clienti".cognome   │
  │              separatore  " "                     │
  └──────────────────────────────────────────────────┘
    risultato:  concat_ws(" ", …nome, …cognome)
```

Tre proprietà che risolvono i problemi di oggi:

- **il secondo campo è un passo, non un parametro nascosto**: "unisci con…" ha
  una casella che accetta un campo (trascinabile) o un testo — è la stessa
  funzionalità di prima, ma smette di sembrare un ripiego;
- **la funzione finale sparisce come concetto**: è semplicemente l'ultimo passo.
  Un'ambiguità in meno senza perdere nulla;
- **l'espressione generata resta sempre visibile**, in sola lettura: si impara il
  linguaggio guardando cosa si compone, e si vede subito cosa finirà nel piano.

Passare a **script** significa prendere quell'espressione e continuare a mano. È
un passaggio a senso unico — va detto quando lo si fa, non scoperto dopo.

---

## 4. Rendere visibile la dipendenza fra trasformazioni

Il punto che ti ha fatto perdere più tempo. Due interventi, indipendenti:

**Il collegamento grafico** — trascinare l'uscita di una trasformazione
sull'ingresso di un'altra. *(già fatto in P224; nel motore funzionava da sempre)*

**Il riferimento visibile.** Quando una trasformazione ne usa un'altra, la
scaletta lo dice come primo passo — `1 da imponibile` — con un colore diverso da
quello dei campi d'ingresso: **viola per ciò che è calcolato qui, colore
dell'ingresso per ciò che viene da fuori**. È la stessa distinzione che abbiamo
già introdotto nel linguaggio (nudo = calcolato qui, qualificato = viene da
fuori): renderla anche visiva chiude il cerchio.

E siccome **l'ordine conta** — una trasformazione vede solo quelle che la
precedono — servono due cose: le frecce su/giù per riordinare (ci sono già) e
l'avviso quando l'ordine è sbagliato *(fatto in P224)*.

---

## 5. Cosa metterei in ordine, e perché

1. **Scaletta dei passi** con l'espressione generata sempre in vista. È la
   modifica che assorbe tre problemi in uno: leggibilità, secondo campo, funzione
   finale.
2. **Anteprima sul dato vero** accanto al risultato. Su una data formattata o una
   concatenazione, guardare vale più di leggere. È anche il modo di accorgersi
   subito di un `null`.
3. **Colore per l'origine** (calcolato qui vs da un ingresso) e riferimento fra
   trasformazioni mostrato come passo.
4. **Riordino esplicito** con la dipendenza segnalata, così l'ordine smette di
   essere una regola invisibile.

I punti 1 e 2 cambiano davvero l'esperienza; 3 e 4 la rendono leggibile a colpo
d'occhio.

---

## 6. Una cosa che non farei

**Non trasformerei l'inline in un mini-linguaggio visuale.** Il rischio di
queste revisioni è aggiungere potenza all'inline finché non diventa uno script
disegnato col mouse — più difficile da usare di quello scritto. Il confine resta
quello di prima: **l'inline compone un valore, lo script elabora una riga**.
Se un caso non entra nella scaletta in tre o quattro passi, quel caso è dello
script: e va detto con un invito esplicito ("questa è complessa: passa a
script"), non lasciando che l'utente si arrangi con dieci passi in fila.

---

*In breve: la scaletta non aggiunge funzionalità, rende visibile quella che c'è.
Oggi il pannello sa fare quasi tutto ciò che serve — non si vede.*
