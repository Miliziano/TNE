# FlowPilot — Manuale del linguaggio FPEL

Riferimento del linguaggio di FlowPilot: **FPEL** (*FlowPilot Expression
Language*), le sue **funzioni preconfezionate** e i **template** pronti, sia
nell'**applicazione inline** (una espressione per campo, nei nodi Transform,
TMap, Filter, Data Quality) sia nell'**editor completo** del nodo **Script**.

> Un principio guida tutto il linguaggio: **un'espressione non valida è un
> errore, non un degrado silenzioso.** Un nome di funzione sbagliato o un'arità
> errata vengono segnalati a design-time, nello studio, prima del Run — mai
> lasciati passare fino al dato (il bug storico era `upper(x)` che finiva nel
> dato come la stringa letterale `"upper(x)"`).

---

## 1. Due livelli, un solo linguaggio

FPEL esiste in due forme, con lo **stesso** nucleo di espressioni:

- **Espressioni** — il nucleo. Un'espressione produce **un valore**: `prezzo *
  1.22`, `upper(nome)`, `case when eta >= 18 then "adulto" else "minore" end`.
  È ciò che valutano **tutti** i nodi che calcolano su un campo: Transform,
  TMap, Filter, Data Quality — e anche lo Script, dentro le sue istruzioni.
- **Istruzioni** — un soprainsieme, disponibile **solo nel nodo Script**.
  Aggiunge ciò che un'espressione non può esprimere: **assegnare** un campo,
  **ramificare** (`if`), **ciclare** (`for`/`repeat`), **emettere** più righe,
  e **decidere che una riga non esce** (`skip`/`reject`). Le condizioni e i
  valori dentro le istruzioni sono, di nuovo, espressioni FPEL.

Detto in breve: **ovunque scrivi una condizione o un valore, quello è FPEL.**
Lo Script aggiunge solo la cornice attorno alle espressioni.

Parser e validazione vivono **nello studio**; il motore Rust riceve l'IR già
compilato (`ExprNode` per le espressioni, `ScriptStmt` per le istruzioni) e non
conosce la sintassi testuale. È la stessa divisione dei parametri di query: il
codegen traduce l'IR, mai il testo.

---

## 2. I due contesti d'uso

### Applicazione inline (una espressione per campo)
Nei nodi **Transform**, **TMap**, **Filter**, **Data Quality** ogni campo o
condizione è **una singola espressione** FPEL. La scrivi a mano oppure parti da
un **template per tipo di campo** (§6.2). Esempi:

- Transform, campo `prezzo_ivato`: `prezzo * 1.22`
- Filter, condizione: `eta >= 18 and stato == "attivo"`
- TMap, campo in uscita: `concat_ws(" ", nome, cognome)`

### Editor completo (nodo Script)
Il nodo **Script** ha un **corpo** di più istruzioni, con un editor Monaco
completo (evidenziazione, completamento contestuale, validazione dal vivo).
Serve quando una singola espressione non basta: più campi calcolati insieme,
condizioni, cicli, fan-out di righe. Esempio:

```
let scont = iif(vip, 0.10, 0)
prezzo_finale = round(prezzo * (1 - scont), 2)
if prezzo_finale > 1000 {
  log concat("ordine grosso: ", to_string(prezzo_finale))
}
```

---

## 3. Espressioni FPEL

### 3.1 Letterali
- **Numeri**: `42`, `3.14`, `.5`. Il separatore `_` è ammesso per leggibilità:
  `1_000_000`.
- **Stringhe**: `"..."` o `'...'`, con escape `\"`, `\'`, `\\`, `\n`, `\t`.
- **Booleani**: `true`, `false`.
- **Nullo**: `null`.

### 3.2 Riferimenti a campo
Un **identificatore nudo è un campo della riga**: `prezzo`, `nome`, `città`
(sono ammessi accenti e lettere non latine — gli identificatori sono Unicode).

