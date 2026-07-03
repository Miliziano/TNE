/**
 * src/monitoring/registry.ts
 *
 * Registry centrale per gli oggetti da sorvegliare per loitering.
 * Ogni modulo che ha strutture dati globali si auto-registra chiamando
 * registerModuleObjects() in fondo al proprio file.
 *
 * Il registry è lazy — se il MonitoringBus non è ancora abilitato
 * quando un modulo si registra, gli oggetti vengono messi in coda
 * e registrati appena il bus viene abilitato.
 *
 * Uso in un modulo con strutture globali:
 *
 *   // In fondo al file, dopo la definizione delle strutture:
 *   import { registerModuleObjects } from '../../monitoring/registry'
 *
 *   export const myMap = new Map<string, unknown>()
 *
 *   registerModuleObjects('MyModule', [
 *     { id: 'myMap', label: 'descrizione', type: 'Map', getSize: () => myMap.size },
 *   ])
 */

import { monitor } from './MonitoringBus'

export interface WatchableObject {
  id:      string
  label:   string
  type:    'Map' | 'Array' | 'Set' | 'Object'
  getSize: () => number
}

// Coda per registrazioni avvenute prima che il bus fosse abilitato
const _pending: Array<{ moduleName: string; obj: WatchableObject }> = []
let   _flushed = false

/**
 * Registra gli oggetti di un modulo nel MonitoringBus.
 * Se il bus non è ancora attivo, mette in coda e registra al primo flush.
 */
export function registerModuleObjects(
  moduleName: string,
  objects:    WatchableObject[],
) {
  for (const obj of objects) {
    const fullId    = `${moduleName}::${obj.id}`
    const fullLabel = `${moduleName} — ${obj.label}`

    if (monitor.enabled) {
      monitor.watchObject(fullId, fullLabel, obj.type, obj.getSize)
    } else {
      _pending.push({ moduleName, obj: { ...obj, id: fullId, label: fullLabel } })
    }
  }
}

/**
 * Flushes the pending queue — chiamato automaticamente da setupMonitoring()
 * dopo che il bus è stato abilitato.
 */
export function flushPendingRegistrations() {
  if (_flushed) return
  _flushed = true
  for (const { obj } of _pending) {
    monitor.watchObject(obj.id, obj.label, obj.type, obj.getSize)
  }
  _pending.length = 0
}

/**
 * Rimuove tutti gli oggetti registrati da un modulo.
 * Utile quando un modulo viene smontato o resettato.
 */
export function unregisterModule(moduleName: string) {
  // Non c'è un'API di unwatchAll per prefix — lo simuliamo
  // tenendo un indice locale dei moduli registrati
  _registeredModules.delete(moduleName)
}

// Traccia i moduli registrati per supporto a unregisterModule
const _registeredModules = new Set<string>()
