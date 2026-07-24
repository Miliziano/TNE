import { useRef, useCallback, useEffect } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import {
  FLOWPILOT_LANG_ID, registerFlowpilotLanguage, aggiornaContestoFlowpilot,
} from './flowpilotLanguage'
import type { editor as MonacoEditor } from 'monaco-editor'

// ─── Mappa linguaggi → id Monaco ─────────────────────────────────
const MONACO_LANG: Record<string, string> = {
  // Il linguaggio del nodo Script ha ora una grammatica sua (Monarch, in
  // flowpilotLanguage.ts): prima prendeva in prestito quella di Rust, che
  // evidenziava let/if/for ma non emit/skip/reject né le funzioni FPEL.
  flowpilot:  FLOWPILOT_LANG_ID,
  typescript: 'typescript',
  python:     'python',
  java:       'java',
  groovy:     'java',
  go:         'go',
  rust:       'rust',
  mojo:       'python',
}

// ─── Tema dark custom ─────────────────────────────────────────────
const THEME_NAME = 'flowpilot-dark'
const THEME_DEF: MonacoEditor.IStandaloneThemeData = {
  base:    'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment',    foreground: '4a5a7a', fontStyle: 'italic' },
    { token: 'keyword',    foreground: 'a78bfa' },
    { token: 'string',     foreground: '3ddc84' },
    { token: 'number',     foreground: 'ffb347' },
    { token: 'type',       foreground: '4a9eff' },
    { token: 'identifier', foreground: 'c8d4f0' },
    { token: 'delimiter',  foreground: '4a5a7a' },
    { token: 'function',   foreground: '22d3ee' },
  ],
  colors: {
    'editor.background':                  '#0f1117',
    'editor.foreground':                  '#c8d4f0',
    'editor.lineHighlightBackground':     '#1a2030',
    'editor.selectionBackground':         '#2a3a5a',
    'editorCursor.foreground':            '#a78bfa',
    'editorLineNumber.foreground':        '#2a3349',
    'editorLineNumber.activeForeground':  '#4a5a7a',
    'editorIndentGuide.background':       '#1a2030',
    'editorWidget.background':            '#161b27',
    'editorWidget.border':                '#2a3349',
    'editorSuggestWidget.background':     '#161b27',
    'editorSuggestWidget.border':         '#2a3349',
    'editorSuggestWidget.selectedBackground': '#1a3a6a',
    'list.hoverBackground':               '#1a2030',
    'scrollbar.shadow':                   '#00000000',
    'scrollbarSlider.background':         '#2a334940',
    'scrollbarSlider.hoverBackground':    '#2a334970',
  },
}

// ─── Tipi schema per autocompletamento TS ────────────────────────
function buildSchemaTypes(
  schema:   SchemaField[],
  laneVars: ContextVar[],
  poolVars: ContextVar[],
): string {
  const rowFields  = schema.map((f) => `  ${f.name}: ${tsType(f.type)}`).join('\n')
  const laneFields = laneVars.map((v) => `  ${v.name}: ${tsType(v.type)}`).join('\n')
  const poolFields = poolVars.map((v) => `  ${v.name}: ${tsType(v.type)}`).join('\n')

  return `
interface Row {
${rowFields || '  [key: string]: unknown'}
  [key: string]: unknown
}
interface LaneContext {
${laneFields || '  [key: string]: unknown'}
  [key: string]: unknown
}
interface PoolContext {
${poolFields || '  [key: string]: unknown'}
  [key: string]: unknown
}
interface Context {
  lane:   LaneContext
  pool:   PoolContext
  log:    (msg: string) => void
  emit:   (row: Row) => void
  skip:   () => void
  error:  (msg: string) => void
}
declare const row:     Row
declare const rows:    Row[]
declare const context: Context
`
}

function tsType(fieldType: string): string {
  switch (fieldType) {
    case 'string':  return 'string'
    case 'integer':
    case 'number':
    case 'decimal': return 'number'
    case 'boolean': return 'boolean'
    case 'date':    return 'string | Date'
    case 'object':  return 'Record<string, unknown>'
    default:        return 'unknown'
  }
}

// ─── Tipi pubblici ────────────────────────────────────────────────
export interface SchemaField {
  name: string
  type: string
  id?:  string
}

export interface ContextVar {
  name: string
  type: string
}

export interface ScriptEditorProps {
  value:              string
  onChange:           (code: string) => void
  language:           string
  schema?:            SchemaField[]
  laneVars?:          ContextVar[]
  poolVars?:          ContextVar[]
  height?:            number | string
  readOnly?:          boolean
  snippetToInsert?:   string
  onSnippetInserted?: () => void
  // Wrap: avvolge la selezione corrente con una funzione
  wrapToInsert?:      string   // es: 'formatDate($selection, "DD/MM/YYYY")'
  onWrapInserted?:    () => void
}