Per i nomi con spazi o punteggiatura si usano i **backtick**, come in SQL:
`` `data ordine` ``, `` `costo/unità` ``.

Nei nodi a **più ingressi** (tipicamente il TMap) un campo si qualifica con
l'etichetta dell'ingresso: `Anagrafica.nome`, oppure `"Righe ordine".importo`
quando l'etichetta contiene spazi. Nei nodi a ingresso singolo il
qualificatore non è ammesso (non avrebbe senso).

### 3.3 Variabili di lane
Le **variabili di lane** si leggono con `var("nome")`. Sono valori condivisi a
livello di lane, risolti per scope. In **lettura** sono disponibili ovunque; la
**scrittura** (`var("x") = ...`) è possibile solo dal nodo Script (§4.2), con
effetto **locale al nodo**. Le variabili di **pool** non sono raggiungibili
dalle espressioni per scelta: dentro un'espressione vive la **lane**, non il
pool.

### 3.4 Operatori e precedenza
Dalla precedenza più bassa alla più alta:

| Liv. | Operatori | Note |
|---|---|---|
| 1 | `\|\|` `or` | OR logico |
| 2 | `&&` `and` | AND logico |
| 3 | `==` `!=` | uguaglianza |
| 4 | `<` `<=` `>` `>=` | confronto |
| 5 | `+` `-` | somma/sottrazione — **`+` concatena** se un operando è stringa |
| 6 | `*` `/` `%` | prodotto, divisione, modulo |

Unari: `!` (negazione logica), `-` (segno). Le parentesi `(...)` raggruppano
come di consueto. Le parole `and`/`or` sono equivalenti a `&&`/`||`.

### 3.5 Costrutti
- **Condizionale a rami** — `case when C1 then V1 [when C2 then V2 …] [else D]
  end`. Serve almeno un `when`.
- **Ternario** — `cond ? se_vero : se_falso` (zucchero per `iif(...)`).
- **Cast** — `cast(x as tipo)`. Tipi: `integer`/`int`, `float`/`double`,
  `decimal`, `string`/`text`, `boolean`/`bool`, `date`, `datetime`.
- **Test di null** — `x is null`, `x is not null`.

### 3.6 Chiamate di funzione
`nome(arg1, arg2, …)`. Il nome è **case-insensitive** e molti hanno **alias**
(§5). Ogni chiamata è **validata a design-time**: nome esistente e numero di
argomenti nell'intervallo previsto; altrimenti errore nel pannello, con
posizione. Il catalogo completo è al §5.

---

## 4. Il linguaggio di istruzioni (nodo Script)

### 4.1 Modello di esecuzione
Lo Script gira **una volta per riga** in ingresso. Lo **schema di uscita** è
"schema d'ingresso **+** i campi che il corpo assegna" (dedotti leggendo il
corpo, `if` annidati inclusi). Due modalità (prop *Sorgente delle righe*):

- **flusso** — c'è una porta d'ingresso; la riga elaborata **esce da sola** a
  fine corpo (anche senza `emit`).
- **genera** — **la porta d'ingresso sparisce** (non è disegnabile un arco); il
  nodo produce righe dal nulla, e una riga esce **solo** se la emetti con
  `emit`.

### 4.2 Le istruzioni

| Istruzione | Forma | Effetto |
|---|---|---|
| Assegnazione | `campo = <espr>` | Crea o sovrascrive un campo in uscita |
| Locale | `let nome = <espr>` | Valore intermedio, visibile nel blocco corrente |
| Scrivi variabile di lane | `var("nome") = <espr>` | Scrive una variabile di lane (locale al nodo, persiste tra righe) |
| Condizione | `if <cond> { … }` · `else if <cond> { … }` · `else { … }` | Ramificazione |
| Ripeti | `repeat <n> [as <nome>] { … }` | N iterazioni; `nome` opzionale = contatore |
| Cicla | `for <nome> in <espr-array> { … }` | Itera su un array |
| Emetti | `emit` | Manda a valle una **copia** della riga com'è ora — non interrompe |
| Salta | `skip` | La riga **non esce** dalla porta principale |
| Scarta | `reject [<motivo>]` | Manda la riga alla porta **reject** con un motivo |
| Log | `log <espr>` | Riga di log (livello info) |
| Errore | `error <espr>` | Fa **fallire** la riga/nodo con un messaggio |

