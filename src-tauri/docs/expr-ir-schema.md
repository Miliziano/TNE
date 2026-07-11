# FlowPilot — Contratto di serializzazione dell'IR delle espressioni

Questo documento è il **gemello di `design-linguaggio-espressioni.md`**
sul lato serializzazione. Quello descrive la grammatica FPEL e come lo
studio la compila in `ExprNode` (l'IR); questo norma la **forma JSON**
con cui l'IR viaggia nel plan, così che ogni consumatore la ricostruisca
allo stesso modo.

È un **contratto**, come `node-spec.md` e `monitoring-schema.md`. I
consumatori sono:

- il **motore live Rust** (`src-tauri/src/engine/expr.rs`), che
  deserializza l'IR e lo valuta;
- i futuri **generatori di codice** (Rust, Java, Python) per artifact
  headless, che traducono lo stesso IR in codice del target.

**Perché un contratto e non un dettaglio interno.** Se il testo FPEL
viaggiasse grezzo, ogni target dovrebbe reimplementare il parser FPEL:
tre parser (Rust, Java, Python) da tenere sincronizzati sulla stessa
grammatica, che divergono in silenzio. Con l'IR, **lo studio compila una
volta** e ogni target si limita a *tradurre un albero già strutturato* —
operazione meccanica e non ambigua. L'IR è quindi il formato di
interscambio tra "chi compila" (lo studio, uno solo) e "chi esegue o
genera" (motore + N generatori). Perché la traduzione sia possibile,
la forma JSON dev'essere normata: è questo documento.

---

## 1. Principi

1. **Tag esterno su `kind`.** Ogni nodo IR è un oggetto con un campo
   discriminante `kind` (PascalCase) che ne dà il tipo; gli altri campi
   dipendono dal tipo. Un consumatore fa dispatch su `kind`.
2. **Alias camelCase tollerati.** Il deserializzatore accetta anche la
   forma camelCase del `kind` (`binaryOp` oltre a `BinaryOp`) e degli
   operatori (`add` oltre a `ADD`). La forma **canonica emessa** è
   PascalCase per `kind`, MAIUSCOLA per gli operatori. Un generatore
   dovrebbe normalizzare in ingresso e non dipendere dal casing.
3. **Espressioni pure.** L'IR non ha effetti collaterali (invariante di
   FPEL). Un traduttore può assumere che valutare un nodo non modifichi
   stato: nessun ordine di valutazione imposto oltre a quello dei figli.
4. **Ricorsivo e finito.** I figli (`left`, `right`, `expr`, `args`,
   `branches`) sono a loro volta nodi IR. Nessun ciclo (è un albero).
