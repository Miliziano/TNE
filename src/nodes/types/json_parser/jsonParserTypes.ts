// ─── Tipi JSON Parser ─────────────────────────────────────────────

export type JsonParserFieldTransform =
  | 'none'
  | 'trim'
  | 'uppercase'
  | 'lowercase'
  | 'to_integer'
  | 'to_decimal'
  | 'to_boolean'
  | 'to_date'
  | 'to_string'

export type JsonParserFieldMissing =
  | 'null'       // valore null
  | 'default'    // usa il valore default dichiarato
  | 'skip'       // salta la riga
  | 'error'      // manda al reject

export interface JsonParserField {
  id:          string
  name:        string           // nome campo output
  jsonPath:    string           // percorso relativo al nodo corrente (es: $.nome)
  type:        string           // tipo logico output
  transform:   JsonParserFieldTransform
  onMissing:   JsonParserFieldMissing
  defaultValue?: string
}
export interface JsonParserConfig {
  sourceField: string
  hasReject:   boolean
  flows:       JsonParserFlow[]
  _sampleJson?: string   // ← aggiungere
}

export interface JsonParserFlow {
  id:           string
  label:        string           // nome handle di uscita
  color:        string           // colore handle
  jsonPath:     string           // JSONPath per estrarre il ramo (es: $.righe)
  filter?:      string           // espressione filtro opzionale (es: $.qty > 0)
  isArray:      boolean          // true = emetti una riga per elemento
  streaming:    boolean          // true = streaming per array grandi
  mergeParent:  boolean          // true = includi campi del padre
  parentFields: string[]         // campi del padre da includere (vuoto = tutti)
  fields:       JsonParserField[]
}

export interface JsonParserConfig {
  sourceField:   string           // campo in ingresso che contiene il JSON
  hasReject:     boolean          // abilita handle reject
  flows:         JsonParserFlow[]
}