Dettagli che contano:

- **`emit` è fan-out, non "return".** Manda a valle una copia della riga nello
  stato attuale e **prosegue**: le istruzioni successive continuano a lavorare
  sulla stessa riga e possono emetterla di nuovo dopo averla modificata. Le
  righe emesse escono **anche** se il corpo termina con `skip`/`reject`. Vale in
  entrambe le modalità: in **genera** è l'unico modo di produrre righe; in
  **flusso** aggiunge righe oltre a quella che esce da sola. Così "1 riga → N"
  è una cosa che si **scrive**, non una modalità a parte.
- **`reject`** manda la riga alla porta *reject* (con `_reject_reason` se dai un
  motivo): va abilitata la porta reject sul nodo. **`skip`** semplicemente non
  la fa uscire dalla principale. **`error`** interrompe con fallimento (finisce
  nell'error handler, se collegato).
- **`let`** ha **scope di blocco**: un `let` dentro un `if` vale dentro
  quell'`if`; fuori, quel nome torna a essere un campo della riga (e se il campo
  non esiste, si legge `null`). Non si può ridichiarare lo stesso nome nello
  stesso scope. L'espressione si risolve **prima** di dichiarare il nome, quindi
  `let x = x + 1` legge il **campo** `x`, non se stesso.
- **`var("x") = …`** scrive una variabile di lane **privata al nodo**: le
  scritture **persistono fra le righe** (utile per accumulatori), ma non escono
  dal nodo. Lo studio avvisa se leggi una `var("x")` che non è né dichiarata
  nella lane né mai scritta.

### 4.3 Regole di scrittura
- **Commenti** con `//` fino a fine riga.
- Lo scanner è **consapevole delle stringhe**: `log "http://x"` non è un
  commento, e `reject "manca }"` non chiude un blocco.
- Le **graffe spezzano la riga logica**: `if z { b = 1 }` scritto su una riga
  sola e lo stesso `if` su quattro righe sono identici per il parser.
- **`else if`** è zucchero per `else { if … }`.
- **Parole riservate** (non usabili come nome di campo/locale): `let`, `if`,
  `else`, `skip`, `reject`, `log`, `error`, `emit`, `repeat`, `for`, `in`, `as`.
- **Limite anti-loop**: al massimo **1.000.000** di iterazioni per riga (somma
  di `repeat`/`for`); `for` itera solo su **array** (un non-array è un errore).
  Non esiste `while`.

---

## 5. Catalogo delle funzioni preconfezionate

**84 funzioni**, raggruppate per categoria. La colonna *Funzione* riporta la
firma leggibile (gli argomenti fra `[…]` sono opzionali); *Ritorno* è il tipo
prodotto (`polimorfo` = dipende dagli argomenti, v. §8); *Alias* sono nomi
alternativi accettati in scrittura e normalizzati al nome canonico.

> Il catalogo è la **fonte di verità** condivisa da validazione, autocomplete e
> (in prospettiva) codegen, ed è allineato una-a-una al motore
> (`expr_functions.rs`). Il motore tollera argomenti mancanti trattandoli come
> `null`: per questo la validazione dell'arità avviene nello studio.

### Stringhe (25)

