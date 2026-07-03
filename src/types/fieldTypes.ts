/**
 * src/types/fieldTypes.ts
 *
 * UNICA FONTE DI VERITÀ per i tipi campo in FlowPilot.
 *
 * Tutti i file importano da qui — nessuna lista duplicata altrove.
 *
 * Sostituisce:
 *   - FieldType in src/transforms/presets.ts
 *   - TMapFieldType in src/types.ts
 *   - TransformCategory in src/transforms/catalog.ts
 *   - XmlFieldType in src/nodes/types/json_parser/jsonParserTypes.ts
 *   - FIELD_TYPES hardcodati in BridgeInMappingPanel, BridgeInModal,
 *     JsonParserModal, MappingPanel (sink_db), ecc.
 *   - TYPE_META in src/transforms/presets.ts
 */

// ─── Tipo canonico ────────────────────────────────────────────────
//
// Unione di tutti i casi d'uso presenti nel codebase.
// L'IR usa tipi aggiuntivi (timestamp, binary, xml, array) che
// rimangono locali a ir/types.ts perché non compaiono nell'UI.
//
export type FieldType =
  | 'string'
  | 'integer'
  | 'decimal'
  | 'number'      // alias TMap per valori numerici generici
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'object'
  | 'any'

// ─── Alias per retrocompatibilità ────────────────────────────────
// Permettono di fare il migration graduale senza rompere i file
// che usano ancora i vecchi nomi — basta cambiare l'import.

/** Alias di FieldType — usato dal TMap */
export type TMapFieldType = FieldType

/** Alias di FieldType — usato dal catalogo trasformazioni */
export type TransformCategory = FieldType

/** Alias di FieldType — usato da XML/JSON parser */
export type XmlFieldType = FieldType

// ─── Array ordinato per i select UI ──────────────────────────────
//
// Usato da tutti i CustomSelect che mostrano la lista dei tipi.
// L'ordine è semantico: tipi testuali → numerici → booleano → temporali → strutturati.
//
export const FIELD_TYPES: FieldType[] = [
  'string',
  'integer',
  'decimal',
  'number',
  'boolean',
  'date',
  'datetime',
  'object',
  'any',
]

// ─── Metadati visivi — colori e label ─────────────────────────────
//
// Unica fonte di verità per i colori dei tipi in tutta la UI.
// Usato da: TransformPanel, FieldTransformEditor, TMapModal,
//           MappingPanel (sink_db), BridgeIn, JsonParser, ecc.
//
export interface TypeMeta {
  /** Colore testo / bordo badge */
  color: string
  /** Colore sfondo badge */
  bg:    string
  /** Label breve mostrata nei badge */
  label: string
}

export const TYPE_META: Record<FieldType, TypeMeta> = {
  string:   { color: '#3ddc84', bg: '#1a3a2a', label: 'string'   },
  integer:  { color: '#a78bfa', bg: '#2a1a4a', label: 'integer'  },
  number:   { color: '#4a9eff', bg: '#1a2a4a', label: 'number'   },
  decimal:  { color: '#ffb347', bg: '#2a1a00', label: 'decimal'  },
  boolean:  { color: '#ff5f57', bg: '#3a1a1a', label: 'boolean'  },
  date:     { color: '#4a9eff', bg: '#1a2a4a', label: 'date'     },
  datetime: { color: '#22d3ee', bg: '#0a2a3a', label: 'datetime' },
  object:   { color: '#22d3ee', bg: '#1a2a2a', label: 'object'   },
  any:      { color: '#9a9aaa', bg: '#2a2a2a', label: 'any'      },
}

// ─── Helper: badge tipo inline ────────────────────────────────────
//
// Genera le props di stile per un badge tipo direttamente da TYPE_META.
// Usato nei componenti che mostrano badge colorati per i tipi.
//
// Esempio:
//   <span style={typeBadgeStyle('integer')}>integer</span>
//
export function typeBadgeStyle(type: FieldType | string): React.CSSProperties {
  const meta = TYPE_META[type as FieldType] ?? TYPE_META.any
  return {
    fontSize:        9,
    padding:         '1px 6px',
    borderRadius:    6,
    fontWeight:      600,
    background:      meta.bg,
    color:           meta.color,
    border:          `0.5px solid ${meta.color}40`,
    fontFamily:      "'JetBrains Mono', monospace",
    whiteSpace:      'nowrap' as const,
    display:         'inline-block',
  }
}

// ─── Helper: select options con colori ───────────────────────────
//
// Genera le option per un CustomSelect con stile colore per tipo.
// I <option> non supportano CSS arbitrario in tutti i browser,
// quindi i colori vengono applicati al <select> padre quando
// il valore corrente cambia (pattern già usato in TransformPanel).
//
export function typeSelectStyle(
  currentType: FieldType | string,
  baseStyle:   React.CSSProperties = {},
): React.CSSProperties {
  const meta = TYPE_META[currentType as FieldType] ?? TYPE_META.any
  return {
    ...baseStyle,
    color:      meta.color,
    background: meta.bg,
    border:     `1px solid ${meta.color}40`,
  }
}