5. **Evoluzione.** Un nuovo `kind` o un nuovo operatore è additivo: i
   consumatori ignoti devono fallire con errore parlante ("kind IR
   sconosciuto: X"), mai degradare a un default silenzioso.

---

## 2. I nodi (`kind`)

Ogni tabella dà: la forma JSON, i campi, e la resa attesa dal codegen.

### `Literal` — valore costante
```json
{ "kind": "Literal", "value": 42 }
```
`value` è un letterale JSON *untagged*: `null`, un booleano, un intero,
un float o una stringa. Il traduttore emette la costante nel tipo
corrispondente del target (attenzione a int vs float).

### `DirectFieldRef` — campo della riga corrente (input singolo)
```json
{ "kind": "DirectFieldRef", "field": "prezzo" }
```
Usato dai nodi a un solo input (filter, aggregate, transform). Il
traduttore emette l'accesso al campo `field` della riga corrente.

### `FieldRef` — campo di un input specifico (multi-input)
```json
{ "kind": "FieldRef", "input": "main", "field": "prezzo" }
```
Usato dal TMap (input `main`, `lookup_1`, …). Il traduttore emette
l'accesso al campo `field` della riga dell'input `input`.

### `BinaryOp` — operazione binaria
```json
{ "kind": "BinaryOp", "op": "ADD",
  "left":  { …IR… },
  "right": { …IR… } }
```
`op` è un operatore binario (§3). `left`/`right` sono nodi IR. Vedi §3
per la semantica di ciascun operatore (in particolare `ADD` e `null`).

### `UnaryOp` — operazione unaria
```json
{ "kind": "UnaryOp", "op": "NOT", "expr": { …IR… } }
```
`op` ∈ `NOT` | `NEG`. `NOT` = negazione logica, `NEG` = negazione
aritmetica (`-x`).

### `FunctionCall` — chiamata a funzione del catalogo
```json
{ "kind": "FunctionCall", "name": "upper", "args": [ { …IR… } ] }
```
`name` è il nome canonico della funzione (catalogo in
`design-linguaggio-espressioni.md §5`). `args` è la lista degli
argomenti (nodi IR). Il traduttore mappa `name` sulla funzione
equivalente del target, o su un helper di runtime se non esiste nativa.

### `CaseWhen` — multi-ramo
```json
{ "kind": "CaseWhen",
  "branches": [
    { "condition": { …IR… }, "value": { …IR… } },
    { "condition": { …IR… }, "value": { …IR… } }
  ],
  "default": { …IR… } }
```
`branches` valutati in ordine: il primo con `condition` vera dà `value`.
`default` (opzionale, può mancare o essere `null`) è il valore se nessun
ramo matcha; assente → `null`. Traduce a `if/elif/else` o a un
`switch`-espressione.

### `Cast` — conversione di tipo
```json
{ "kind": "Cast", "expr": { …IR… }, "targetType": "integer" }
```
`targetType` ∈ `string` | `integer` | `float` | `boolean` | `date`.
Nota: il campo JSON è **`targetType`** (camelCase), non `target_type`.

### `FieldAccess` — accesso a campo annidato (oggetti/JSON)
```json
{ "kind": "FieldAccess", "expr": { …IR… }, "field": "citta" }
```
Estrae `field` dal valore-oggetto prodotto da `expr`.

### `IsNull` / `IsNotNull` — test di nullità
```json
{ "kind": "IsNull",    "expr": { …IR… } }
{ "kind": "IsNotNull", "expr": { …IR… } }
```

### `Coalesce` — primo non-null
```json
{ "kind": "Coalesce", "args": [ { …IR… }, { …IR… } ] }
```
Primo argomento non-null, valutati in ordine. (È anche esprimibile come
`FunctionCall name="coalesce"`; questa è la forma nodo dedicata.)

---

## 3. Operatori binari (`op` di `BinaryOp`)

Forma canonica MAIUSCOLA; alias PascalCase e camelCase accettati.

| `op`       | Significato            | Note di semantica                                    |
|------------|------------------------|------------------------------------------------------|
| `ADD`      | addizione / concat     | **Vedi sotto.** Non è un `+` puro.                   |
| `SUB`      | sottrazione            | Solo aritmetico; operandi non numerici → `null`.     |
| `MUL`      | moltiplicazione        | idem                                                  |
| `DIV`      | divisione              | idem                                                  |
| `MOD`      | modulo                 | idem                                                  |
| `EQ` `NE`  | uguaglianza            |                                                      |
| `LT` `LTE` | minore / min-uguale    |                                                      |
| `GT` `GTE` | maggiore / magg-uguale |                                                      |
| `AND` `OR` | logici                 | corto-circuito                                        |
| `CONCAT`   | concatenazione esplicita | sempre stringa                                     |
| `COALESCE` | primo non-null (binario) |                                                     |

**Semantica di `ADD` (da normare identica su ogni target).** Come da
FPEL: se almeno un operando è stringa → **concatenazione**; altrimenti
somma aritmetica (Int/Float/Decimal); se l'aritmetica non è possibile
(null o tipi non numerici) → **`null`** (semantica SQL). Il traduttore
NON deve emettere un `+` nativo che, sui null del target, si comporti
diversamente (es. Java: `null + 5` lancia NPE o concatena "null5"): serve
un helper di runtime che replichi la regola. **Nota:** nel motore live
esiste un TODO (`docs/TODO.md`) su `Add` che oggi concatena in silenzio
invece di dare `null` — va allineato a questa semantica *prima* di
generare codice, altrimenti motore live e artifact divergono.

---

## 4. Valori letterali (`value` di `Literal`)

Serializzati *untagged*: il tipo si deduce dalla forma JSON.

| JSON            | Tipo interno          | Note                                  |
|-----------------|-----------------------|---------------------------------------|
| `null`          | Null                  |                                       |
| `true`/`false`  | Bool                  |                                       |
| `42`            | Int (i64)             | intero senza parte decimale           |
| `3.14`          | Float (f64)           | con parte decimale/esponente          |
| `"testo"`       | String                |                                       |

Attenzione codegen: `42` e `42.0` hanno tipo diverso (Int vs Float). Un
target che non distingue (es. JS) deve preservare comunque la semantica
aritmetica attesa (Decimal esatto dove serve — v. node-spec §3 tipi DB).

---

## 5. Mappatura sintassi → IR → JSON (riferimento rapido)

Estende la tabella di `design-linguaggio-espressioni.md` con la colonna
JSON.

| FPEL              | `kind`           | Forma JSON (schematica)                                  |
|-------------------|------------------|----------------------------------------------------------|
| `42`, `"x"`, `null` | `Literal`      | `{kind:Literal, value:…}`                                |
| `campo`           | `DirectFieldRef` | `{kind:DirectFieldRef, field:"campo"}`                   |
| `Input.campo`     | `FieldRef`       | `{kind:FieldRef, input:"Input", field:"campo"}`          |
| `a + b`           | `BinaryOp`       | `{kind:BinaryOp, op:"ADD", left:…, right:…}`             |
| `!x` / `-x`       | `UnaryOp`        | `{kind:UnaryOp, op:"NOT"/"NEG", expr:…}`                 |
| `f(a,b)`          | `FunctionCall`   | `{kind:FunctionCall, name:"f", args:[…]}`                |
| `var("x")`        | `FunctionCall`   | `{kind:FunctionCall, name:"var", args:[{Literal "x"}]}`  |
| `c ? a : b`       | `FunctionCall`   | `{kind:FunctionCall, name:"iif", args:[c,a,b]}`          |
| `case when…end`   | `CaseWhen`       | `{kind:CaseWhen, branches:[…], default:…}`               |
| `x is null`       | `IsNull`         | `{kind:IsNull, expr:…}`                                  |
| `cast(x as t)`    | `Cast`           | `{kind:Cast, expr:…, targetType:"t"}`                    |

---

## 6. Requisiti minimi per un generatore

Un codegen (Java/Python/…) che traduce l'IR deve:

1. fare dispatch su `kind`, con **errore parlante** su un `kind` ignoto
   (mai silenzio);
2. normalizzare il casing di `kind` e degli operatori in ingresso;
3. implementare la semantica di `ADD` con l'helper di runtime (non il `+`
   nativo del target);
4. propagare `null` in aritmetica (SQL-like), non lanciare eccezioni;
5. preservare la distinzione Int/Float dei letterali;
6. tradurre `FunctionCall` mappando `name` sul catalogo del target o su
   helper di runtime equivalenti.

Finché queste sei regole valgono, l'artifact generato calcola le stesse
espressioni del motore live, byte per byte sui casi normati.
