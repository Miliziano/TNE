/**
 * src/store/storia.ts
 *
 * ANNULLA / RIPETI sul progetto (P397). Ogni modifica a ciò che si salva —
 * nodi, archi, pool, profili — diventa un passo; le modifiche che arrivano
 * di fila (un trascinamento, una digitazione nel pannello) si raccolgono in un
 * passo solo, preso quando il progetto smette di cambiare per un attimo.
 *
 * Gli stati sono gli oggetti stessi dello store: le modifiche sono immutabili,
 * quindi un passo costa solo i pezzi cambiati. Ciò che cambia da solo (stato di
 * esecuzione, badge del validatore, selezione) non conta: si confrontano le
 * impronte di documento.ts.
 *
 * Open e New azzerano la storia: non si annulla un'apertura.
 */
import { create } from 'zustand'
import { useFlowStore } from './flowStore'
import { impronta } from './documento'

type Stato = ReturnType<typeof useFlowStore.getState>
interface Passo {
  nodes:        Stato['nodes']
  edges:        Stato['edges']
  pool:         Stato['pool']
  environments: Stato['environments']
  f:            string
}

const LIMITE = 100
const RACCOLTA_MS = 350

let passato: Passo[] = []
let futuro: Passo[] = []
let corrente: Passo | null = null
let timer: ReturnType<typeof setTimeout> | null = null
/** Mentre si applica un passo, le modifiche non sono nuove modifiche. */
let applicando = false

interface StatoStoria { puoAnnullare: boolean; puoRipetere: boolean }
export const useStoria = create<StatoStoria>(() => ({ puoAnnullare: false, puoRipetere: false }))
const aggiorna = () => useStoria.setState({ puoAnnullare: passato.length > 0, puoRipetere: futuro.length > 0 })

function fotografa(): Passo {
  const s = useFlowStore.getState()
  return { nodes: s.nodes, edges: s.edges, pool: s.pool, environments: s.environments, f: impronta(s) }
}

/** Registra lo stato attuale come passo, se è davvero cambiato. */
function registra(): void {
  if (timer) { clearTimeout(timer); timer = null }
  const ora = fotografa()
  if (!corrente) { corrente = ora; return }
  if (ora.f === corrente.f) { corrente = ora; return }   // cambiato solo il transitorio
  passato.push(corrente)
  if (passato.length > LIMITE) passato.shift()
  futuro = []
  corrente = ora
  aggiorna()
}

useFlowStore.subscribe((s, p) => {
  if (applicando) return
  if (s.nodes !== p.nodes || s.edges !== p.edges || s.pool !== p.pool || s.environments !== p.environments) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(registra, RACCOLTA_MS)
  }
})

function applica(p: Passo): void {
  applicando = true
  try {
    const s = useFlowStore.getState()
    const ids = new Set(p.nodes.map((n) => n.id))
    useFlowStore.setState({
      nodes: p.nodes, edges: p.edges, pool: p.pool, environments: p.environments,
      // la selezione resta se il nodo esiste ancora
      selectedNodeId: s.selectedNodeId && ids.has(s.selectedNodeId) ? s.selectedNodeId : null,
      editingNodeId:  s.editingNodeId && ids.has(s.editingNodeId) ? s.editingNodeId : null,
    })
  } finally {
    applicando = false
  }
  corrente = p
  aggiorna()
}

export function annulla(): void {
  registra()   // una modifica ancora in raccolta diventa un passo, così si annulla quella
  const p = passato.pop()
  if (!p || !corrente) { aggiorna(); return }
  futuro.push(corrente)
  applica(p)
}

export function ripeti(): void {
  registra()
  if (futuro.length === 0) return   // una modifica nuova ha appena svuotato il futuro
  const p = futuro.pop()!
  if (corrente) passato.push(corrente)
  applica(p)
}

/** Open / New: storia vuota; il punto di partenza si prende ad assestamento avvenuto. */
export function azzeraStoria(): void {
  passato = []; futuro = []; corrente = null
  if (timer) clearTimeout(timer)
  timer = setTimeout(registra, RACCOLTA_MS + 100)
  aggiorna()
}

/** Il tasto va al canvas solo se il fuoco non è in un campo di testo o in un
 *  editor (che hanno il loro annulla). */
function fuocoInUnCampo(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable || !!el.closest('.monaco-editor')
}

export function installaScorciatoie(): () => void {
  const tasto = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return
    const k = e.key.toLowerCase()
    if (k !== 'z' && k !== 'y') return
    if (fuocoInUnCampo()) return
    e.preventDefault()
    if (k === 'y' || (k === 'z' && e.shiftKey)) ripeti()
    else annulla()
  }
  window.addEventListener('keydown', tasto)
  return () => window.removeEventListener('keydown', tasto)
}

// Punto di partenza: lo stato iniziale, ad assestamento avvenuto.
azzeraStoria()
