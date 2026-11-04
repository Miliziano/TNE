/**
 * src/ir/lineage.ts
 *
 * PROVENIENZA DEI CAMPI (P393): da dove viene un campo e dove va a finire.
 *
 * Per ogni nodo del canvas e per ogni campo che esce da una sua porta, la
 * "derivazione" dice COME il nodo lo produce — passato tale e quale, calcolato
 * da un'espressione, aggregato, letto da un file — e DA QUALI campi dei suoi
 * ingressi. Seguendo gli archi all'indietro si arriva alle sorgenti
 * (`indietro`); in avanti, a tutto ciò che il campo alimenta fino ai sink
 * (`avanti`: l'analisi d'impatto, "se cambio questa colonna, cosa tocco?").
 *
 * Le espressioni si leggono dalla STESSA compilazione usata per il Run
 * (compileFpel, buildTMapPlan, compileTransformFields, parseScript): la
 * provenienza è quella di ciò che il motore esegue, non una stima sui nomi.
 * Le dipendenze sono quelle di VALORE (i campi letti per calcolare il campo);
 * le condizioni che decidono se una riga passa (filtri, chiavi di join) non
 * sono provenienza del valore e non compaiono.
 *
 * Dove lo studio non può saperlo (colonne del pivot note solo a runtime, tipi
 * di nodo che non dichiarano cosa fanno dei campi) la derivazione lo dice
 * (`dynamic`, `assumed`) invece di inventare.
 *
 * Funzione pura sul canvas: nessun accesso allo store.
 */
import type { Node as FlowNode, Edge } from '@xyflow/react'
import type { NodeData, TMapConfig } from '../types'
import { CATCH_PORT_SCHEMA } from '../types'
import type { ExprNode } from './exprParser'
import { exprToText } from './exprText'
import { parseScript, LOCAL_INPUT, type ScriptStmt } from './scriptParser'
import { parseUserFunctions, type UserFunction } from './userFunctions'
import { buildTMapPlan } from './tmapExprConverter'
import { compileTransformFields, type TransformFieldSpec } from '../transforms/templateCompiler'
import { getNodePorts, getHandleSchema } from '../utils/schemaRegistry'
import { jsonParserFlowFields } from '../nodes/types/json_parser/schema'
import { BRIDGE_SIGNAL_SCHEMA } from '../nodes/types/bridge/bridgeSchema'
import { SINK_FILE_SIGNAL_SCHEMA } from '../nodes/types/sink_file/schema'
import { SINK_FTP_SIGNAL_SCHEMA } from '../nodes/types/sink_ftp/schema'
import { MATERIALIZE_SIGNAL_SCHEMA, materializeMode } from '../nodes/types/materialize/schema'

// ─── Tipi ─────────────────────────────────────────────────────────

/** Come un nodo produce un campo. */
export type Come =
  | 'origin'     // nasce qui: colonna di un file, di una query, campo di una sorgente
  | 'pass'       // passa tale e quale da un ingresso
  | 'expr'       // calcolato da un'espressione
  | 'agg'        // aggregato (sum, count, …) o funzione di finestra
  | 'parsed'     // estratto da un campo (JSON/XML, esplosione di un elenco)
  | 'serialized' // documento costruito da più campi
  | 'generated'  // scritto dal nodo (motivo di scarto, riga di stato, esito qualità)
  | 'dynamic'    // noto solo a runtime (colonne del pivot)
  | 'assumed'    // il tipo di nodo non dichiara cosa fa dei campi: si assume che passi

/** Un campo di un ingresso del nodo. */
export interface Ingresso { handle: string; field: string }

export interface Derivazione {
  come:          Come
  /** Espressione (forma canonica) o descrizione leggibile. */
  testo?:        string
  /** Campi degli ingressi del nodo da cui il valore dipende. */
  da:            Ingresso[]
  /** Valori intermedi dentro il nodo (let, campi già assegnati, trasformazioni del TMap). */
  passi?:        Array<{ nome: string; testo: string }>
  /** Variabili di lane lette. */
  variabili?:    string[]
  /** Assegnato solo in alcuni rami (if): altrimenti resta il valore precedente. */
  condizionale?: boolean
  /** La configurazione del nodo non compila: la derivazione è incompleta. */
  errore?:       string
}

/** Un passo all'indietro: il campo `field` all'uscita `handle` di un nodo. */
export interface PassoIndietro {
  nodeId:   string
  handle:   string
  field:    string
  label:    string
  type:     string
  /** null = il nodo non produce questo campo su quella porta. */
  der:      Derivazione | null
  sorgenti: PassoIndietro[]
  /** Il percorso ripassa da un nodo già visto (grafo con un ciclo). */
  ciclo?:   boolean
}

/** Un uso in avanti: il campo alimenta `field` all'uscita `handle` del nodo, o
 *  è scritto dal nodo (sink: `handle` = porta d'ingresso, `scritto` = dove). */
export interface UsoAvanti {
  nodeId:   string
  handle:   string
  field:    string
  label:    string
  type:     string
  der?:     Derivazione
  scritto?: string
  usi:      UsoAvanti[]
}

export interface OpzioniProvenienza {
  userFunctions?: string[]
}

// ─── Espressioni: i campi letti ───────────────────────────────────

