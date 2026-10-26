// ─── Tipi XML Parser ──────────────────────────────────────────────
//
// P372: allineati al motore (src-tauri/src/engine/nodes/xml_parser.rs).
// - `applyTypes`: il motore applica il tipo dei campi (attivo sui nodi
//   nuovi; le config salvate prima restano a "tutto testo" finché non lo si
//   accende);
// - trasformazioni di testo (+ empty→null); le vecchie to_* restano per le
//   config salvate;
// - `isAttribute` segue l'XPath (`@nome`): è l'XPath che conta per il motore;
// - tolto `streaming` (mai applicato).

export type XmlFieldType =
  | 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'object' | 'any'

export type XmlParserFieldTransform =
  | 'none' | 'trim' | 'uppercase' | 'lowercase' | 'nullify_empty'
  // legacy: valgono come conversione
  | 'to_integer' | 'to_decimal' | 'to_boolean' | 'to_date' | 'to_string'

// Alias per compatibilità con il modal
export type XmlFieldTransform = XmlParserFieldTransform

export type XmlParserFieldMissing = 'null' | 'default' | 'skip' | 'error'
export type XmlFieldMissing = XmlParserFieldMissing

// ─── Nodo albero XML ──────────────────────────────────────────────
export interface XmlTreeNode {
  id:          string
  name:        string
  xpath:       string
  nodeType:    'element' | 'attribute' | 'text' | 'cdata'
  valueType:   string
  isArray:     boolean
  isOptional:  boolean
  children:    XmlTreeNode[]
  collapsed?:  boolean
}

// ─── Campo output di un flusso ────────────────────────────────────
export interface XmlParserField {
  id:           string
  name:         string
  xpath:        string
  type:         string
  isAttribute:  boolean          // segue l'XPath: true se l'ultimo passo è @attr
  transform:    XmlParserFieldTransform
  onMissing:    XmlParserFieldMissing
  defaultValue?: string
}

// ─── Flusso output (un handle sul canvas) ─────────────────────────
export interface XmlParserFlow {
  id:          string
  label:       string
  color:       string
  xpath:       string            // XPath base del flusso
  isRepeating: boolean           // true = una riga per ogni match, false = solo il primo
  fields:      XmlParserField[]
}

// ─── Configurazione globale del nodo ─────────────────────────────
export interface XmlParserConfig {
  sourceField:       string
  hasReject:         boolean
  flows:             XmlParserFlow[]
  ignoreNamespaces:  boolean
  trimText:          boolean
  applyTypes?:       boolean     // P372: assente = false (config salvate prima)
  _sampleXml?:       string      // sample XML/XSD salvato per ricostruire l'albero
}
