// ─── Tipi XML Parser ──────────────────────────────────────────────

export type XmlFieldType =
  | 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'object' | 'any'

export type XmlParserFieldTransform =
  | 'none' | 'trim' | 'uppercase' | 'lowercase'
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
  isAttribute:  boolean          // true se il campo viene da un attributo XML (@attr)
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
  isRepeating: boolean           // true = genera una riga per ogni match
  streaming:   boolean
  fields:      XmlParserField[]
}

// ─── Configurazione globale del nodo ─────────────────────────────
export interface XmlParserConfig {
  sourceField:       string
  hasReject:         boolean
  flows:             XmlParserFlow[]
  ignoreNamespaces:  boolean
  trimText:          boolean
  _sampleXml?:       string      // sample XML/XSD salvato per ricostruire l'albero
}