/** Visita i riferimenti di un'espressione: campi (`input` null = campo
 *  nudo della riga) e variabili di lane `var("x")`. Il parametro di una
 *  funzione `x -> …` non è un campo. */
function visitaRiferimenti(
  e: ExprNode,
  campo: (input: string | null, field: string) => void,
  variabile: (nome: string) => void,
): void {
  switch (e.kind) {
    case 'Literal': return
    case 'FieldRef': campo(e.input, e.field); return
    case 'DirectFieldRef':
      if (e.field.startsWith('lane.')) variabile(e.field.slice(5))
      else campo(null, e.field)
      return
    case 'BinaryOp': visitaRiferimenti(e.left, campo, variabile); visitaRiferimenti(e.right, campo, variabile); return
    case 'UnaryOp': case 'Cast': case 'IsNull': case 'IsNotNull': visitaRiferimenti(e.expr, campo, variabile); return
    case 'Coalesce': e.args.forEach((a) => visitaRiferimenti(a, campo, variabile)); return
    case 'CaseWhen':
      e.branches.forEach((b) => { visitaRiferimenti(b.condition, campo, variabile); visitaRiferimenti(b.value, campo, variabile) })
      if (e.default) visitaRiferimenti(e.default, campo, variabile)
      return
    case 'FunctionCall':
      if (e.name === 'lambda_arg') return
      if (e.name === 'var' && e.args[0]?.kind === 'Literal') { variabile(String(e.args[0].value)); return }
      e.args.forEach((a) => visitaRiferimenti(a, campo, variabile))
      return
    default: {
      // Varianti che lo studio non produce (FieldAccess del motore): si
      // visitano i figli che hanno la forma di un nodo.
      for (const v of Object.values(e as Record<string, unknown>)) {
        if (v && typeof v === 'object' && 'kind' in (v as object)) visitaRiferimenti(v as ExprNode, campo, variabile)
      }
    }
  }
}

/** Riferimenti di un JSON qualsiasi che contiene espressioni (alberi dei serializer). */
function riferimentiProfondi(v: unknown, campo: (input: string | null, field: string) => void): void {
  if (!v || typeof v !== 'object') return
  if (Array.isArray(v)) { v.forEach((x) => riferimentiProfondi(x, campo)); return }
  const o = v as Record<string, unknown>
  if (o.kind === 'FieldRef' && typeof o.field === 'string') { campo(String(o.input ?? ''), o.field); return }
  if (o.kind === 'DirectFieldRef' && typeof o.field === 'string') { campo(null, o.field); return }
  Object.values(o).forEach((x) => riferimentiProfondi(x, campo))
}

/** Dipendenze accumulate di un valore (Script, TMap). */
interface Dip {
  da:        Map<string, Ingresso>
  passi:     Map<string, string>
  variabili: Set<string>
}
const dipVuota = (): Dip => ({ da: new Map(), passi: new Map(), variabili: new Set() })
const chiave = (i: Ingresso) => `${i.handle}\u0000${i.field}`
function unisci(a: Dip, b: Dip): void {
  b.da.forEach((v, k) => a.da.set(k, v))
  b.passi.forEach((v, k) => a.passi.set(k, v))
  b.variabili.forEach((v) => a.variabili.add(v))
}
function aggiungi(d: Dip, i: Ingresso): void { d.da.set(chiave(i), i) }

function derivazioneDa(come: Come, testo: string | undefined, d: Dip, extra: Partial<Derivazione> = {}): Derivazione {
  const der: Derivazione = { come, testo, da: [...d.da.values()], ...extra }
  if (d.passi.size) der.passi = [...d.passi].map(([nome, t]) => ({ nome, testo: t }))
  if (d.variabili.size) der.variabili = [...d.variabili]
  return der
}

// ─── Script: assegnazioni in ordine ───────────────────────────────

interface InfoValore { dip: Dip; testi: string[]; condizionale: boolean }

/** Derivazioni dei campi assegnati da uno Script, seguendo l'ordine delle
 *  istruzioni: un campo che legge un campo già assegnato dipende da ciò da cui
 *  dipende quello; un `let` è un passo intermedio. `ingresso` = la porta della
 *  riga in ingresso (null per un generatore: nessun campo arriva da fuori). */
