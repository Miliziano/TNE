/**
 * src/components/ScriptEditor/flowpilotLanguage.ts
 *
 * Grammatica Monaco per il linguaggio del nodo Script.
 *
 * Prima si prendeva in prestito quella di Rust: le parole chiave
 * coincidono quasi tutte e — soprattutto — è una grammatica puramente
 * lessicale, quindi non segnava in rosso codice valido come farebbe
 * quella di TypeScript. Funzionava, ma restava un ripiego: `emit`,
 * `skip`, `reject` non erano evidenziati, e le funzioni FPEL nemmeno.
 *
 * Qui il linguaggio è dichiarato per quello che è. Monarch è puramente
 * lessicale anche lui: nessuna analisi semantica, quindi resta vero che
 * l'editor non può contraddire il parser — chi decide se il corpo è
 * valido è `scriptParser.ts`, e lo dice il pannello Validazione.
 */

import { FUNCTIONS } from '../../ir/functions'

export const FLOWPILOT_LANG_ID = 'flowpilot'

/** Le istruzioni del linguaggio (v. design-nodo-script.md §3.1). */
const ISTRUZIONI = [
  'let', 'if', 'else', 'repeat', 'for', 'in', 'as',
  'emit', 'skip', 'reject', 'log', 'error',
]

/** Operatori-parola di FPEL, evidenziati come le istruzioni ma distinti. */
const OPERATORI_PAROLA = ['and', 'or', 'not', 'is', 'null', 'true', 'false']

/**
 * Contesto corrente per il completamento. È mutabile e aggiornato
 * dall'editor: Monaco registra i provider UNA volta per linguaggio, non
 * per istanza, quindi il provider non può chiudere sulle props di un
 * componente — leggerebbe quelle del primo editor montato.
 */
let contesto: { campi: string[]; variabili: string[] } = { campi: [], variabili: [] }

export function aggiornaContestoFlowpilot(campi: string[], variabili: string[]): void {
  contesto = { campi, variabili }
}

let registrato = false

/**
 * Registra linguaggio, grammatica e completamento. Idempotente: Monaco è
 * globale e `onMount` scatta a ogni editor montato.
 */
export function registerFlowpilotLanguage(monaco: any): void {
  if (registrato) return
  registrato = true

  monaco.languages.register({ id: FLOWPILOT_LANG_ID })

  monaco.languages.setLanguageConfiguration(FLOWPILOT_LANG_ID, {
    comments:        { lineComment: '//' },
    brackets:        [['{', '}'], ['(', ')'], ['[', ']']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
    ],
  })

  monaco.languages.setMonarchTokensProvider(FLOWPILOT_LANG_ID, {
    defaultToken: '',
    istruzioni:   ISTRUZIONI,
    paroleOp:     OPERATORI_PAROLA,
    funzioni:     FUNCTIONS.map((f) => f.name),

    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],

        // Nome seguito da `(` → chiamata di funzione. Si distingue quella
        // conosciuta da quella che non esiste: un nome sbagliato resta
        // grigio invece di sembrare valido. NB è solo un indizio visivo —
        // a dire se la funzione esiste davvero è la validazione.
        // I nomi dei token sono quelli che il tema dell'editor dichiara
        // (THEME_DEF in index.tsx): 'function', 'keyword', 'identifier'…
        // Un token inventato non colora niente e sembrerebbe che la
        // grammatica non funzioni.
        [/[a-zA-Z_][\w]*(?=\s*\()/, {
          cases: {
            '@funzioni': 'function',
            '@default':  'identifier',
          },
        }],

        [/[a-zA-Z_][\w]*/, {
          cases: {
            '@istruzioni': 'keyword',
            '@paroleOp':   'keyword',
            '@default':    'identifier',
          },
        }],

        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        // Stringa non chiusa: resta colorata come stringa fino a fine
        // riga. A dire che è un errore è il pannello Validazione, che
        // legge il parser vero — l'editor non deve dare un secondo
        // parere che potrebbe contraddirlo.
        [/"([^"\\]|\\.)*$/, 'string'],

        [/\d+\.\d+/, 'number'],
        [/\d+/,      'number'],

        [/[{}()[\]]/, 'delimiter'],
        [/[=!<>]=?|[+\-*/%]|&&|\|\|/, 'delimiter'],
      ],
    },
  })

  // ── Completamento ───────────────────────────────────────────────
  // Restituisce ciò che il pannello prometteva quando il linguaggio era
  // TypeScript: i campi in arrivo, le variabili di lane e le funzioni —
  // queste ultime dal catalogo `functions.ts`, che è la stessa fonte
  // usata dalla validazione. Un'unica lista, non due che divergono.
  monaco.languages.registerCompletionItemProvider(FLOWPILOT_LANG_ID, {
    triggerCharacters: ['"'],
    provideCompletionItems: (model: any, position: any) => {
      const parola = model.getWordUntilPosition(position)
      const range  = {
        startLineNumber: position.lineNumber, endLineNumber: position.lineNumber,
        startColumn: parola.startColumn,      endColumn: parola.endColumn,
      }
      const K = monaco.languages.CompletionItemKind

      const suggestions = [
        ...contesto.campi.map((nome) => ({
          label: nome, kind: K.Field, insertText: nome, range,
          detail: 'campo in ingresso', sortText: '0' + nome,
        })),
        ...contesto.variabili.map((nome) => ({
          label: `var("${nome}")`, kind: K.Variable, insertText: `var("${nome}")`, range,
          detail: 'variabile di lane (sola lettura)', sortText: '1' + nome,
        })),
        ...ISTRUZIONI.map((nome) => ({
          label: nome, kind: K.Keyword, insertText: nome, range,
          detail: 'istruzione', sortText: '2' + nome,
        })),
        ...FUNCTIONS.map((f) => ({
          label: f.name, kind: K.Function, range,
          // Snippet: il cursore si posiziona fra le parentesi.
          insertText: `${f.name}($0)`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: f.usage, documentation: f.desc, sortText: '3' + f.name,
        })),
      ]
      return { suggestions }
    },
  })
}
