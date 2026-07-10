/**
 * src/runner/errorHandlerExecutor.ts
 *
 * Executor per il nodo Error Handler.
 *
 * Il nodo Error Handler non elabora righe nel flusso "normale" —
 * non ha handle di ingresso ed è il collettore implicito degli
 * errori della lane (vedi errorHandling.ts).
 *
 * Questo executor è quindi un no-op: esiste solo per evitare il
 * warning "Nodo non supportato — saltato" quando runLane lo
 * processa nel ciclo principale (ha 0 predecessori → eseguito
 * come ogni altro nodo sorgente).
 *
 * L'output reale sull'handle 'error_out' viene popolato DOPO,
 * da processErrorHandler() in runner/index.ts, che:
 *  1. legge context.errorRows.get(errorHandlerNode.id) — le righe
 *     accumulate da routeToErrorHandler() durante l'esecuzione
 *     della lane (vedi errorHandling.ts)
 *  2. le scrive su outputs.set(errorHandlerNode.id, new Map([['error_out', errorRows]]))
 *  3. esegue la sotto-pipeline collegata a 'error_out' (se presente)
 *
 * Questo executor non interferisce con quel passo: il suo output
 * 'output' (vuoto) viene semplicemente sovrascritto.
 */

import type { NodeExecutor } from '../io/types'

export const errorHandlerExecutor: NodeExecutor = {
  handles: ['error_handler'],

  async execute(_node, _input, _context) {
    return new Map([['output', []]])
  },
}