function analizzaScript(stmts: ScriptStmt[], ingresso: string | null): Map<string, Derivazione> {
  const assegnati = new Map<string, InfoValore>()

  const dipendenze = (e: ExprNode, locali: Map<string, InfoValore>): Dip => {
    const d = dipVuota()
    visitaRiferimenti(e, (input, field) => {
      if (input === LOCAL_INPUT) {
        const l = locali.get(field)
        if (l) { unisci(d, l.dip); d.passi.set(`let ${field}`, l.testi.join('  |  ')) }
        return
      }
      const gia = assegnati.get(field)
      if (gia) { unisci(d, gia.dip); d.passi.set(field, gia.testi.join('  |  ')); return }
      if (ingresso !== null) aggiungi(d, { handle: ingresso, field })
    }, (v) => d.variabili.add(v))
    return d
  }

  const blocco = (lista: ScriptStmt[], localiPadre: Map<string, InfoValore>, condizionale: boolean): void => {
    const locali = new Map(localiPadre)
    for (const s of lista) {
      switch (s.kind) {
        case 'Let':
          locali.set(s.name, { dip: dipendenze(s.expr, locali), testi: [exprToText(s.expr)], condizionale: false })
          break
        case 'Assign': {
          const nuovo: InfoValore = { dip: dipendenze(s.expr, locali), testi: [exprToText(s.expr)], condizionale }
          const prima = assegnati.get(s.field)
          if (condizionale) {
            // Il ramo può non eseguirsi: resta anche il valore di prima (quello
            // già assegnato, o il campo in ingresso).
            if (prima) { unisci(nuovo.dip, prima.dip); nuovo.testi = [...prima.testi, ...nuovo.testi] }
            else if (ingresso !== null) aggiungi(nuovo.dip, { handle: ingresso, field: s.field })
          }
          assegnati.set(s.field, nuovo)
          break
        }
        case 'If':
          blocco(s.then, locali, true)
          blocco(s.else, locali, true)
          break
        case 'Repeat': {
          const interni = new Map(locali)
          if (s.varName) interni.set(s.varName, { dip: dipVuota(), testi: ['iteration counter'], condizionale: false })
          blocco(s.body, interni, true)
          break
        }
        case 'For': {
          const interni = new Map(locali)
          interni.set(s.varName, { dip: dipendenze(s.list, locali), testi: [`element of ${exprToText(s.list)}`], condizionale: false })
          blocco(s.body, interni, true)
          break
        }
        default: break
      }
    }
  }
  blocco(stmts, new Map(), false)

  const out = new Map<string, Derivazione>()
  assegnati.forEach((info, campo) => {
    out.set(campo, derivazioneDa('expr', info.testi.join('  |  '), info.dip,
      info.condizionale ? { condizionale: true } : {}))
  })
  return out
}

// ─── Analisi di un'uscita di un nodo ──────────────────────────────

/** Ciò che esce da una porta di un nodo: i campi prodotti esplicitamente e,
 *  se c'è, l'ingresso i cui campi passano tali e quali. */
interface Uscita {
  calcolati: Map<string, Derivazione>
  /** Porta d'ingresso i cui campi escono così come sono (in coda ai calcolati
   *  che hanno lo stesso nome vince il calcolato). */
  passa?:    string
  /** Il passaggio è un'ipotesi (tipo di nodo che non lo dichiara). */
  assunto?:  boolean
}

const SORGENTI = new Set(['dir_watcher', 'ldap_source', 'github_source', 'webhook'])
const PASSANTI = new Set(['filter', 'log', 'stop', 'error_handler', 'lane_start', 'lane_end'])

function nomeFile(p: string): string { return p.split(/[\\/]/).pop() || p }
function json<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}
function segnale(nomi: Array<{ name: string }>, testo: string): Uscita {
  return { calcolati: new Map(nomi.map((f) => [f.name, { come: 'generated' as Come, testo, da: [] }])) }
}

// ─── Il grafo ─────────────────────────────────────────────────────

export interface Provenienza {
  /** Campi che escono dalla porta `handle` del nodo, in ordine. */
  campi(nodeId: string, handle: string): string[]
  /** Campi che entrano dalla porta `handle` del nodo. */
  campiIngresso(nodeId: string, handle: string): string[]
  /** Come il nodo produce `field` sulla porta `handle` (null = non lo produce). */
  deriva(nodeId: string, handle: string, field: string): Derivazione | null
  /** Da dove viene `field` all'uscita `handle` del nodo, fino alle sorgenti. */
  indietro(nodeId: string, handle: string, field: string): PassoIndietro
  /** Da dove viene `field` che entra dalla porta `handle` (per i sink). */
  daIngresso(nodeId: string, handle: string, field: string): PassoIndietro[]
  /** Dove va `field` dell'uscita `handle`, fino ai sink. */
  avanti(nodeId: string, handle: string, field: string): UsoAvanti[]
  /** Porte d'uscita con dati del nodo (catch compreso se collegato). */
  porteUscita(nodeId: string): string[]
  /** Porte d'ingresso collegate. */
  porteIngresso(nodeId: string): string[]
  etichetta(nodeId: string): string
  /** Nome leggibile di una porta (le porte del TMap hanno id generati). */
  etichettaPorta(nodeId: string, handle: string): string
  tipo(nodeId: string): string
}

