/**
 * src/nodes/types/dir_watcher/schema.ts
 *
 * Schema d'uscita del dir_watcher + sincronizzazione verso la valle.
 *
 * Il dir_watcher ha uno schema STATICO (i campi del file; in watch anche
 * `event` e `old_path`). A differenza delle altre sorgenti NON aveva alcun
 * pannello che scrivesse `props.outputSchema` e propagasse a valle: il
 * risultato è che tmap/log/mapping vedevano ZERO campi (la riga a runtime
 * aveva i dati, ma il design-time no).
 *
 * `useDirWatcherSchemaSync` replica ciò che fanno source_db/source_http/
 * transform: scrive `props.outputSchema` (lo leggono getHandleSchema e
 * readOutputSchema/resolveSourceSchema) E chiama `propagateSchema`, che
 * spinge i campi negli input dei tmap e negli incomingSchema a valle —
 * aggiornando anche gli edge GIÀ esistenti. Va agganciato da ENTRAMBI i
 * pannelli (Sidebar = mostrato alla selezione, Panel = modale), così lo
 * schema si sincronizza appena il nodo viene guardato.
 *
 * Allineato al motore: to_row / to_row_magra in
 * src-tauri/src/engine/nodes/dir_watcher.rs.
 */
import { useEffect } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { propagateSchema } from '../../../utils/schemaUtils'
import type { SchemaField } from '../../../ir/types'

export function dirWatcherFields(mode: string | undefined): SchemaField[] {
  const fields: SchemaField[] = [
    { id: 'dw_path',        name: 'path',        type: 'string',  physicalName: 'path'        },
    { id: 'dw_filename',    name: 'filename',    type: 'string',  physicalName: 'filename'    },
    { id: 'dw_extension',   name: 'extension',   type: 'string',  physicalName: 'extension'   },
    { id: 'dw_directory',   name: 'directory',   type: 'string',  physicalName: 'directory'   },
    { id: 'dw_size',        name: 'size',        type: 'integer', physicalName: 'size',        nullable: mode === 'watch' },
    { id: 'dw_created_at',  name: 'created_at',  type: 'date',    physicalName: 'created_at',  nullable: true },
    { id: 'dw_modified_at', name: 'modified_at', type: 'date',    physicalName: 'modified_at', nullable: true },
  ]
  if (mode === 'watch') {
    fields.push({ id: 'dw_event',    name: 'event',    type: 'string', physicalName: 'event'    })
    fields.push({ id: 'dw_old_path', name: 'old_path', type: 'string', physicalName: 'old_path', nullable: true })
  }
  return fields
}

export function useDirWatcherSchemaSync(nodeId: string): void {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const mode       = node?.data.props?.mode ?? 'scan'

  useEffect(() => {
    if (!node) return
    const fields = dirWatcherFields(mode)
    const next   = JSON.stringify(fields)
    // Scrive lo schema della sorgente (lo leggono getHandleSchema e
    // resolveSourceSchema) solo se cambiato, per non sporcare il piano.
    if (node.data.props.outputSchema !== next) {
      updateProp(nodeId, 'outputSchema', next)
    }
    // Spinge i campi a valle: input dei tmap + incomingSchema (anche edge
    // già esistenti).
    propagateSchema(nodeId, fields, useFlowStore.getState())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, mode])
}
