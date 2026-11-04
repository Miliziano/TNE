/** Tipi pubblici dell'editor di codice (src/components/ScriptEditor). */
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