export function creaProvenienza(
  nodes: FlowNode<NodeData>[],
  edges: Edge[],
  opzioni: OpzioniProvenienza = {},
): Provenienza {
  const perId = new Map(nodes.map((n) => [n.id, n]))
  const userFns: UserFunction[] = (() => {
    try { return parseUserFunctions(opzioni.userFunctions ?? []).functions } catch { return [] }
  })()

  const etichetta = (id: string) => {
    const n = perId.get(id)
    if (!n) return id
    return String((n.data.config as any)?.displayName || n.data.label || n.data.type)
  }
  const tipo = (id: string) => perId.get(id)?.data.type ?? '?'
  const sh = (e: Edge) => e.sourceHandle ?? 'output'
  const th = (e: Edge) => e.targetHandle ?? 'input'

  const entranti = (id: string) => edges.filter((e) => e.target === id)
  const porteIngresso = (id: string): string[] => [...new Set(entranti(id).map(th))]
  /** Porta d'ingresso principale: quella collegata, o 'input'. */
  const principale = (id: string) => porteIngresso(id)[0] ?? 'input'

  /** Chi alimenta la porta d'ingresso: archi, oppure il canale di un bridge. */
  const aMonte = (id: string, handle: string): Array<{ nodeId: string; handle: string }> => {
    if (handle === '__channel') {
      const canale = String(perId.get(id)?.data.props?.['channelName'] ?? '')
      return nodes
        .filter((n) => n.data.type === 'bridge_out' && canale && String(n.data.props?.['channelName'] ?? '') === canale)
        .map((n) => ({ nodeId: n.id, handle: '__channel' }))
    }
    return entranti(id).filter((e) => th(e) === handle).map((e) => ({ nodeId: e.source, handle: sh(e) }))
  }
  const aValle = (id: string, handle: string): Array<{ nodeId: string; handle: string }> => {
    if (handle === '__channel') {
      const canale = String(perId.get(id)?.data.props?.['channelName'] ?? '')
      return nodes
        .filter((n) => n.data.type === 'bridge_in' && canale && String(n.data.props?.['channelName'] ?? '') === canale)
        .map((n) => ({ nodeId: n.id, handle: '__channel' }))
    }
    return edges.filter((e) => e.source === id && sh(e) === handle).map((e) => ({ nodeId: e.target, handle: th(e) }))
  }

  // ── campi in ingresso / in uscita (memo, protetti dai cicli) ──
  const memoCampi = new Map<string, string[]>()
  const inCorso = new Set<string>()
  const campiIngresso = (id: string, handle: string): string[] => {
    const visti = new Set<string>()
    for (const m of aMonte(id, handle)) campi(m.nodeId, m.handle).forEach((f) => visti.add(f))
    return [...visti]
  }

  const memoUscite = new Map<string, Uscita>()
  const uscita = (id: string, handle: string): Uscita => {
    const k = `${id}\u0000${handle}`
    let u = memoUscite.get(k)
    if (!u) { u = analizzaUscita(id, handle); memoUscite.set(k, u) }
    return u
  }

  function campi(id: string, handle: string): string[] {
    const k = `${id}\u0000${handle}`
    const m = memoCampi.get(k)
    if (m) return m
    if (inCorso.has(k)) return []
    inCorso.add(k)
    const u = uscita(id, handle)
    const nomi = u.passa ? [...campiIngresso(id, u.passa)] : []
    const presenti = new Set(nomi)
    for (const nome of u.calcolati.keys()) if (!presenti.has(nome)) nomi.push(nome)
    inCorso.delete(k)
    memoCampi.set(k, nomi)
    return nomi
  }

  function deriva(id: string, handle: string, field: string): Derivazione | null {
    const u = uscita(id, handle)
    const c = u.calcolati.get(field)
    if (c) return c
    if (u.passa && campiIngresso(id, u.passa).includes(field)) {
      return { come: u.assunto ? 'assumed' : 'pass', da: [{ handle: u.passa, field }] }
    }
    return null
  }

  // ── analisi per tipo di nodo ──
  function analizzaUscita(id: string, handle: string): Uscita {
    const node = perId.get(id)
    if (!node) return { calcolati: new Map() }
    const t = node.data.type
    const props = (node.data.props ?? {}) as Record<string, string | undefined>
    const config = (node.data.config ?? {}) as Record<string, any>
    const ingresso = principale(id)

    // La porta catch porta la riga d'errore, per qualunque tipo.
    if (handle === 'catch') return segnale(CATCH_PORT_SCHEMA, 'error row written when the node fails')
    // Porta di scarto: le righe in ingresso; Script e parser aggiungono il
    // motivo (`_reject_reason`, v. script.rs / json_parser.rs / xml_parser.rs).
    if (handle === 'reject' && t !== 'tmap') {
      const conMotivo = t === 'script' || t === 'json_parser' || t === 'xml_parser'
      return {
        calcolati: conMotivo
          ? new Map([['_reject_reason', { come: 'generated' as Come, testo: 'reason written by the node', da: [] }]])
          : new Map(),
        passa: ingresso,
      }
    }

    const schemaProprio = () => getHandleSchema(node, handle === '__channel' ? 'output' : handle, false)

    // ── sorgenti ──
    if (t.startsWith('source_') || SORGENTI.has(t)) {
      const percorso = String(props['path'] ?? props['remotePath'] ?? '')
      return {
        calcolati: new Map(schemaProprio().map((f) => {
          const colonna = f.physicalName || f.name
          let testo: string
          if (t === 'source_file' && percorso) testo = `column "${colonna}" of ${nomeFile(percorso)}`
          else if (t === 'source_db') testo = `column "${colonna}" of the query`
          else testo = colonna !== f.name ? `field "${colonna}" of the source` : 'field of the source'
          return [f.name, { come: 'origin' as Come, testo, da: [] }]
        })),
      }
    }

    switch (t) {
      case 'bridge_in':
        return { calcolati: new Map(), passa: '__channel' }

      case 'bridge_out':
        if (handle === '__channel') return { calcolati: new Map(), passa: ingresso }
        return props['outputMode'] === 'signal'
          ? segnale(BRIDGE_SIGNAL_SCHEMA, 'status row of the channel')
          : { calcolati: new Map(), passa: ingresso }

      case 'materialize':
        return materializeMode(props) === 'buffer_signal'
          ? segnale(MATERIALIZE_SIGNAL_SCHEMA, 'status row of the dataset')
          : { calcolati: new Map(), passa: ingresso }

      case 'sink_file':
        return (props['outputMode'] ?? 'signal') === 'replay'
          ? { calcolati: new Map(), passa: ingresso }
          : segnale(SINK_FILE_SIGNAL_SCHEMA, 'status row of the write')

      case 'sink_ftp':
        return (props['outputMode'] ?? 'signal') === 'passthrough'
          ? { calcolati: new Map(), passa: ingresso }
          : segnale(SINK_FTP_SIGNAL_SCHEMA, 'status row of the upload')

      case 'data_quality': {
        const campoDq = String(props['outputField'] || '_dq')
        return {
          calcolati: new Map([[campoDq, { come: 'generated' as Come, testo: 'result of the quality rules (valid, score, failures)', da: [] }]]),
          passa: ingresso,
        }
      }

      case 'transform': {
        const specs = json<TransformFieldSpec[]>(props['transformFields'], [])
        const { compiled, errors } = compileTransformFields(specs, userFns)
        const calcolati = new Map<string, Derivazione>()
        for (const c of compiled) {
          const d = dipVuota()
          visitaRiferimenti(c.expr as ExprNode, (input, field) => {
            if (input !== LOCAL_INPUT) aggiungi(d, { handle: ingresso, field })
          }, (v) => d.variabili.add(v))
          const testo = exprToText(c.expr as ExprNode)
          const passaggio = c.expr.kind === 'DirectFieldRef' && c.expr.field === c.name
          calcolati.set(c.name, derivazioneDa(passaggio ? 'pass' : 'expr', passaggio ? undefined : testo, d))
        }
        for (const e of errors) calcolati.set(e.field, { come: 'expr', da: [], errore: e.detail })
        const passthrough = (props['unmappedFields'] ?? 'drop') === 'passthrough'
        return { calcolati, passa: passthrough ? ingresso : undefined }
      }

      case 'script': {
        const genera = String(props['sourceMode'] ?? 'flusso') === 'genera'
        let stmts: ScriptStmt[]
        try { stmts = parseScript(String(props['code'] ?? '')) }
        catch {
          // Corpo con errori: il Run è bloccato comunque; qui si assume il passaggio.
          return { calcolati: new Map(), passa: genera ? undefined : ingresso, assunto: true }
        }
        return { calcolati: analizzaScript(stmts, genera ? null : ingresso), passa: genera ? undefined : ingresso }
      }

      case 'tmap': return analizzaTMap(config.tmap as TMapConfig | undefined, handle)

      case 'aggregate': {
        const calcolati = new Map<string, Derivazione>()
        String(props['group_by'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
          .forEach((g) => calcolati.set(g, { come: 'pass', testo: 'group key', da: [{ handle: ingresso, field: g }] }))
        for (const f of json<Array<{ fn: string; field?: string; alias?: string }>>(props['aggFunctions'], [])) {
          const alias = f.alias || `${f.fn}_${f.field || 'all'}`
          calcolati.set(alias, {
            come: 'agg', testo: `${f.fn}(${f.field || '*'})`,
            da: f.field ? [{ handle: ingresso, field: f.field }] : [],
          })
        }
        return { calcolati }
      }

      case 'window': {
        const calcolati = new Map<string, Derivazione>()
        for (const w of json<Array<{ fn: string; field?: string; outputField?: string; expr?: string }>>(props['windows'], [])) {
          const nome = w.outputField || `win_${w.fn}`
          calcolati.set(nome, {
            come: 'agg',
            testo: `${w.fn}(${w.field || (w.fn === 'streak' ? w.expr ?? '' : '')})`,
            da: w.field ? [{ handle: ingresso, field: w.field }] : [],
          })
        }
        return { calcolati, passa: ingresso }
      }

      case 'union': {
        const calcolati = new Map<string, Derivazione>()
        for (const f of json<Array<{ name: string; from?: Record<string, string> }>>(props['unionMapping'], [])) {
          const da = Object.entries(f.from ?? {}).filter(([, v]) => v).map(([h, v]) => ({ handle: h, field: v }))
          calcolati.set(f.name, { come: 'pass', testo: da.length > 1 ? 'one value per input stream' : undefined, da })
        }
        if (props['addSourceField'] === 'true') {
          const nome = String(props['sourceFieldName'] || '_union_source')
          calcolati.set(nome, { come: 'generated', testo: 'label of the input stream', da: [] })
        }
        return { calcolati }
      }

      case 'join': {
        const tipoJoin = String(props['join_type'] ?? 'inner')
        const sinistra = campiIngresso(id, 'input_left')
        const calcolati = new Map<string, Derivazione>()
        sinistra.forEach((f) => calcolati.set(f, { come: 'pass', testo: 'left side', da: [{ handle: 'input_left', field: f }] }))
        if (tipoJoin !== 'semi' && tipoJoin !== 'anti') {
          const prefisso = String(props['rightPrefix'] ?? 'r_')
          const lati = new Set(sinistra)
          for (const f of campiIngresso(id, 'input_right')) {
            const nome = lati.has(f) ? `${prefisso}${f}` : f
            calcolati.set(nome, { come: 'pass', testo: nome !== f ? `right side, renamed (was ${f})` : 'right side', da: [{ handle: 'input_right', field: f }] })
          }
        }
        return { calcolati }
      }

      case 'json_parser':
      case 'xml_parser': {
        const chiaveCfg = t === 'json_parser' ? 'jsonParser' : 'xmlParser'
        const cfg = config[chiaveCfg] ?? {}
        const sorgente = String(cfg.sourceField ?? '')
        const flusso = (cfg.flows ?? []).find((f: any) => f.id === handle)
        if (!flusso) return { calcolati: new Map() }
        const propri = new Map<string, any>((flusso.fields ?? []).filter((f: any) => f.name).map((f: any) => [f.name, f]))
        const elenco = t === 'json_parser' ? jsonParserFlowFields(flusso) : [...propri.values()]
        const calcolati = new Map<string, Derivazione>()
        for (const f of elenco) {
          const proprio = propri.get(f.name)
          if (proprio) {
            const percorso = [flusso.jsonPath ?? flusso.xpath, proprio.jsonPath ?? proprio.xpath].filter(Boolean).join(' → ')
            calcolati.set(f.name, { come: 'parsed', testo: percorso || undefined, da: sorgente ? [{ handle: ingresso, field: sorgente }] : [] })
          } else {
            calcolati.set(f.name, { come: 'pass', testo: 'field of the parent row', da: [{ handle: ingresso, field: f.name }] })
          }
        }
        return { calcolati }
      }

      case 'json_serializer':
      case 'xml_serializer': {
        const campo = String(props['outputField'] ?? (t === 'json_serializer' ? 'content' : 'xml_output'))
        const albero = json<unknown[]>(props['_treeNodes'], [])
        const ser = (config[t === 'json_serializer' ? 'jsonSerializer' : 'xmlSerializer'] ?? {}) as Record<string, any>
        const d = dipVuota()
        const porte = porteIngresso(id)
        riferimentiProfondi(albero, (input, field) => {
          aggiungi(d, { handle: input && porte.includes(input) ? input : ingresso, field })
        })
        riferimentiProfondi(ser.mappings ?? {}, (input, field) => aggiungi(d, { handle: input && porte.includes(input) ? input : ingresso, field }))
        for (const v of Object.values(ser.mappings ?? {})) {
          if (typeof v === 'string' && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(v)) aggiungi(d, { handle: ingresso, field: v })
        }
        return { calcolati: new Map([[campo, derivazioneDa('serialized', t === 'json_serializer' ? 'JSON document' : 'XML document', d)]]) }
      }

      case 'explode': {
        if ((props['explodeSource'] ?? 'materialize') === 'materialize') {
          const nome = String(props['materializeName'] ?? '')
          return {
            calcolati: new Map(schemaProprio().map((f) => [f.name, {
              come: 'origin' as Come, testo: nome ? `row of the dataset "${nome}"` : 'row of a dataset', da: [],
            }])),
          }
        }
        const campoElenco = String(props['flowField'] ?? '')
        const mapping = json<Array<{ sourceField?: string; outputName?: string; include?: boolean }>>(props['explodeMapping'], [])
        const calcolati = new Map<string, Derivazione>()
        const da = campoElenco ? [{ handle: ingresso, field: campoElenco }] : []
        if (mapping.length) {
          for (const m of mapping) {
            if (m.include === false) continue
            const nome = m.outputName || m.sourceField
            if (nome) calcolati.set(nome, { come: 'parsed', testo: `element of ${campoElenco}${m.sourceField ? ` → ${m.sourceField}` : ''}`, da })
          }
        } else {
          for (const f of schemaProprio()) calcolati.set(f.name, { come: 'parsed', testo: `element of ${campoElenco}`, da })
        }
        return { calcolati, passa: props['includeParent'] === 'true' ? ingresso : undefined }
      }

      case 'pivot': {
        const calcolati = new Map<string, Derivazione>()
        for (const f of schemaProprio()) {
          if (f.name === '__pivot_dynamic__') continue
          calcolati.set(f.name, { come: 'dynamic', testo: 'pivoted column (values decided by the data)', da: [] })
        }
        return { calcolati }
      }
    }

    if (PASSANTI.has(t)) return { calcolati: new Map(), passa: ingresso }

    // Sink senza uscita dati e tipi che non dichiarano cosa fanno dei campi:
    // ciò che hanno nello schema d'uscita lo producono loro; il resto, se
    // arriva dall'ingresso, si assume che passi.
    const propri = new Map(schemaProprio().map((f) => [f.name, { come: 'generated' as Come, testo: 'written by the node', da: [] as Ingresso[] }]))
    if (t.startsWith('sink_') || t === 'mail_sink' || porteIngresso(id).length === 0) return { calcolati: propri }
    for (const f of campiIngresso(id, ingresso)) propri.delete(f)
    return { calcolati: propri, passa: ingresso, assunto: true }
  }

  /** Per il testo mostrato: gli id degli ingressi del TMap tornano etichette. */
  function conEtichette(e: ExprNode, etichette: Map<string, string>): ExprNode {
    const visita = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(visita)
      if (!v || typeof v !== 'object') return v
      const o = v as Record<string, unknown>
      if (o.kind === 'FieldRef' && typeof o.input === 'string' && etichette.has(o.input)) return { ...o, input: etichette.get(o.input) }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, visita(x)]))
    }
    return visita(e) as ExprNode
  }

  function analizzaTMap(tmap: TMapConfig | undefined, handle: string): Uscita {
    const calcolati = new Map<string, Derivazione>()
    if (!tmap) return { calcolati }
    const out = tmap.outputs?.find((o) => o.id === handle)
    if (!out) return { calcolati }
    let piano
    try { piano = buildTMapPlan(tmap, userFns) }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      for (const f of out.fields) if (f.name) calcolati.set(f.name, { come: 'expr', testo: f.expression, da: [], errore: msg })
      return { calcolati }
    }
    const principaleTMap = piano.main_input_id
    const etichette = new Map((tmap.inputs ?? []).map((i) => [i.id, i.label]))
    const testo = (e: ExprNode) => exprToText(conEtichette(e, etichette))
    const trasformazioni = new Map(piano.transforms.map((tr) => [tr.output_name, tr.expr as ExprNode]))
    const dipTr = new Map<string, Dip>()
    const dipendenze = (e: ExprNode, catena: Set<string>): Dip => {
      const d = dipVuota()
      visitaRiferimenti(e, (input, field) => {
        if (input) { aggiungi(d, { handle: input, field }); return }
        const tr = trasformazioni.get(field)
        if (tr && !catena.has(field)) {
          let dt = dipTr.get(field)
          if (!dt) { dt = dipendenze(tr, new Set([...catena, field])); dipTr.set(field, dt) }
          unisci(d, dt)
          d.passi.set(field, testo(tr))
          return
        }
        aggiungi(d, { handle: principaleTMap, field })
      }, (v) => d.variabili.add(v))
      return d
    }
    const pianoOut = piano.outputs.find((o) => o.output_id === handle)
    for (const f of pianoOut?.fields ?? []) {
      if (!f.name) continue
      const e = f.expr as ExprNode
      const d = dipendenze(e, new Set())
      const diretto = e.kind === 'FieldRef' && e.field === f.name
      calcolati.set(f.name, derivazioneDa(diretto ? 'pass' : 'expr', diretto ? undefined : testo(e), d))
    }
    return { calcolati }
  }

  // ── porte ──
  const porteUscita = (id: string): string[] => {
    const node = perId.get(id)
    if (!node) return []
    const dichiarate = getNodePorts(node).outputs.map((p) => p.id)
    const collegate = edges.filter((e) => e.source === id).map(sh)
    const tutte = [...new Set([...dichiarate, ...collegate])]
    // catch solo se collegato: altrimenti è rumore in ogni elenco
    return tutte.filter((h) => h !== 'catch' || collegate.includes('catch'))
  }

  // ── all'indietro ──
  function indietro(id: string, handle: string, field: string, visti: Set<string> = new Set()): PassoIndietro {
    const k = `${id}\u0000${handle}\u0000${field}`
    const base = { nodeId: id, handle, field, label: etichetta(id), type: tipo(id) }
    if (visti.has(k)) return { ...base, der: null, sorgenti: [], ciclo: true }
    const der = deriva(id, handle, field)
    if (!der) return { ...base, der: null, sorgenti: [] }
    const dentro = new Set(visti); dentro.add(k)
    const sorgenti = der.da.flatMap((i) => daIngressoInterno(id, i.handle, i.field, dentro))
    return { ...base, der, sorgenti }
  }
  function daIngressoInterno(id: string, handle: string, field: string, visti: Set<string>): PassoIndietro[] {
    const passi = aMonte(id, handle).map((m) => indietro(m.nodeId, m.handle, field, visti))
    // Con più archi sulla stessa porta si tengono quelli che il campo lo hanno.
    const trovati = passi.filter((p) => p.der || p.ciclo)
    return trovati.length ? trovati : passi
  }

  // ── in avanti ──
  function avanti(id: string, handle: string, field: string, visti: Set<string> = new Set()): UsoAvanti[] {
    const usi: UsoAvanti[] = []
    for (const v of aValle(id, handle)) {
      const k = `${v.nodeId}\u0000${v.handle}\u0000${field}`
      if (visti.has(k)) continue
      const dentro = new Set(visti); dentro.add(k)
      const dove = scrittoDa(v.nodeId, field)
      if (dove) usi.push({ nodeId: v.nodeId, handle: v.handle, field, label: etichetta(v.nodeId), type: tipo(v.nodeId), scritto: dove, usi: [] })
      // Il Bridge Out prosegue anche sul canale verso i Bridge In.
      const porte = tipo(v.nodeId) === 'bridge_out' ? [...porteUscita(v.nodeId), '__channel'] : porteUscita(v.nodeId)
      for (const h of porte) {
        if (h === 'catch') continue
        for (const f of campi(v.nodeId, h)) {
          const der = deriva(v.nodeId, h, f)
          if (!der || !der.da.some((i) => i.handle === v.handle && i.field === field)) continue
          usi.push({
            nodeId: v.nodeId, handle: h, field: f, label: etichetta(v.nodeId), type: tipo(v.nodeId), der,
            usi: avanti(v.nodeId, h, f, dentro),
          })
        }
      }
    }
    return usi
  }

  /** Dove un sink scrive il campo che gli arriva (null = non è un sink, o non lo scrive). */
  function scrittoDa(id: string, field: string): string | null {
    const node = perId.get(id)
    if (!node) return null
    const t = node.data.type
    const props = (node.data.props ?? {}) as Record<string, string | undefined>
    if (t === 'sink_db') {
      const cols = json<Array<{ dbColumn: string; sourceField?: string; enabled?: boolean }>>(props['sinkColumns'], [])
      const tabella = String(props['table'] ?? props['tableName'] ?? '')
      const col = cols.find((c) => c.enabled !== false && (c.sourceField || c.dbColumn) === field)
      return col ? `column "${col.dbColumn}"${tabella ? ` of ${tabella}` : ''}` : null
    }
    if (t === 'sink_file' || t === 'sink_ftp') {
      const percorso = String(props['path'] ?? props['remotePath'] ?? '')
      return `column "${field}"${percorso ? ` of ${nomeFile(percorso)}` : ''}`
    }
    if (t.startsWith('sink_') || t === 'mail_sink' || t === 'report_generator') return `field "${field}"`
    return null
  }

  return {
    campi,
    campiIngresso,
    deriva,
    indietro: (id, handle, field) => indietro(id, handle, field),
    daIngresso: (id, handle, field) => daIngressoInterno(id, handle, field, new Set()),
    avanti: (id, handle, field) => avanti(id, handle, field),
    porteUscita,
    porteIngresso,
    etichetta,
    etichettaPorta: (id, handle) => {
      if (handle === '__channel') return 'channel'
      const node = perId.get(id)
      if (!node) return handle
      const ports = getNodePorts(node)
      return [...ports.inputs, ...ports.outputs].find((x) => x.id === handle)?.label ?? handle
    },
    tipo,
  }
}

