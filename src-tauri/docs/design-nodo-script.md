# Nodo Script — disegno (riprogettazione su FPEL)

Stato: **deciso**, non ancora implementato. Ordine di porting deciso
dall'utente: ~~error_handler~~ → **script** → report_generator.

---

## 1. Perché riprogettare invece di portare

Il nodo Script nella versione TypeScript (`src/runner/scriptExecutor.ts`,
codice morto conservato come riferimento — v. HANDOFF §7) compilava
**codice JavaScript arbitrario** con `new Function()`, esponendo un
contesto con `log / emit / skip / reject / error / lane / pool` e
cercando una funzione `transform(row, context)`.

Non è portabile, e non per un dettaglio tecnico: in `src-tauri/Cargo.toml`
non c'è alcun motore JS (`boa`, `rquickjs`, `deno`, `v8`, `rhai`, `mlua`:
nessuno). Ma anche potendone aggiungere uno, resterebbe il motivo vero.

FlowPilot ha **un solo linguaggio di espressioni**, FPEL, e il suo
principio architetturale è scritto in `design-linguaggio-espressioni.md`:

> Compilato in `ExprNode` (IR) dallo studio; il motore Rust esegue l'IR.
> Il codegen (Rust/Java/Python) traduce **l'IR, mai il testo**.

È ciò che permette a un grafo di girare nel motore locale *e* di essere
tradotto verso altri runtime (`preferredRuntimes` in `nodeSemantics.ts`).
Un nodo il cui contenuto è opaco — un corpo JS, o rhai — sarebbe un buco
permanente in quella catena: eseguibile solo dal motore, mai traducibile.
Da qui la decisione: **lo Script diventa un piccolo linguaggio di
istruzioni costruito sopra le espressioni FPEL**, compilato a IR come
tutto il resto.

### Cosa si perde e cosa si guadagna

Si perde il codice arbitrario: niente librerie esterne, niente accesso a
rete o filesystem dal corpo dello script, niente cicli su strutture
qualunque (nella prima fetta, niente cicli affatto).

Si guadagna qualcosa che la versione JS non poteva dare **per
costruzione**: lo **schema di uscita è calcolabile**. Un corpo JS può
restituire qualunque forma, quindi lo studio non poteva sapere quali
campi escono da uno Script, non poteva propagare lo schema a valle né
validare i nodi successivi. Un elenco di assegnazioni invece si legge:
*schema di uscita = schema di ingresso + campi assegnati*. Lo Script
smette di essere il buco nero della propagazione schema.

