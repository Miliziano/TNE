/**
 * src/nodes/types/webhook/schema.ts
 *
 * Schema d'uscita del webhook_receiver + sincronizzazione verso la valle.
 *
 * Il receiver ha uno schema STATICO: i campi fissi di ogni evento (i campi
 * del payload appiattiti in root sono DINAMICI e non prevedibili a
 * design-time, quindi non entrano nello schema propagato). Come il
 * dir_watcher prima di P100, il pannello MOSTRAVA lo schema ma nessuno
 * scriveva `props.outputSchema` né lo propagava → tmap/log/mapping a valle
 * vedevano ZERO campi (a runtime la Row ha i dati, ma il design-time no).
 *
 * `useWebhookReceiverSchemaSync` fa ciò che fanno source_db/http/dir_watcher:
 * scrive `props.outputSchema` (lo leggono getHandleSchema e
 * readOutputSchema/resolveSourceSchema) E chiama `propagateSchema`, che
 * spinge i campi negli input dei tmap e negli incomingSchema a valle,
 * aggiornando anche gli edge GIÀ esistenti.
 *
 * ⚠️ Il webhook_receiver NON ha un pannello sidebar (si configura solo dal
 * modale), quindi l'hook vive nel ReceiverPanel: lo schema si sincronizza
 * quando l'utente apre il pannello del nodo almeno una volta (è lì che si
 * imposta porta/path/secret, quindi nel flusso normale scatta prima di
 * cablare la valle).
 *
 * Allineato al motore: la Row emessa da
 * src-tauri/src/engine/nodes/webhook_receiver.rs.
 */
import { useEffect } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { propagateSchema } from '../../../utils/schemaUtils'
import type { SchemaField } from '../../../ir/types'

export function webhookReceiverFields(): SchemaField[] {
  return [
    { id: 'wh_event_id',        name: 'event_id',        type: 'string',  physicalName: 'event_id'        },
    { id: 'wh_event_type',      name: 'event_type',      type: 'string',  physicalName: 'event_type'      },
    { id: 'wh_source_ip',       name: 'source_ip',       type: 'string',  physicalName: 'source_ip'       },
    { id: 'wh_webhook_path',    name: 'webhook_path',    type: 'string',  physicalName: 'webhook_path'    },
    { id: 'wh_payload',         name: 'payload',         type: 'object',  physicalName: 'payload'         },
    { id: 'wh_headers',         name: 'headers',         type: 'object',  physicalName: 'headers'         },
    { id: 'wh_received_at',     name: 'received_at',     type: 'date',    physicalName: 'received_at'     },
    { id: 'wh_signature_valid', name: 'signature_valid', type: 'boolean', physicalName: 'signature_valid', nullable: true },
  ]
}

export function useWebhookReceiverSchemaSync(nodeId: string): void {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)

  useEffect(() => {
    if (!node) return
    const fields = webhookReceiverFields()
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
  }, [nodeId])
}