// ─── Riepilogo end-to-end (export) ────────────────────────────────

export interface RigaProvenienza {
  nodo:       string
  porta:      string
  campo:      string
  origini:    Array<{ nodo: string; campo: string; come: string }>
  percorso:   string
}

/** Sorgenti ultime di un passo all'indietro: le foglie dell'albero. */
export function origini(p: PassoIndietro): PassoIndietro[] {
  if (!p.sorgenti.length) return [p]
  return p.sorgenti.flatMap(origini)
}

/** Percorso leggibile (il ramo più lungo) di un passo all'indietro. */
function percorso(p: PassoIndietro): string {
  const pezzi: string[] = []
  let cur: PassoIndietro | undefined = p
  while (cur) {
    const come = cur.der ? (cur.der.come === 'pass' ? '' : ` = ${cur.der.testo ?? cur.der.come}`) : ' (not found)'
    // I passi intermedi (let, trasformazioni del TMap) dicono cosa c'è dietro un nome.
    const via = cur.der?.passi?.length ? ` [${cur.der.passi.map((x) => `${x.nome} = ${x.testo}`).join('; ')}]` : ''
    pezzi.push(`${cur.label}.${cur.field}${come}${via}`)
    cur = cur.sorgenti[0]
  }
  return pezzi.join(' ← ')
}