In più: sandbox per costruzione (non c'è niente da sandboxare), nessuna
dipendenza nuova, nessun timeout da inventare, errori di sintassi
mostrati a design-time come già accade per le espressioni.

---

## 2. Cosa distingue lo Script dal Transform

Il nodo `transform` esegue già una lista di `{ name, expr: ExprNode }`:
assegnazioni pure di campi, valutate con FPEL. Se lo Script si limitasse
a questo sarebbe un doppione con una sintassi diversa.

Quello che lo Script aggiunge — ed è la sua ragione d'essere — è il
**controllo**:

- decidere che una riga **non deve uscire** (`skip`);
- decidere che una riga è **da scartare con motivo** (`reject`), sulla
  porta che il contratto porte già dichiara condizionale (`hasReject`);
- **fallire** con un messaggio (`error`), che nel modello di error
  handling è un errore di nodo e va all'error handler della lane;
- **annotare** il pannello di log (`log`);
- calcolare **valori intermedi** che non finiscono nella riga (`let`);
- ramificare (`if`).

E, nelle fette successive, emettere **più righe** da una (`emit`) e
scrivere **variabili di lane** — che è la modalità *innesco* già
dichiarata nel contratto porte (`outputMode: 'signal'`).

---

## 3. Il linguaggio

Le **espressioni** sono FPEL, senza modifiche: stessi letterali, stessi
operatori, stesse ~40 funzioni, stesso `var("nome")` per leggere una
variabile di lane. Quello che si aggiunge sono le **istruzioni**.

    let iva = imponibile * 0.22
    totale = imponibile + iva

    if paese == "IT" && totale > 1000 {
      log "Ordine sopra soglia: " + id
      categoria = "premium"
    } else {
      categoria = "standard"
    }

    if email is null {
      reject "email mancante"
    }

    if stato == "annullato" {
      skip
    }

### 3.0 Due nature: trasformatore e generatore

Uno Script può **ricevere righe** e trasformarle, oppure **generarle dal
nulla** — un conteggio, una serie di date, l'espansione di un array. La
differenza la dichiara la prop `sourceMode`:

- `flusso` (predefinito): il corpo gira **una volta per riga**; la riga di
  lavoro parte da una copia di quella in ingresso ed esce a fine corpo
  anche senza `emit` (passthrough);
- `genera`: **la porta d'ingresso non esiste** (`when` su
  `staticInputPorts` — il meccanismo era già generale, nessuna porta
  d'ingresso lo aveva mai usato). Il corpo gira **una volta sola**, la
  riga di lavoro parte vuota e **non esce da sola**: senza `emit` un
  generatore non produce niente, ed è giusto — far uscire una riga vuota
  sarebbe inventare un dato.

La natura si **dichiara** e non si deduce: con `genera` un arco non è
nemmeno disegnabile, quindi la doppia natura non può nascere per
distrazione — che è il difetto del "se non ha archi, allora è un
generatore". Nel motore l'ingresso è un `Option<RowReceiver>`, come già
fa `window` ("caso 2: nessun arco").

### 3.0.1 `emit` non è una funzione del generatore

`emit` manda a valle **una copia della riga di lavoro com'è in quel
momento**, e vale in tutte e due le modalità: una riga può entrarne una e
uscirne molte. Non interrompe niente — le istruzioni successive
continuano sulla stessa riga e possono emetterla di nuovo dopo averla
cambiata.

Le righe emesse escono **in ogni caso**, anche se il corpo finisce con
`skip` o `reject`: sono state prodotte prima che il corpo decidesse come
finire. Da cui il modo naturale di scrivere un fan-out puro:

    repeat 3 as i {
      copia = i
      emit
    }
    skip        // escono le tre copie, non l'originale

### 3.1 Istruzioni

| Istruzione | Effetto |
|---|---|
| `let nome = <expr>` | valore intermedio, visibile alle istruzioni successive, **non** finisce nella riga in uscita |
| `campo = <expr>` | assegna un campo della riga in uscita (lo crea se non esiste) |
| `if <expr> { … }` / `else { … }` | ramificazione; `else if` è zucchero per `else { if … }` |
| `skip` | la riga non esce da nessuna porta; l'elaborazione di quella riga finisce lì |
| `reject <expr>` | la riga esce dalla porta `reject` col motivo indicato; l'elaborazione di quella riga finisce lì |
| `log <expr>` | riga nel pannello di log (livello `info`) |
| `error <expr>` | il nodo fallisce con quel messaggio |
| `emit` | manda a valle una copia della riga di lavoro; non interrompe |
| `repeat <expr> [as <nome>] { … }` | ripete il blocco N volte; `nome` è un locale che conta da 1 |
| `for <nome> in <expr> { … }` | ripete il blocco su ogni elemento di un array |

`skip`, `reject` ed `error` **terminano** l'elaborazione della riga
corrente: le istruzioni successive non vengono eseguite. È la stessa
semantica del `return` anticipato, senza doverlo chiamare `return`.

### 3.2 La riga in uscita

Si parte da una **copia della riga in ingresso**, e le assegnazioni la
modificano. Chi non assegna niente ottiene un passthrough — che è anche
il `fallback: 'passthrough'` già dichiarato in `nodeSemantics.ts`.

### 3.3 Nomi: campi, locali, variabili di lane

Tre spazi di nomi, con una regola di risoluzione sola:

- `var("nome")` è **sempre** una variabile di lane (FPEL, invariato);
- un identificatore dichiarato da un `let` precedente è quel **locale**;
- ogni altro identificatore è un **campo della riga**.

I locali **coprono** i campi omonimi: dopo `let stato = upper(stato)`,
`stato` è il locale. È la regola meno sorprendente e la sola che non
richieda un sigillo (`$x`) nella sintassi.

🔑 **La risoluzione avviene nello studio**, in fase di compilazione, dove
i `let` dichiarati sono noti. Il compilatore riscrive il riferimento a un
locale come `FieldRef { input: "__local", field: "x" }`, e il motore
registra i locali in un `Row` sintetico sotto quel nome di input. Così
**l'IR delle espressioni non cambia**: nessuna variante nuova in
`ExprNode`, nessuna modifica a `expr.rs`. Il motore esegue FPEL come ha
sempre fatto; è l'ambiente che gli si prepara intorno a essere diverso.

---

## 4. L'IR

Il corpo compilato vive in `spec.config.body` (stesso posto in cui il
`transform` mette i suoi `fields`: materiale compilato dal builder →
`spec.config`), come lista di istruzioni.

```jsonc
[
  { "kind": "Let",    "name": "iva",    "expr": <ExprNode> },
  { "kind": "Assign", "field": "totale","expr": <ExprNode> },
  { "kind": "If",     "cond": <ExprNode>,
                      "then": [ … ], "else": [ … ] },
  { "kind": "Skip" },
  { "kind": "Reject", "reason": <ExprNode> },
  { "kind": "Log",    "expr": <ExprNode>, "level": "info" },
  { "kind": "Error",  "expr": <ExprNode> }
]
```

In Rust è un `enum ScriptStmt` con `#[serde(tag = "kind")]`, e
l'esecuzione di un blocco restituisce un esito di controllo:

```rust
enum Flow { Continua, Salta, Scarta(String), Fallisci(String) }
```

`Salta`, `Scarta` e `Fallisci` risalgono attraverso gli `if` annidati
fino al ciclo sulle righe. Nessuna ricorsione infinita possibile: il
linguaggio non ha cicli né chiamate.

---

## 5. Schema di uscita (studio)

Calcolabile staticamente e **senza eseguire niente**: si percorre l'IR e
si raccolgono i `field` degli `Assign`, inclusi quelli dentro gli `if`
(un campo assegnato in un solo ramo esiste comunque nello schema, con
valore `null` quando quel ramo non passa — stessa convenzione di un
`CASE WHEN` senza `ELSE`). I `let` non entrano nello schema.

Questo alimenta la propagazione a valle, oggi assente per lo Script.

---

### 3.4 Cicli e limiti

`repeat` conta; `for` scorre un array. Gli array **non sono un tipo di
FPEL**: vivono dentro `Value::Object`, che porta un `serde_json::Value` —
quindi `for` funziona senza aggiungere una variante a `Value` né toccare
`expr.rs`. Un'espressione che non è un array fa fallire il nodo con un
messaggio esplicito: adattarla a lista di un elemento sarebbe una
comodità che nasconde un errore.

Entrambi i cicli hanno un **tetto** (`MAX_GIRI`, un milione di giri per
riga in ingresso). Serve a trasformare un conteggio sbagliato in un
errore leggibile invece che in un processo che mangia memoria finché non
muore. Non ci sono `while`: il numero di giri è sempre noto prima di
cominciare.

---

## 6. Cosa NON fa (e perché è scritto qui)

- **Niente I/O**: nessun accesso a rete, file, database dal corpo. Chi
  deve leggere qualcosa usa i nodi che lo fanno.
- **Niente `lang`**: il campo `lang: typescript | java` del registro
  sparisce. Oggi non è sostenuto da niente — il codegen TypeScript non ha
  alcun generatore per lo Script — ed è una promessa che nessuno mantiene
  (stessa famiglia di `advanced` prima di P45, e della tabella ignorata
  dal `source_db` prima di P49).
- **Niente scrittura di variabili di lane**: arriva con la fetta 3,
  insieme a `outputMode: 'signal'`.
- **Niente `while`**: ogni ciclo ha un numero di giri noto prima di
  cominciare, ed è ciò che rende il tetto una garanzia e non una speranza.

---

## 7. Fette

1. ✅ **Motore + IR**: `nodes/script.rs` che esegue `ScriptStmt`; `Let`,
   `Assign`, `If`, `Skip`, `Reject`, `Log`, `Error`. Lo studio compila
   con un parser di istruzioni che riusa `parseExpression` per le parti
   fra le graffe. Il nodo esce dallo stub.
2. ✅ **Produrre righe**: `emit`, `repeat`, `for` e la modalità
   generatore. Erano tre voci separate in questo elenco (fan-out, cicli,
   nodo di partenza) e **sono una cosa sola**: un generatore che non sa
   ciclare emette solo il numero fisso di righe scritte a mano, e `emit`
   senza modalità generatore serve a metà.
3. **Scrittura di variabili di lane** e `outputMode: 'signal'` — lo Script
   che prepara un valore e dà il via al nodo dopo.
4. **Codegen**: generatore TypeScript per lo Script (oggi assente), e i
   generatori degli altri runtime quando ci saranno.

---

## 8. Migrazione dei grafi esistenti

Gli script salvati contengono JavaScript, che questo linguaggio non
accetta. Non esiste una traduzione automatica onesta: JS ha costrutti che
qui non ci sono, e tradurne un sottoinsieme darebbe l'illusione di aver
convertito tutto.

La migrazione è quindi **manuale e dichiarata**: alla lettura di un
progetto, uno Script il cui corpo non compila resta col testo originale e
la validazione lo segnala come *da riscrivere*, indicando l'errore di
parsing. Il nodo non gira finché non è riscritto — che è meglio di girare
facendo altro. NB oggi quegli script **non girano comunque**: cadono
nello stub passthrough e inoltrano le righe intatte, cioè non fanno
niente senza dirlo.