| Funzione | Ritorno | Alias | Descrizione |
|---|---|---|---|
| `trim(s)` | string | — | Rimuove spazi iniziali e finali |
| `ltrim(s)` | string | `trimleft` | Rimuove spazi iniziali |
| `rtrim(s)` | string | `trimright` | Rimuove spazi finali |
| `upper(s)` | string | `touppercase` | Maiuscolo |
| `lower(s)` | string | `tolowercase` | Minuscolo |
| `length(s)` | integer | `len` | Lunghezza |
| `substring(s, inizio [, lunghezza])` | string | `substr` | Sottostringa (indice da 0) |
| `replace(s, cerca, sostituisci)` | string | — | Sostituisce tutte le occorrenze |
| `concat(a, b, …)` | string | — | Concatena |
| `concat_ws(sep, a, b, …)` | string | — | Concatena con separatore |
| `left(s, n)` | string | — | Primi n caratteri |
| `right(s, n)` | string | — | Ultimi n caratteri |
| `contains(s, sub)` | boolean | — | Vero se contiene |
| `starts_with(s, p)` | boolean | `startswith` | Vero se inizia con |
| `ends_with(s, p)` | boolean | `endswith` | Vero se finisce con |
| `pad_left(s, n [, car])` | string | `lpad`, `padleft` | Riempie a sinistra fino a n |
| `pad_right(s, n [, car])` | string | `rpad`, `padright` | Riempie a destra fino a n |
| `regex_match(s, pattern)` | boolean | `matches` | Vero se il pattern combacia |
| `capitalize(s)` | string | — | Prima lettera maiuscola |
| `title_case(s)` | string | `titlecase` | Ogni Parola Maiuscola |
| `remove_accents(s)` | string | `removeaccents` | Rimuove gli accenti |
| `to_slug(s)` | string | `toslug` | Testo-normalizzato-per-url |
| `replace_regex(s, pattern, sost)` | string | `replaceregex` | Sostituisce via espressione regolare |
| `mask_email(s)` | string | `maskemail` | m****@dominio.it |
| `mask_card(s)` | string | `maskcard` | Mostra solo le ultime 4 cifre |

### Numeri (14)

| Funzione | Ritorno | Alias | Descrizione |
|---|---|---|---|
| `abs(x)` | number | — | Valore assoluto |
| `round(x [, decimali])` | number | — | Arrotonda |
| `ceil(x)` | number | — | Arrotonda per eccesso |
| `floor(x)` | number | — | Arrotonda per difetto |
| `sqrt(x)` | number | — | Radice quadrata |
| `power(base, esp)` | number | `pow` | Elevamento a potenza |
| `min(a, b)` | polimorfo | — | Il minore |
| `max(a, b)` | polimorfo | — | Il maggiore |
| `sign(x)` | number | — | -1, 0 o 1 secondo il segno |
| `negate(x)` | number | — | Cambia segno |
| `clamp(x, min, max)` | polimorfo | — | Limita x nell'intervallo |
| `format_number(x, dec [, sep_dec [, sep_mig]])` | string | `formatnumber` | Formatta: format_number(x,2,",",".") → 1.234,56 |
| `log(x)` | number | `ln` | Logaritmo naturale |
| `log10(x)` | number | — | Logaritmo base 10 |

### Date e ora (24)

