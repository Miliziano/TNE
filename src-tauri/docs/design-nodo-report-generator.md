# Disegno — nodo `report_generator` in Rust

> Riferimento TS: `src/runner/reportGeneratorExecutor.ts` (688 righe). Come per lo
> Script (`design-nodo-script.md`), NON si traduce riga per riga: il runner è
> Node/TypeScript e usa `toLocaleString`, `Date`, SheetJS. Si mappa la
> **funzionalità** su strumenti Rust e si prendono le decisioni qui.

## 1. Cosa fa il nodo (inventario dal runner)

`report_generator` **consuma tutte le righe in ingresso** (`requiresCompleteInput:
true`) e **emette UNA riga** che descrive un artefatto generato:

```
{ content, content_type, filename, row_count, generated_at, template, format }
```

`content` è la stringa HTML oppure il base64 di un `.xlsx`. La riga va poi tipicamente
a un `sink_file` (che la scrive) o a un `mail_sink` (che la spedisce). Nel grafo il nodo
è già dichiarato `NEEDS_ROWS` (dagValidation) e bufferizza come `aggregate`/`window`.

### Config (props del nodo)
- `outputFormat`: `html` | `excel`
- `templateId`: `table` | `summary` | `bar_chart` | `line_chart` | `pie_chart` | `mixed`
- `columns` (JSON `ColumnConfig[]`): `{ field, label, type: text|number|currency|date,
  total: sum|avg|count|none, rules: CellRule[] }`. Se vuoto → colonne dedotte dalle
  chiavi della prima riga (escluso il campo DQ).
- `reportTitle`, `reportSubtitle`, `filename`, `logoUrl`
- `colorTheme`: `blue` | `green` | `dark` | `orange` | `custom` (+ `primaryColor`,
  `accentColor`)
- `kpiFields` (CSV), `chartXField`, `chartYField`, `chartTitle`
- `locale`: `it` | `en` (formattazione numeri/valuta/date)
- `dqField`: default `_dq` (integrazione col punteggio di data_quality)

### Le funzionalità, per peso
1. **Formattazione cella** (`formatCell`): per tipo e locale. `currency` → EUR/USD;
   `number` → separatori locali; `date` → data locale; null → `—`.
2. **Tabella HTML** (`buildTable`): intestazioni, righe zebra a tema, riga dei
   **totali** (sum/avg/count per colonna), colonna **DTS** se c'è il campo DQ.
3. **Formattazione condizionale** (`CellRule`): condizione (`lt/gt/eq/contains/
   is_null/custom…`) su un campo → stile (preset `danger/warning/success/info` o
   bg/testo custom) applicato alla **cella** o all'intera **riga**, con icona
   opzionale (↑ ↓ ⚠ ✓ ● ★).
4. **Temi** (`THEMES`): 4 preset + custom (colori primario/accento).
5. **Card KPI** (`buildSummary`): per ogni `kpiField`, somma se numerico / conteggio
   distinti se testo.
6. **Grafici SVG** (`buildBarChart`/`buildLineChart`/`buildPieChart`): inline, senza
   librerie — pura costruzione di stringhe SVG.
7. **Guscio HTML** (`buildHTML`): `<!DOCTYPE>` completo, header con titolo/sottotitolo/
   logo/data/conteggio, `@media print`.
8. **Excel** (`buildExcel`): **solo dati** (intestazione + righe), nessuno stile, via
   SheetJS → base64.

## 2. Mappatura su Rust

| Parte | In Rust |
|---|---|
| HTML + SVG (tabella, temi, regole, KPI, grafici, guscio) | costruzione di stringhe con `format!`. **Nessun crate**, ma è la mole maggiore. |
| Excel | crate **`rust_xlsxwriter`** (puro Rust, nessuna dipendenza C, mantenuto). Il runner scrive solo dati → uso semplice: intestazione + celle. |
| Formattazione locale (valuta/numero/data) | a mano + `chrono` per le date. `it`: migliaia `.`, decimali `,`, valuta `€`. Non c'è `toLocaleString` in Rust → si scrive (poco codice, isolato in un `format_cell`). |
| Modello del nodo | `requiresCompleteInput` → il nodo **raccoglie tutte le righe** dal receiver, poi emette 1 riga. Stesso schema di `aggregate`/`window` nel motore. |

L'HTML è deterministico e testabile: date le stesse righe + config → stessa stringa
(fissando `generated_at`), quindi si prova senza servizi esterni. È il motivo per cui
è un buon primo nodo di questa fase malgrado la mole.

## 3. Decisioni da prendere

1. **Formato dell'output del nodo** — mirror del runner: emette la riga
   `{content, content_type, filename, …}` e NON scrive su disco (lo fa un `sink_file`
   a valle). *Raccomandato: sì, mirror* — coerente col resto, e tiene il nodo puro.
2. **Crate Excel** — `rust_xlsxwriter`. Aggiunge una dipendenza in `Cargo.toml`
   (crates.io è raggiungibile al build). *Raccomandato: sì.*
3. **Ampiezza di v1 / fette** (v. §4) — il nodo è grosso; propongo di NON portarlo
   tutto in un colpo ma a fette, come lo Script. *Raccomandato.*

## 4. Fette proposte

- **Fetta 1 — la spina.** `outputFormat` **excel** (solo dati, quasi gratis) +
  template **`table`** in HTML: colonne tipizzate, `formatCell` (it/en), riga dei
  **totali**, temi, guscio HTML con header. Nessuna regola condizionale, nessun
  grafico, nessuna KPI. Già utile: produce il report tabellare che copre la maggior
  parte dei casi. Testabile su stringa.
- **Fetta 2 — la ricchezza della tabella.** Formattazione condizionale (`CellRule`,
  cella/riga, preset + custom, icone) + integrazione **DQ** (colonna DTS, stile per
  riga) + card **KPI** (`summary`).
- **Fetta 3 — i grafici.** `bar_chart` / `line_chart` / `pie_chart` come SVG + template
  **`mixed`**. È la parte più voluminosa e la meno essenziale (un report è utile anche
  senza), quindi ultima.

## 5. Cosa NON fa v1 (dichiarato)

- Niente PDF: il runner non lo fa (solo HTML + Excel). Se servirà, è un passo suo
  (richiederebbe un motore di rendering o un crate PDF).
- L'Excel resta **solo dati** anche a regime: il runner non stila il foglio, e
  replicare in xlsx la formattazione condizionale dell'HTML sarebbe un secondo motore
  di stile. Chi vuole il report ricco usa `html`.
- I `custom`/`expression` delle `CellRule` (condizione arbitraria `row.campo > x`) nel
  runner girano come JS: in Rust si valutano con **FPEL** (`parseExpression` lato studio
  → IR → `expr.rs`), coerente con lo Script. Da confermare in Fetta 2.

## 6. Rischi / da verificare in implementazione

- `rust_xlsxwriter`: confermare l'API di scrittura in memoria → base64 (non su file).
- Formattazione valuta `it`: `€ 1.234,56` — attenzione a separatori e posizione del
  simbolo; isolare in un solo posto con test.
- Grandi report: `content` è una stringa (base64 xlsx o HTML) dentro una riga — ok per
  il modello, ma tenerlo a mente per report enormi.
