# TODO — arco tratteggiato per le dipendenze dataset

## Idea

Nel canvas, tracciare un arco leggero e tratteggiato tra il nodo
`materialize` che pubblica un dataset e i nodi che lo leggono.

Serve perché quella dipendenza oggi è **invisibile**: un `window` che legge
"clienti" sembra un nodo isolato, ma in realtà attende la pubblicazione.

## Vincoli decisi

- **Solo rendering**, mai negli `edges` dello store: sarebbe salvato nel
  progetto e il builder lo manderebbe al motore come canale vero.
- **Nessuna freccia**, solo tratteggio leggero.
- **Non selezionabile, non cancellabile**: nasce dalla configurazione.
- **Per-lane**: le lane sono sandbox, un materialize vive solo nella sua.
  Non esistono archi dataset tra lane (per quello ci sono i bridge).

## Come trovare le coppie

La fonte di verità è la **variabile di lane** creata dal pulsante
"Pubblica nella lane" del materialize:

    { name: "clienti", type: "materialize", value: "<node_id>" }

Un nodo legge quel dataset se la sua prop `materializeName` vale `"clienti"`.

**Tutti e cinque i consumer usano la stessa prop `materializeName`**
(window, aggregate, pivot, explode, join). La prop che *seleziona* la
sorgente cambia (`dataSource`, `explodeSource`, `rightSource`), ma il nome
del dataset sta sempre lì. Quindi la ricerca è universale e non richiede
una lista per-nodo.

## Punto d'innesto

`src/components/LaneCanvas.tsx`, riga ~319: esiste già `liveEdges`, un
`useMemo` che deriva gli edge dallo store. Un secondo `useMemo` calcola gli
archi dataset, e si concatena:

    edges={[...datasetEdges, ...liveEdges]}

I tratteggiati per primi, così restano sotto.

Stile: `strokeDasharray: '3 4'`, `strokeWidth: 1`, `opacity: 0.35`,
colore del materialize (`#a78bfa`), `markerEnd: undefined`.

## Tre punti aperti

**1. Gli handle.** Un arco ReactFlow parte da un handle. Usando quelli
esistenti (`output` del materialize → `input` del lettore), l'arco
tratteggiato si sovrappone agli archi veri. Alternative: handle nascosti
dedicati (più pulito, tocca i componenti nodo), oppure accettare la
sovrapposizione confidando in opacità e tratteggio.

**2. Riferimento a un nome inesistente.** L'utente può scrivere a mano un
`materializeName` che non corrisponde a nessuna variabile registrata.
Nessun arco da disegnare. Il motore darà "dataset non dichiarato" al run.
Servirebbe un badge di errore sul nodo, a design-time.

**3. `materializeName` residuo.** Se l'utente imposta `dataSource: 'flow'`
ma il campo `materializeName` è rimasto valorizzato da prima, l'arco
apparirebbe senza che ci sia dipendenza reale.

Per evitarlo servirebbe controllare anche la prop di selezione — che è
proprio la lista per-nodo che si voleva evitare. Alternativa: pulire
`materializeName` quando si cambia sorgente.