// ─── Componente ───────────────────────────────────────────────────
export function ScriptEditor({
  value, onChange, language, schema = [],
  laneVars = [], poolVars = [],
  height = 300, readOnly = false,
  snippetToInsert, onSnippetInserted,
  wrapToInsert, onWrapInserted,
}: ScriptEditorProps) {
  const editorRef  = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const monacoRef  = useRef<any>(null)
  const monacoLang = MONACO_LANG[language] ?? 'plaintext'

  // ── Aggiorna tipi TS quando schema cambia ─────────────────────
  useEffect(() => {
    const m = monacoRef.current
    if (!m) return
    try {
      const tsLang   = m.languages?.typescript
      const typeDefs = buildSchemaTypes(schema, laneVars, poolVars)
      if (monacoLang === 'typescript') {
        tsLang?.typescriptDefaults?.addExtraLib(typeDefs, 'file:///flowpilot-types.d.ts')
      }
    } catch {}

    // Il completamento del linguaggio dello Script legge da un contesto
    // condiviso invece che dalle props: Monaco registra i provider una
    // volta per LINGUAGGIO, non per editor, quindi un provider che
    // chiudesse su queste props resterebbe fermo a quelle del primo
    // editor montato. Le variabili di POOL non entrano: non sono
    // raggiungibili dalle espressioni (v. P65).
    if (monacoLang === FLOWPILOT_LANG_ID) {
      aggiornaContestoFlowpilot(schema.map((f) => f.name), laneVars.map((v) => v.name))
    }
  }, [schema, laneVars, poolVars, monacoLang])

  // ── Inserisci snippet alla posizione cursore ───────────────────
  useEffect(() => {
    if (!snippetToInsert || !editorRef.current) return
    const editor   = editorRef.current
    const position = editor.getPosition()
    if (!position) return
    editor.executeEdits('insert-snippet', [{
      range: {
        startLineNumber: position.lineNumber,
        startColumn:     position.column,
        endLineNumber:   position.lineNumber,
        endColumn:       position.column,
      },
      text: snippetToInsert,
    }])
    editor.focus()
    onSnippetInserted?.()
  }, [snippetToInsert])

  // ── Wrap selezione con espressione ────────────────────────────
  useEffect(() => {
    if (!wrapToInsert || !editorRef.current) return
    const editor    = editorRef.current
    const model     = editor.getModel()
    const selection = editor.getSelection()
    if (!model || !selection) return

    const selected = model.getValueInRange(selection)
    // Sostituisce $selection con il testo selezionato, oppure con $value se vuoto
    const wrapped  = wrapToInsert.replace('$selection', selected || '$value')

    editor.executeEdits('wrap-selection', [{
      range:              selection,
      text:               wrapped,
      forceMoveMarkers:   true,
    }])
    editor.focus()
    onWrapInserted?.()
  }, [wrapToInsert])

  // ── onMount ───────────────────────────────────────────────────
  const onMount: OnMount = useCallback((editor, monacoInstance) => {
    editorRef.current = editor
    monacoRef.current = monacoInstance

    // Registra tema
    monacoInstance.editor.defineTheme(THEME_NAME, THEME_DEF)
    monacoInstance.editor.setTheme(THEME_NAME)

    // Grammatica e completamento del linguaggio dello Script. La
    // funzione è idempotente: Monaco è globale e onMount scatta per ogni
    // editor montato.
    try { registerFlowpilotLanguage(monacoInstance) } catch {}

    // Configura TypeScript
    try {
      const tsLang = (monacoInstance.languages as any).typescript
      if (tsLang) {
        tsLang.typescriptDefaults?.setCompilerOptions({
          target: 99, allowNonTsExtensions: true, noLib: true,
        })
        const typeDefs = buildSchemaTypes(schema, laneVars, poolVars)
        if (monacoLang === 'typescript') {
          tsLang.typescriptDefaults?.addExtraLib(typeDefs, 'file:///flowpilot-types.d.ts')
        }
      }
    } catch {}

    // Shortcut Ctrl+Shift+F — formatta (invece di Ctrl+Space che è del browser)
    editor.addCommand(
      monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyMod.Shift | monacoInstance.KeyCode.KeyF,
      () => editor.getAction('editor.action.formatDocument')?.run()
    )

    // Shortcut Alt+T — trigger suggestions (alternativa a Ctrl+Space)
    editor.addCommand(
      monacoInstance.KeyMod.Alt | monacoInstance.KeyCode.KeyT,
      () => editor.trigger('keyboard', 'editor.action.triggerSuggest', {})
    )
  }, [monacoLang])

  return (
    <div
      style={{ border: '1px solid #2a3349', borderRadius: 4, overflow: 'hidden' }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Editor
        height={height}
        language={monacoLang}
        value={value}
        theme={THEME_NAME}
        onChange={(v) => onChange(v ?? '')}
        onMount={onMount}
        options={{
          fontSize:             12,
          fontFamily:           "'JetBrains Mono', 'Fira Code', monospace",
          fontLigatures:        true,
          lineHeight:           20,
          minimap:              { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap:             'on',
          tabSize:              2,
          insertSpaces:         true,
          renderLineHighlight:  'line',
          readOnly,
          automaticLayout:      true,
          padding:              { top: 8, bottom: 8 },
          scrollbar: {
            verticalScrollbarSize:   6,
            horizontalScrollbarSize: 6,
          },
          suggest: {
            showKeywords:   true,
            showSnippets:   true,
            showClasses:    true,
            showFunctions:  true,
            showVariables:  true,
            showProperties: true,
          },
          quickSuggestions: {
            other:    true,
            comments: false,
            strings:  false,
          },
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true, indentation: true },
        }}
        loading={
          <div style={{
            height, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: '#0f1117', color: '#4a5a7a', fontSize: 11, fontFamily: 'monospace',
          }}>
            caricamento editor...
          </div>
        }
      />
    </div>
  )
}