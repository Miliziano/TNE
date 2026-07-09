# FlowPilot Expression Language (FPEL) — grammatica

Linguaggio unico di espressioni, condiviso da TUTTI i nodi che valutano
espressioni (tmap, transform, filter, data_quality, join custom, ecc.).

Stile: **C/JS-like**, con ibridazioni utili dove giovano alla leggibilità
in contesto ETL.

Compilato in `ExprNode` (IR) dallo studio; il motore Rust esegue l'IR.
Il codegen (Rust/Java/Python) traduce l'IR, mai il testo.

## Invariante fondamentale
**Le espressioni sono PURE**: calcolano un valore, non modificano stato.
Effetti collaterali (scrittura variabili, contatori) sono dichiarati
nella *config del campo*, non nell'espressione. Necessario per il codegen.

---

## 1. Letterali

    42          -3.14       intero / decimale
    "testo"     'testo'     stringa (doppi o singoli apici)
    true false              booleani
    null                    valore nullo

## 2. Riferimenti a campi

    campo                   campo della riga corrente (input singolo)
    Input.campo             campo di un input specifico (tmap multi-input)
    "Nome Input".campo      input il cui nome contiene spazi

## 3. Variabili di lane

    var("nome")             lettura di una variabile di lane

Lettura pura. Se la variabile non esiste → `null` (nessun default inventato).
La *scrittura* NON è un'espressione: si dichiara nel pannello del campo.

## 4. Operatori (precedenza dalla più bassa alla più alta)

    ||   or                 OR logico
    &&   and                AND logico
    ==  !=                  uguaglianza
    <  <=  >  >=            confronto
    +  -                    addizione / sottrazione
    *  /  %                 moltiplicazione / divisione / modulo
    !  -                    NOT logico, negazione unaria (prefissi)
    ()                      parentesi

### Semantica di `+` (importante)
- Se **almeno uno** degli operandi è stringa → **concatenazione**
  (`"Ordine " + 42` → `"Ordine 42"`)
- Altrimenti → **somma aritmetica** (Int, Float, Decimal esatto)
- Se l'aritmetica non è possibile (null, tipi non numerici) → `null`
  (semantica SQL: `5 + null` → `null`)

`-  *  /  %` sono **solo aritmetici**: con operandi non numerici → `null`.

### Ibridazione utile
`||` è OR logico (JS-like). Per concatenare si usa `+` o `concat()`.

## 5. Chiamate di funzione

    nome(arg1, arg2, ...)

Annidabili: `upper(trim(nome))`, `substring(concat(a, b), 1, 10)`.

### Catalogo (motore Rust, con alias)

**Stringhe**
    trim(s)   ltrim(s)   rtrim(s)
    upper(s)  lower(s)
    length(s) | len(s)
    substring(s, start, len) | substr(...)
    replace(s, cerca, sostituisci)
    concat(a, b, ...)
    concat_ws(sep, a, b, ...)
    left(s, n)   right(s, n)
    contains(s, sub)   starts_with(s, p)   ends_with(s, p)
    pad_left(s, n, c) | lpad(...)
    pad_right(s, n, c) | rpad(...)
    regex_match(s, pattern)

**Numeri**
    abs(x)  round(x[, dec])  ceil(x)  floor(x)  sqrt(x)
    power(b, e) | pow(...)
    min(a, b)   max(a, b)

**Conversioni**
    to_string(x) | str(x)
    to_int(x)    | int(x)
    to_float(x)  | float(x)
    to_bool(x)   | bool(x)

**Date**
    now() | current_timestamp()
    today() | current_date()
    date_format(d, fmt)
    year(d)  month(d)  day(d)  hour(d)  minute(d)  second(d)

**Logica / null**
    coalesce(a, b, ...) | ifnull(a, b) | nvl(a, b)
    nullif(a, b)
    iif(cond, se_vero, se_falso) | if(...)

**Variabili**
    var("nome")

## 6. Costrutti condizionali

Forma funzione (già supportata dal motore):

    iif(prezzo > 100, "alto", "basso")

Forma ternaria (ibridazione JS, zucchero per `iif`):

    prezzo > 100 ? "alto" : "basso"

Forma multi-ramo (ibridazione SQL, compila in `ExprNode::CaseWhen`):

    case when prezzo > 100 then "alto"
         when prezzo > 50  then "medio"
         else "basso" end

## 7. Test di nullità (ibridazione SQL, più leggibile di `== null`)

    x is null
    x is not null

Equivalenti a `ExprNode::IsNull` / `IsNotNull`.
`x == null` resta valido (JS-like).

## 8. Cast (ibridazione SQL, zucchero per le funzioni to_*)

    cast(x as integer)      ≡ to_int(x)
    cast(x as string)       ≡ to_string(x)
    cast(x as float)        ≡ to_float(x)
    cast(x as boolean)      ≡ to_bool(x)
    cast(x as date)         ≡ date(x)

---

## Mappatura su ExprNode (IR)

| Sintassi | ExprNode |
|---|---|
| `42`, `"x"`, `null` | `Literal` |
| `campo` | `DirectFieldRef` |
| `Input.campo` | `FieldRef { input, field }` |
| `a + b` | `BinaryOp { op: Add }` |
| `!x`, `-x` | `UnaryOp { op: Not/Neg }` |
| `f(a, b)` | `FunctionCall { name, args }` |
| `var("x")` | `FunctionCall { name: "var", args: [Literal] }` |
| `c ? a : b` | `FunctionCall { name: "iif", args: [c, a, b] }` |
| `case when…end` | `CaseWhen { branches, default }` |
| `x is null` | `IsNull` |
| `cast(x as t)` | `Cast { expr, target }` |

## Errori di parsing

Il parser **non** deve mai degradare silenziosamente un'espressione non
valida a `Literal` (comportamento attuale, causa di bug: `upper(x)` finiva
in una colonna come la stringa `"upper(x)"`).

Un'espressione non parsabile è un **errore di compilazione del flusso**,
mostrato all'utente nel pannello, e blocca l'esecuzione.

## Non supportato (per scelta)
- Assegnamenti (`x = 1`) — le espressioni sono pure
- Cicli, blocchi, dichiarazioni
- JavaScript arbitrario (non traducibile in Rust/Java/Python)
- Accesso a proprietà annidate con `.` su oggetti (usa `FieldAccess` esplicito)
