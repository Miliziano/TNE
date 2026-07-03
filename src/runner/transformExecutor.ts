/**
 * src/runner/transformExecutor.ts
 *
 * Modifiche rispetto alla versione precedente:
 * - context tipizzato correttamente (ExecutionContext invece di any)
 * - lane disponibile nelle espressioni custom via buildLaneProxy
 * - context.lane come alias identico a Script e TMap
 * - Retrocompatibile con vecchio MapPanel (fieldMappings e outputSchema)
 */

import type { Row, NodeExecutor, ExecutionContext } from './types'
import { buildLaneProxy } from './types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import { getPresetsForType, evalPreset, type FieldType } from '../transforms/presets'

interface TransformField {
  id:         string
  source:     string
  output:     string
  type:       FieldType
  presetId:   string
  params:     Record<string, string>
  expression: string
  enabled:    boolean
}

export const transformExecutor: NodeExecutor = {
  handles: ['map', 'transform'],

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {
    const props = node.data.props ?? {}

    // ── 1. Legge transformFields (nuovo panel) ────────────────
    let fields: TransformField[] = []
    try {
      const raw = props['transformFields'] as string | undefined
      if (raw) {
        fields = JSON.parse(raw).map((f: any) => ({
          ...f,
          presetId:   f.presetId ?? f.transform ?? 'passthrough',
          params:     f.params ?? {},
          expression: f.expression ?? '',
        }))
      }
    } catch {}

    // ── 2. Fallback: vecchio fieldMappings ────────────────────
    if (fields.length === 0) {
      try {
        const raw = props['fieldMappings'] as string | undefined
        if (raw) {
          fields = JSON.parse(raw).map((m: any) => ({
            id:         m.id,
            source:     m.source,
            output:     m.target,
            type:       'any' as FieldType,
            presetId:   m.transform === 'none'       ? 'passthrough'
                      : m.transform === 'expression' ? 'expr'
                      : m.transform ?? 'passthrough',
            params:     {},
            expression: m.expression ?? '',
            enabled:    true,
          }))
        }
      } catch {}
    }

    // ── 3. Fallback: outputSchema passthrough ─────────────────
    if (fields.length === 0) {
      try {
        const schema = JSON.parse(props['outputSchema'] as string ?? '[]') as Array<{
          name: string; physicalName?: string; sourceField?: string
        }>
        if (schema.length > 0) {
          fields = schema.map(s => ({
            id:         s.name,
            source:     s.sourceField ?? s.physicalName ?? s.name,
            output:     s.name,
            type:       'any' as FieldType,
            presetId:   'passthrough',
            params:     {},
            expression: '',
            enabled:    true,
          }))
        }
      } catch {}
    }

    const unmappedMode = (props['unmappedFields'] as string) ?? 'drop'
    const activeFields = fields.filter(f => f.enabled && f.source)

    if (activeFields.length === 0 && unmappedMode === 'passthrough') {
      return new Map([['output', input]])
    }

    // ── Proxy lane — stesso pattern di Script e TMap ──────────
    // Disponibile nelle espressioni custom come `lane.*` e `context.lane.*`
    const lane       = buildLaneProxy(node.data.laneId, context)
    const contextObj = { lane }

    const output: Row[] = input.map(row => {
      const newRow: Row = {}

      // Campi non mappati in passthrough
      if (unmappedMode === 'passthrough') {
        const mapped = new Set(activeFields.map(f => f.source))
        for (const k of Object.keys(row)) {
          if (!mapped.has(k)) newRow[k] = row[k]
        }
      }

      for (const field of activeFields) {
        const rawValue = row[field.source]
        let result: unknown

        if (field.presetId === 'expr' && field.expression.trim()) {
          // Espressione custom — lane e context.lane disponibili
          // Stessa sintassi di TMap inline: lane.counter++, context.lane.prefix, ecc.
          try {
            result = new Function(
              'row', 'v', 'lane', 'context',
              `"use strict"; return (${field.expression})`
            )(row, rawValue, lane, contextObj)
          } catch (e) {
            context.callbacks.onLog('warn',
              `Transform [${field.output}]: errore espressione — ${e instanceof Error ? e.message : String(e)}`,
              node.id,
            )
            result = rawValue
          }
        } else {
          // Preset da catalogo
          const presets = getPresetsForType(field.type)
          const preset  = presets.find(p => p.id === field.presetId)
          if (preset) {
            try {
              result = evalPreset(preset, rawValue, field.params)
            } catch (e) {
              context.callbacks.onLog('warn',
                `Transform [${field.output}]: errore preset '${field.presetId}' — ${e instanceof Error ? e.message : String(e)}`,
                node.id,
              )
              result = rawValue
            }
          } else {
            result = rawValue
          }
        }

        if (field.output.trim()) {
          newRow[field.output.trim()] = result
        }
      }

      return newRow
    })

    context.callbacks.onLog('info',
      `Transform: ${input.length} righe, ${activeFields.length} campi`,
      node.id,
    )

    return new Map([['output', output]])
  },
}