| Funzione | Ritorno | Alias | Descrizione |
|---|---|---|---|
| `now()` | datetime | `current_timestamp` | Data e ora correnti |
| `today()` | date | `current_date` | Data corrente |
| `date_format(d, formato)` | string | `formatdate` | Formatta una data |
| `year(d)` | integer | `getyear` | Anno |
| `month(d)` | integer | `getmonth` | Mese (1-12) |
| `day(d)` | integer | `getday` | Giorno del mese |
| `hour(d)` | integer | — | Ora (0-23) |
| `minute(d)` | integer | — | Minuti |
| `second(d)` | integer | — | Secondi |
| `quarter(d)` | integer | `getquarter` | Trimestre (1-4) |
| `day_of_week(d)` | integer | `getdayofweek` | Giorno settimana (0=domenica) |
| `is_weekend(d)` | boolean | `isweekend` | Vero se sabato o domenica |
| `add_days(d, n)` | date | `adddays` | Aggiunge n giorni |
| `add_months(d, n)` | date | `addmonths` | Aggiunge n mesi |
| `add_years(d, n)` | date | `addyears` | Aggiunge n anni |
| `diff_days(a, b)` | integer | `diffdays` | Giorni da a a b |
| `start_of_month(d)` | date | `startofmonth` | Primo giorno del mese |
| `end_of_month(d)` | date | `endofmonth` | Ultimo giorno del mese |
| `start_of_year(d)` | date | `startofyear` | Primo giorno dell'anno |
| `is_before(a, b)` | boolean | `isbefore` | Vero se a precede b |
| `is_after(a, b)` | boolean | `isafter` | Vero se a segue b |
| `to_unix_timestamp(d)` | integer | `tounixtimestamp` | Secondi dall'epoch |
| `to_unix_timestamp_ms(d)` | integer | `tounixtimestampms` | Millisecondi dall'epoch |
| `parse_date(testo [, formato])` | datetime | `parsedate` | Interpreta un testo come data |

### Conversioni / encoding / hash (12)

| Funzione | Ritorno | Alias | Descrizione |
|---|---|---|---|
| `to_string(x)` | string | `str`, `tostring` | Converte in stringa |
| `to_int(x)` | integer | `int`, `toint` | Converte in intero |
| `to_float(x)` | decimal | `float`, `todecimal` | Converte in decimale |
| `to_bool(x)` | boolean | `bool`, `tobool` | Converte in booleano |
| `url_encode(s)` | string | `urlencode` | Codifica per URL |
| `url_decode(s)` | string | `urldecode` | Decodifica da URL |
| `base64_encode(s)` | string | `base64encode` | Codifica in base64 |
| `base64_decode(s)` | string | `base64decode` | Decodifica da base64 |
| `hash_sha256(s)` | string | `hashsha256` | Impronta SHA-256 (esadecimale) |
| `to_json(x)` | string | `tojson` | Serializza in JSON |
| `hash_sha1(s)` | string | `hashsha1` | SHA-1 (deprecato, solo compatibilità) |
| `hash_sha512(s)` | string | `hashsha512` | Impronta SHA-512 |

### Logica e null (3)

| Funzione | Ritorno | Alias | Descrizione |
|---|---|---|---|
| `coalesce(a, b, …)` | polimorfo | `ifnull`, `nvl`, `coalesceempty` | Il primo valore non nullo |
| `nullif(a, b)` | polimorfo | — | null se a == b, altrimenti a |
| `iif(cond, se_vero, se_falso)` | polimorfo | `if` | Condizionale (equivale a cond ? a : b) |

### Strutture (oggetti/array JSON) (5)

| Funzione | Ritorno | Alias | Descrizione |
|---|---|---|---|
| `get(oggetto, chiave)` | any | — | Valore di una chiave |
| `get_path(oggetto, "a.b.0.c")` | any | `getpath` | Valore annidato per percorso |
| `keys(oggetto)` | object | — | Elenco delle chiavi |
| `values(oggetto)` | object | — | Elenco dei valori |
| `merge(a, b)` | object | — | Unisce due oggetti (b prevale) |

### Variabili di lane (1)

| Funzione | Ritorno | Alias | Descrizione |
|---|---|---|---|
| `var("nome")` | any | — | Legge una variabile di lane |


---

## 6. Template pronti

### 6.1 Template del nodo Script (20)
Nell'editor dello Script, il menu **⚡ template** inserisce esempi pronti,
raggruppati per tema. Usano **solo** funzioni che esistono nel motore (un
template che non gira insegnerebbe una sintassi sbagliata).

**Base**

