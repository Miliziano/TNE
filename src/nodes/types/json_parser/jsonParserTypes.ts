// ─── Tipi JSON Parser ─────────────────────────────────────────────
//
// P369: allineati al motore (src-tauri/src/engine/nodes/json_parser.rs).
// Il tipo del campo si applica davvero; le trasformazioni sono solo di
// testo. Le vecchie to_* restano nel tipo per le config salvate, ma il
// caricamento (flowStore) le riporta a tipo. Tolti `filter` e `streaming`:
// il motore non li ha mai applicati.

export type JsonParserFieldTransform =
  | 'none'
  | 'trim'
  | 'uppercase'
  | 'lowercase'
  | 'nullify_empty'
  // legacy (config salvate prima del P369): valgono come tipo
  | 'to_integer'
  | 'to_decimal'
  | 'to_boolean'
  | 'to_date'
  | 'to_string'

export type JsonParserFieldMissing =
  | 'null'       // valore null
  | 'default'    // usa il valore default dichiarato (convertito al tipo)
  | 'skip'       // salta l'elemento (nessuna riga su questo flusso)
  | 'error'      // manda l'elemento al reject

export interface JsonParserField {
  id:          string
  name:        string           // nome campo output
  jsonPath:    string           // percorso relativo al nodo corrente (es: $.nome)
  type:        string           // tipo logico output — applicato dal motore
  transform:   JsonParserFieldTransform
  onMissing:   JsonParserFieldMissing
  defaultValue?: string
}

export interface JsonParserFlow {
  id:           string
  label:        string           // nome handle di uscita
  color:        string           // colore handle
  jsonPath:     string           // JSONPath per estrarre il ramo (es: $.righe)
  isArray:      boolean          // true = una riga per elemento, false = solo il primo
  mergeParent:  boolean          // true = includi campi del padre
  parentFields: string[]         // campi del padre da includere (vuoto = tutti, nel motore)
  /** Solo studio (il motore lo ignora): nome e tipo dei campi del padre
   *  scelti nella modale, perché lo schema del flusso li possa dichiarare
   *  senza risalire il grafo. V. jsonParserFlowFields. */
  parentSchema?: Array<{ name: string; type: string }>
  fields:       JsonParserField[]
}

export interface JsonParserConfig {
  sourceField:  string           // campo in ingresso che contiene il JSON
  hasReject:    boolean          // abilita handle reject
  flows:        JsonParserFlow[]
  _sampleJson?: string           // esempio incollato nella modale
}
