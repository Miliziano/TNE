/**
 * src/store/documento.ts
 *
 * MODIFICHE NON SALVATE (P396). Il progetto è "modificato" quando ciò che si
 * salverebbe nel file (pool, nodi, archi, profili) è diverso da ciò che è
 * stato aperto o salvato l'ultima volta. Prima non lo sapeva nessuno: Open,
 * la chiusura della finestra e Clear buttavano il lavoro senza chiedere.
 *
 * L'impronta esclude ciò che cambia da solo e non è lavoro dell'utente: lo
 * stato di esecuzione dei nodi, i badge del validatore, la selezione, le
 * misure che React Flow aggiunge ai nodi.
 *
 * Dopo un'apertura il canvas si assesta (normalizzazione dei nodi,
 * propagazione degli schemi): la base si prende quando smette di cambiare,
 * così un progetto appena aperto non risulta già modificato.
 */
import { create } from 'zustand'
import { useFlowStore } from './flowStore'
import { isTauri } from '../lib/tauri'

const CHIAVI_DATI_TRANSITORIE = new Set(['status', 'statusMessage', 'uiState'])
const CHIAVI_NODO_TRANSITORIE = new Set(['selected', 'dragging', 'measured', 'resizing'])
const CHIAVI_ARCO_TRANSITORIE = new Set(['selected', 'animated'])

type Stato = ReturnType<typeof useFlowStore.getState>

/** Ciò che finisce nel file, senza le parti transitorie. */
export function impronta(s: Pick<Stato, 'pool' | 'nodes' | 'edges' | 'environments'>): string {
  const senza = (o: Record<string, unknown>, via: Set<string>) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => !via.has(k)))
  return JSON.stringify({
    pool: s.pool,
    environments: s.environments,
    nodes: s.nodes.map((n) => ({
      ...senza(n as unknown as Record<string, unknown>, CHIAVI_NODO_TRANSITORIE),
      data: senza(n.data as Record<string, unknown>, CHIAVI_DATI_TRANSITORIE),
    })),
    edges: s.edges.map((e) => senza(e as unknown as Record<string, unknown>, CHIAVI_ARCO_TRANSITORIE)),
  })
}

interface StatoDocumento { modificato: boolean }
export const useDocumento = create<StatoDocumento>(() => ({ modificato: false }))

let base: string | null = null
/** Dopo un'apertura: la base si prende quando il canvas si è assestato. */
let inAttesa = true
let timer: ReturnType<typeof setTimeout> | null = null
const ASSESTAMENTO_MS = 400

function controlla() {
  timer = null
  const f = impronta(useFlowStore.getState())
  if (inAttesa || base === null) { base = f; inAttesa = false; useDocumento.setState({ modificato: false }); return }
  const m = f !== base
  if (m !== useDocumento.getState().modificato) useDocumento.setState({ modificato: m })
}
function programma() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(controlla, ASSESTAMENTO_MS)
}

useFlowStore.subscribe((s, p) => {
  if (s.nodes !== p.nodes || s.edges !== p.edges || s.pool !== p.pool || s.environments !== p.environments) programma()
})
programma()

/** Il progetto è appena stato salvato così com'è. */
export function segnaSalvato(): void {
  if (timer) { clearTimeout(timer); timer = null }
  base = impronta(useFlowStore.getState())
  inAttesa = false
  useDocumento.setState({ modificato: false })
}

/** Il canvas è stato sostituito (Open, New): la base si riprende ad assestamento avvenuto. */
export function segnaCaricato(): void {
  inAttesa = true
  useDocumento.setState({ modificato: false })
  programma()
}

/** Modificato adesso (senza aspettare l'assestamento). */
export function modificatoOra(): boolean {
  if (inAttesa || base === null) return false
  return impronta(useFlowStore.getState()) !== base
}

/** Domanda sì/no con il dialogo del sistema (nel browser: confirm). */
export async function chiedi(testo: string, titolo: string, ok: string): Promise<boolean> {
  if (isTauri()) {
    try {
      const { ask } = await import('@tauri-apps/plugin-dialog')
      return await ask(testo, { title: titolo, kind: 'warning', okLabel: ok, cancelLabel: 'Cancel' })
    } catch { /* dialogo non disponibile: si ripiega sul confirm del browser */ }
  }
  return window.confirm(testo)
}

/** Chiede il permesso di buttare le modifiche non salvate, se ce ne sono.
 *  `azione` completa la frase: "… before {azione}". */
export async function puoiScartare(azione: string): Promise<boolean> {
  if (!modificatoOra()) return true
  return chiedi(`The project has unsaved changes. Discard them and ${azione}?`, 'Unsaved changes', 'Discard changes')
}