- **Aggiungere campi** — Calcola campi nuovi; quelli che non tocchi passano invariati
- **Valori intermedi con let** — Calcoli d'appoggio che non finiscono nella riga in uscita
- **Condizione** — Rami diversi secondo il contenuto della riga
- **Filtrare (skip)** — Le righe che non interessano non escono da nessuna porta
- **Scartare con motivo (reject)** — Manda la riga sulla porta reject spiegando perche
- **Fallire (error)** — Ferma il nodo e manda l'errore all'error handler della lane

**Piu righe**

- **Una riga -> N copie** — Duplica ogni riga un numero di volte
- **Espandere un array** — Un campo che contiene un array JSON diventa una riga per elemento
- **Generare righe dal nulla** — Nodo di partenza: nessun ingresso, le righe le produce lui

**Stringhe**

- **Normalizzare** — Spazi, maiuscole, accenti
- **Mascherare dati sensibili** — Email e carte di credito offuscate
- **Estrarre e sostituire** — Sottostringhe, riempimenti, espressioni regolari

**Date**

- **Formattare una data** — Da data a stringa nel formato che serve
- **Calcoli sulle date** — Scadenze, differenze, trimestri

**Numeri**

- **Calcoli e arrotondamenti** — Sconti, totali, valori entro un intervallo
- **Difendersi dai valori mancanti** — Valori predefiniti e divisioni sicure

**Controlli**

- **Campi obbligatori** — Scarta le righe incomplete dicendo cosa manca
- **Formato di un campo** — Controlla la forma con un'espressione regolare
- **Chiave stabile** — Un'impronta riproducibile da piu campi

**Variabili di lane**

- **Leggere una variabile di lane** — Valori condivisi nella lane, letti con var()


### 6.2 Applicazione inline: preset e template per tipo di campo
Nel pannello **Transform** (e negli editor di campo di TMap) ogni campo parte da
un template scelto in base al **tipo del campo**. In tutto **129 template** su
stringhe, numeri, interi, decimali, booleani, date e strutture — per esempio:
*Trim*, *MAIUSCOLO*, *Slug*, *→ intero*, *Arrotonda 2 dec*, *Formato EU*,
*Maschera email*, *Hash SHA-256*, *Anno*, *Aggiungi giorni*, *Merge*,
*Se/Altrimenti*, e così via.

Oltre a questi, **6 preset universali** validi per ogni tipo:

| Preset | Effetto |
|---|---|
| `Passthrough` | Il valore passa invariato |
| `Null se vuoto` | `null` se stringa vuota o già null |
| `Coalesce` | Primo valore non nullo |
| `Espressione (expr)` | **Scrivi tu** l'espressione FPEL a mano |
| `Data → locale IT` | Formattazione data all'italiana |
| `Solo ora` | Estrae la sola ora |

I template inline usano due **segnaposto**, sostituiti al momento della
compilazione in FPEL:

- **`$value`** — il valore del campo sorgente;
- **`$param_<chiave>`** — un parametro del template (quando il template ne
  espone, es. il numero di decimali o un separatore).

Il preset **`Espressione (expr)`** è la via per l'uso libero: scrivi
un'espressione FPEL qualsiasi, con `$value` a rappresentare il valore in
ingresso.

---

## 7. Gli editor

### 7.1 Editor completo (nodo Script)
Un editor **Monaco** con il linguaggio FPEL dichiarato per quello che è
(grammatica propria, non più "presa in prestito" da Rust):

- **Evidenziazione** di istruzioni, operatori-parola (`and`/`or`/`not`/`is`/…),
  funzioni del catalogo, stringhe, numeri, commenti — con un tema scuro dedicato.
- **Completamento contestuale**: propone i **campi** in ingresso e le
  **variabili di lane** correnti, oltre alle funzioni. Il contesto viene
  aggiornato dall'editor (Monaco registra i provider una volta per linguaggio).