/** Per ogni campo che arriva a un sink (e per ogni campo d'uscita dei nodi
 *  senza valle), da quali campi delle sorgenti viene. È ciò che va in un
 *  documento di governance: "la colonna X del report viene da A e B". */
export function riepilogoProvenienza(nodes: FlowNode<NodeData>[], edges: Edge[], opzioni: OpzioniProvenienza = {}): RigaProvenienza[] {
  const p = creaProvenienza(nodes, edges, opzioni)
  const righe: RigaProvenienza[] = []
  for (const n of nodes) {
    const t = n.data.type
    if (t === 'lane_start' || t === 'lane_end') continue
    const terminale = !edges.some((e) => e.source === n.id)
    if (!terminale) continue
    const ingressi = p.porteIngresso(n.id)
    const finale = t.startsWith('sink_') || t === 'mail_sink' || t === 'report_generator'
    if (finale) {
      for (const h of ingressi) {
        for (const f of p.campiIngresso(n.id, h)) {
          const passi = p.daIngresso(n.id, h, f)
          righe.push({
            nodo: p.etichetta(n.id), porta: h, campo: f,
            origini: passi.flatMap(origini).map((o) => ({ nodo: o.label, campo: o.field, come: o.der?.come ?? 'not found' })),
            percorso: passi.map(percorso).join('  ||  '),
          })
        }
      }
    }
  }
  return righe
}

/** CSV (separatore `;`, testo tra virgolette) del riepilogo. */
export function provenienzaCsv(righe: RigaProvenienza[]): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`
  const out = ['target;port;field;origin;path']
  for (const r of righe) {
    const o = r.origini.map((x) => `${x.nodo}.${x.campo}${x.come === 'origin' ? '' : ` (${x.come})`}`).join(', ')
    out.push([r.nodo, r.porta, r.campo, o, r.percorso].map(q).join(';'))
  }
  return out.join('\n')
}
