# FlowPilot — Validazione: builder e motore, doppio strato

Nota di design. Fissa **dove** vive la validazione man mano che i nodi
migrano al motore Rust, e traccia la direzione futura del builder come
strumento di *progettazione e verifica*, non solo di disegno.

## Il principio

**Migrare l'esecuzione al motore non significa spostare la validazione
dal builder al motore.** Sono due lavori diversi, con destinazioni
diverse:

- **Trasformazione** — tipizzare un valore, compilare un'espressione in
  IR, calcolare, aggregare, ordinare. Questo va al **motore**: è l'unico
  che eseguirà gli artifact compilati, headless, senza builder.
- **Verifica** — questo campo obbligatorio è compilato? Il tipo è
  coerente? Questa scelta produrrà un errore, o un risultato
  sorprendente? Questo va **al builder**, e ci resta: è l'unico che parla
  con l'utente *prima* che il job parta.

Verificare non richiede di eseguire. Il builder può ispezionare,
inferire e avvisare su un valore anche se non è più lui a trasformarlo.
Le due responsabilità sono separabili, e tenerle separate è ciò che
impedisce al builder di degradare a un editor di diagrammi.

## Conseguenza operativa per le migrazioni

Quando una migrazione sposta una logica dal builder al motore:

1. La **trasformazione** va nel motore.
2. Le **validazioni** del builder (le vecchie `throw new Error` dentro
   `buildRustPlan`) **non spariscono**: restano nel builder.
3. Le stesse condizioni vengono **ri-validate nel motore** come errori
   parlanti — perché l'artifact compilato girerà senza builder.

È **ridondanza voluta**, non spreco: il builder protegge l'utente umano
a design-time, il motore protegge l'esecuzione headless. Una condizione
sbagliata viene intercettata due volte, in due contesti diversi.

Regola pratica: se una migrazione sta per cancellare una `throw` dal
builder senza rimpiazzo, è un errore. La `throw` diventa *warning o
errore a design-time nel builder* **più** *errore parlante nel motore*.

## Due registri nel builder: bloccare e consigliare

Il builder ha due livelli, e deve poterli usare entrambi:

- **Errore bloccante** — per ciò che è sicuramente sbagliato: un campo
  obbligatorio mancante, una colonna unpivot non selezionata. Impedisce
  di procedere.
- **Warning non bloccante** — per ciò che è sospetto ma legale:
  `nullValue` testuale che finirà in una colonna probabilmente numerica,
  un alias che collide, un campo referenziato che non compare nello
  schema a monte. Non impedisce di procedere, ma *avvisa*.

Il warning è ciò che rende il builder uno strumento di *progettazione*:
non solo "non puoi", ma "attento, forse non è ciò che intendi". È lo
spirito di un IDE che sottolinea in giallo senza rifiutare di compilare.

Il motore, invece, ha un registro solo: **errore parlante**. Non
"consiglia" — l'esecuzione headless non ha un umano davanti da avvisare.
Ciò che nel builder è warning, nel motore o è tollerato (se legale) o è
errore (se rompe l'esecuzione), mai "warning".

## Direzione futura (non ancora implementata)

Oggi le validazioni del builder sono `throw new Error` sparse in
`buildRustPlan`: scattano solo quando l'utente **lancia** il job. Un vero
strumento di progettazione le vuole **live**, mentre si disegna:

- un pannello/nodo che segnala i problemi in tempo reale (triangolino,
  bordo colorato);
- una lista "problemi" aggregata, stile pannello Problems di un IDE;
- distinzione visiva tra errori (rosso, bloccano il run) e warning
  (giallo, informano).

Questo è un **sistema a sé**, da progettare quando sarà il momento —
non da infilare dentro la migrazione di un singolo nodo. Ma va tenuto
presente *durante* le migrazioni, così ogni nodo lascia i ganci giusti
(le sue condizioni di validità esplicite e riutilizzabili) invece di
seppellirle in una `throw` monouso. Quando il sistema live arriverà,
dovrà poter pescare da quelle condizioni senza riscoprirle.

## Checklist per ogni nodo migrato

- [ ] La trasformazione è nel motore.
- [ ] Le validazioni bloccanti del builder sono ancora lì (o migliorate).
- [ ] Le stesse condizioni sono errori parlanti nel motore.
- [ ] Dove un valore è legale ma sospetto, il builder emette un warning
      non bloccante (o è annotato come "warning futuro" se il canale
      warning non è ancora disponibile per quel pannello).