- **Chip e pill** attorno all'editor: chip che inseriscono le **istruzioni**;
  pill che inseriscono i nomi dei **campi** (ingresso/uscita/reject) e delle
  **variabili di lane** — si clicca, non si scrive a memoria.
- **Selettore ⚡ template** (§6.1).
- **Validazione dal vivo**: il pannello di validazione mostra gli errori di
  sintassi con il **numero di riga**, e alcuni avvisi mirati (es. un generatore
  che non emette righe, una `var` letta ma mai dichiarata). La grammatica Monaco
  è puramente lessicale, quindi **non contraddice mai il parser**: a decidere se
  il corpo è valido è `scriptParser`, non l'evidenziatore.

L'editor supporta anche l'inserimento di snippet e il *wrap* della selezione con
una funzione (es. avvolgere il testo selezionato in `date_format(…)`).

### 7.2 Applicazione inline
Nei nodi a espressione singola l'esperienza è più leggera: una riga per campo,
il **template per tipo** come punto di partenza, e il preset **`expr`** per
scrivere a mano. La stessa grammatica di espressioni, gli stessi campi e le
stesse funzioni — solo senza la cornice delle istruzioni.

---

## 8. Tipi e inferenza
Ogni espressione ha un **tipo inferito** (`string`, `integer`, `decimal`,
`boolean`, `date`, `datetime`, `object`, o `any` quando non determinabile).
L'inferenza serve allo schema di uscita e ai controlli: per esempio, lo schema
d'uscita di uno Script è "ingresso + campi assegnati", con il **tipo** di ogni
campo nuovo dedotto dall'espressione che lo produce.

Due punti utili:

- Le funzioni marcate **`polimorfo`** (`min`, `max`, `clamp`, `coalesce`,
  `nullif`, `iif`) restituiscono un tipo che **dipende dagli argomenti**: per
  esempio `iif(cond, 1, 2)` è intero, `iif(cond, "a", "b")` è stringa.
- L'operatore **`+`** è `ADD` nell'IR, ma il motore **concatena** se un operando
  è stringa: l'inferenza segue la stessa regola (stringa se un lato è stringa,
  altrimenti numerico). In dubbio, `to_string(...)` o `cast(x as string)`
  rendono l'intento esplicito.

---

## 9. Architettura (per chi tocca il codice)
- **Parser nello studio, IR al motore.** `exprParser.ts` (espressioni) e
  `scriptParser.ts` (istruzioni) compilano il testo in IR (`ExprNode`,
  `ScriptStmt`); il motore Rust valuta l'IR e **non conosce** la sintassi. Il
  codegen (futuro) traduce l'IR, mai il testo.
- **Fonte unica delle funzioni.** `src/ir/functions.ts` è il catalogo (nomi,
  alias, arità, tipi di ritorno) allineato **una-a-una** a
  `src-tauri/src/engine/expr_functions.rs`. Chi aggiunge una funzione nel motore
  la aggiunge qui, altrimenti la validazione la rifiuta.
- **File chiave**: `src/ir/exprParser.ts`, `src/ir/scriptParser.ts`,
  `src/ir/exprTypes.ts` (inferenza), `src/ir/functions.ts` (catalogo);
  `src/transforms/catalog.ts` + `presets.ts` + `templateCompiler.ts` (inline);
  `src/nodes/types/script/templates.ts` (template Script);
  `src/components/ScriptEditor/` (editor Monaco + `flowpilotLanguage.ts`);
  lato motore `engine/nodes/script.rs`, `engine/expr.rs`,
  `engine/expr_functions.rs`. Disegni in `src-tauri/docs/`
  (`design-nodo-script.md`, `design-linguaggio-espressioni.md`).

---

*Manuale del linguaggio FPEL — nucleo di espressioni, istruzioni del nodo
Script, 84 funzioni preconfezionate e i template inline e completi. Allineato al
codice del repo; le firme delle funzioni sono generate dal catalogo reale.*
