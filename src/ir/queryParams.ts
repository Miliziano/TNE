// ─── src/ir/queryParams.ts ─────────────────────────────────────────
//
// R8, seconda metà — i parametri di query.
// Contratto: `src-tauri/docs/contratto-porte.md` R8 e §10.
//
// PERCHÉ STA NELLO STUDIO E NON NEL MOTORE.
//
// FPEL è già diviso così: `src/ir/exprParser.ts` PARSA e mette l'albero
// nel piano (`expressions: ExprNode[]`); `src-tauri/src/engine/expr.rs`
// VALUTA un albero già pronto. Il motore non vede mai la sintassi.
// Questo file rispetta lo stesso patto: la sintassi `${campo}` si legge
// QUI, una volta sola, e nel motore arriva già compilata. Scriverne un
// secondo parser in Rust sarebbe la sesta copia dello stesso fatto — e
// ne abbiamo appena tolte cinque dalle porte.
//
// Ed è anche la ragione per cui `${campo}` è stato scelto al posto di
// `:param` nativo di sqlx: se la sintassi la legge lo studio, lo studio
// può dire **in design** «questo campo non esiste nello schema in
// arrivo», invece di scoprirlo quando la query esplode contro il DB.
//
// IL PLACEHOLDER È NEUTRO, la dialettica resta al motore.
// Postgres vuole `$1, $2`, MySQL e SQLite vogliono `?`. Qui si emette
// sempre `?` e l'ordine dei bind; è il motore — che ha in mano il pool e
// quindi SA il dialetto per certo — a rinumerare. Se il dialetto lo
// decidessimo qui, lo dedurremmo dalla config: vera finché l'utente non
// cambia risorsa.

/** Query compilata: SQL con placeholder neutri + i campi da legare, in ordine. */
export interface CompiledQuery {
  /** SQL con ogni `${campo}` sostituito da `?`. */
  sql: string
  /** I nomi dei campi, **nell'ordine dei placeholder**. */
  binds: string[]
}

/**
 * `${` + nome + `}`. Il nome è un identificatore semplice.
 *
 * NB non collide con i placeholder di Postgres (`$1`, `$2`): quelli sono
 * `$` + cifra, questi `$` + graffa. Un `$1` scritto a mano dall'utente
 * passa verbatim — che è giusto, non è affar nostro.
 */
const PARAM_RE = /\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/g

/**
 * Compila i `${campo}` di una query in placeholder + lista di bind.
 *
 * Totale: non lancia. Quello che non è un parametro ben formato resta
 * verbatim (`${1}`, `${ }`, `${a-b}` non sono nomi validi e passano
 * intatti al DB, che protesterà lui). Chi valida usa `queryParamNames`.
 *
 * Lo stesso campo citato due volte produce **due** bind: i placeholder
 * sono posizionali e ognuno vuole il suo valore. Deduplicarli
 * risparmierebbe un bind e costerebbe un bug.
 */
export function compileQueryParams(query: string): CompiledQuery {
  const binds: string[] = []
  const sql = query.replace(PARAM_RE, (_m, name: string) => {
    binds.push(name)
    return '?'
  })
  return { sql, binds }
}

/** I campi citati da una query, senza ripetizioni e in ordine di prima apparizione. */
export function queryParamNames(query: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of query.matchAll(PARAM_RE)) {
    const name = m[1]
    if (!seen.has(name)) { seen.add(name); out.push(name) }
  }
  return out
}

/** true se la query cita almeno un parametro. */
export const queryHasParams = (query: string): boolean => queryParamNames(query).length > 0

/**
 * `${campo}` messo fra apici: `WHERE s = '${nome}'`.
 *
 * È la trappola naturale di chi arriva dall'interpolazione, dove gli apici
 * SERVONO. Qui no: il parametro viene **legato**, e gli apici li mette il
 * driver. Scritto così diventerebbe `s = '?'`, cioè il confronto con la
 * stringa "?" — e resterebbe un bind senza posto dove andare, quindi un
 * errore del driver a runtime. Nessuna delle due cose è ciò che l'utente
 * voleva, e nessuna delle due lo dice.
 *
 * Riconosce il caso diretto (parametro subito dentro una coppia di apici),
 * che è quello che si scrive per sbaglio. Non fa il parsing dell'SQL: un
 * `${x}` sepolto dentro un letterale lungo non lo vede. Meglio prendere il
 * 95% e dirlo, che pretendere il 100% e tacere.
 */
export function quotedParamNames(query: string): string[] {
  const out: string[] = []
  for (const m of query.matchAll(/'\s*\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\s*'/g)) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}
