/**
 * src/hooks/useVirtualList.ts
 *
 * Hook di virtualizzazione minimale per liste con altezza riga fissa.
 * Nessuna dipendenza esterna — calcola quali indici sono visibili
 * nello scroll container e restituisce solo quelli da renderizzare,
 * con un offset per posizionare correttamente lo scroll totale.
 *
 * FIX: containerRef ora è una callback ref invece di un useRef normale.
 * Con createPortal il nodo DOM può diventare disponibile dopo che il
 * primo useEffect con dipendenze [] è già girato — un useRef('null')
 * non causa re-render, quindi l'effect del ResizeObserver partiva
 * con containerRef.current ancora null e non veniva mai ritentato.
 * La callback ref invece scatta esattamente quando React collega/
 * scollega il nodo, garantendo che il ResizeObserver venga sempre
 * agganciato all'elemento corretto.
 *
 * Uso (INVARIATO per i componenti chiamanti):
 *   const { containerRef, visibleRange, totalHeight, offsetY } =
 *     useVirtualList({ itemCount: rows.length, itemHeight: 22, overscan: 8 })
 *
 *   <div ref={containerRef} style={{ overflowY: 'auto', height: H }}>
 *     <div style={{ height: totalHeight, position: 'relative' }}>
 *       <div style={{ position: 'absolute', top: offsetY, left: 0, right: 0 }}>
 *         {rows.slice(visibleRange.start, visibleRange.end).map(row => ...)}
 *       </div>
 *     </div>
 *   </div>
 */

import { useState, useRef, useCallback, useEffect } from 'react'

export interface UseVirtualListOptions {
  /** Numero totale di elementi nella lista */
  itemCount:  number
  /** Altezza fissa di ogni riga in px */
  itemHeight: number
  /** Righe extra renderizzate sopra/sotto la viewport — riduce flicker durante scroll veloce */
  overscan?:  number
}

export interface VirtualRange {
  start: number  // indice incluso
  end:   number  // indice escluso
}

export interface UseVirtualListResult {
  /** Callback ref da assegnare al div scrollabile — NON un RefObject,
   *  ma una funzione (ref={containerRef} funziona comunque allo stesso modo in JSX) */
  containerRef: (node: HTMLDivElement | null) => void
  /** Range di indici da renderizzare effettivamente */
  visibleRange: VirtualRange
  /** Altezza totale virtuale — serve per dare la dimensione corretta allo scrollbar */
  totalHeight:  number
  /** Offset verticale del blocco renderizzato rispetto al top */
  offsetY:      number
  /** Forza lo scroll in fondo — utile per auto-scroll */
  scrollToBottom: () => void
  /** true se l'utente è vicino al fondo (entro `bottomThreshold` px) */
  isNearBottom: boolean
  /** Riferimento diretto al nodo DOM corrente — utile se il componente
   *  chiamante ha bisogno di leggere scrollHeight/scrollTop direttamente
   *  (es. per il proprio onScroll locale) */
  containerEl: HTMLDivElement | null
}

export function useVirtualList({
  itemCount,
  itemHeight,
  overscan = 6,
}: UseVirtualListOptions): UseVirtualListResult {
  // State invece di useRef — un cambio di state causa re-render e
  // permette agli useEffect con [containerEl] come dipendenza di
  // ripartire esattamente quando il nodo DOM diventa disponibile.
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null)

  const containerRef = useCallback((node: HTMLDivElement | null) => {
    setContainerEl(node)
  }, [])

  const [scrollTop, setScrollTop]       = useState(0)
  const [viewportH, setViewportH]       = useState(0)
  const [isNearBottom, setIsNearBottom] = useState(true)

  // Misura altezza viewport quando il nodo diventa disponibile e su ogni resize
  useEffect(() => {
    if (!containerEl) return
    const update = () => setViewportH(containerEl.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(containerEl)
    return () => ro.disconnect()
  }, [containerEl])

  const handleScroll = useCallback(() => {
    if (!containerEl) return
    setScrollTop(containerEl.scrollTop)
    const distFromBottom = containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight
    setIsNearBottom(distFromBottom < itemHeight * 2)
  }, [itemHeight, containerEl])

  useEffect(() => {
    if (!containerEl) return
    containerEl.addEventListener('scroll', handleScroll, { passive: true })
    return () => containerEl.removeEventListener('scroll', handleScroll)
  }, [handleScroll, containerEl])

  const totalHeight = itemCount * itemHeight

  // Fallback: se il container non è ancora stato misurato, mostra
  // comunque un blocco iniziale di righe invece di renderizzare zero
  // elementi — evita il "flash nero" iniziale.
  const effectiveViewportH = viewportH > 0 ? viewportH : 400

  const startIdx = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan)
  const visibleCount = Math.ceil(effectiveViewportH / itemHeight) + overscan * 2
  const endIdx = Math.min(itemCount, startIdx + visibleCount)

  const offsetY = startIdx * itemHeight

  const scrollToBottom = useCallback(() => {
    if (!containerEl) return
    containerEl.scrollTop = containerEl.scrollHeight
    setScrollTop(containerEl.scrollTop)
    const distFromBottom = containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight
    setIsNearBottom(distFromBottom < itemHeight * 2)
  }, [itemHeight, containerEl])

  return {
    containerRef,
    visibleRange: { start: startIdx, end: endIdx },
    totalHeight,
    offsetY,
    scrollToBottom,
    isNearBottom,
    containerEl,
  }
}