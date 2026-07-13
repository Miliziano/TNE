/**
 * src/nodes/types/union/UnionNode.tsx
 *
 * Pattern identico a TMapNode:
 * - handle "input_main" fisso — primo flusso
 * - handle "input_new" distaccato — aggiunge nuovi flussi (come TMap)
 * - handle "output" fisso a destra
 * - gli input aggiuntivi vengono aggiunti a unionInputs nel config
 *   dal connectionResolver, esattamente come TMap aggiunge a tmap.inputs
 */

import { memo, useCallback } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NodeRuntimeBadges } from '../../RuntimeBadges'
import type { NodeData } from '../../../types'
import { useFlowStore } from '../../../store/flowStore'

const ACCENT = '#a78bfa'

const INPUT_COLORS = [
  '#4a9eff',  // main — blu
  '#a78bfa',  // primo aggiuntivo — viola
  '#3ddc84',  // secondo — verde
  '#ffb347',  // terzo — arancione
  '#22d3ee',  // quarto — ciano
  '#f97316',  // quinto
  '#ff5f57',  // sesto
  '#84cc16',  // settimo
]

export interface UnionInput {
  id:    string
  label: string
  color: string
}

// Handle principale fisso — primo flusso
const MAIN_INPUT: UnionInput = {
  id:    'input_main',
  label: 'flusso_1',
  color: INPUT_COLORS[0],
}

export const UnionNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData       = data as NodeData
  const selectNode     = useFlowStore((s) => s.selectNode)
  const openNodeEditor = useFlowStore((s) => s.openNodeEditor)

  const handleClick       = useCallback(() => selectNode(id), [id, selectNode])
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    openNodeEditor(id)
  }, [id, openNodeEditor])

  // Input aggiuntivi — stessa struttura di tmap.inputs
  const extraInputs: UnionInput[] = (nodeData.config as any)?.unionInputs ?? []
  // Tutti gli input: main + aggiuntivi
  const allInputs: UnionInput[] = [MAIN_INPUT, ...extraInputs]

  const unionMode = nodeData.props?.['unionMode'] ?? 'concat'
  const modeLabel = unionMode === 'concat' ? 'CONCAT'
                  : unionMode === 'mix'    ? 'MIX'
                  : 'ZIP'
  const modeColor = unionMode === 'concat' ? ACCENT
                  : unionMode === 'mix'    ? '#4a9eff'
                  : '#3ddc84'

  const displayName = (nodeData.config as any)?.displayName || 'Union'

  const minHandles = allInputs.length
  const minHeight  = Math.max(100, minHandles * 28 + 60)

  const uiState = nodeData.uiState

  return (
    <div
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
   
      style={{
        minWidth:      160,
        minHeight,
        borderRadius:  8,
        border:        `1.5px solid ${selected ? ACCENT : '#2a1a4a'}`,
        background:    '#1e2535',
        boxShadow:     selected ? `0 0 0 2px ${ACCENT}35` : undefined,
        userSelect:    'none',
        cursor:        'pointer',
        position:      'relative',
        display:       'flex',
        flexDirection: 'column',
      }}>

      {/* Badge errori/warning */}
      {uiState && (uiState.hasErrors || uiState.hasWarnings) && (
        <UnionIRBadge uiState={uiState} />
      )}

      {/* Badge editor */}
      <div
        onClick={(e) => { e.stopPropagation(); openNodeEditor(id) }}
        title="Apri configurazione Union"
        style={{
          position: 'absolute', top: -8, right: -8,
          width: 20, height: 20, borderRadius: '50%',
          background: ACCENT, border: '2px solid #0f1117',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', zIndex: 10,
          boxShadow: `0 2px 6px ${ACCENT}60`,
        }}
      >
        <i className="ti ti-settings" style={{ fontSize: 10, color: '#fff' }} />
      </div>

      {/* ── Handle ingresso — uno per ogni input (main + aggiuntivi) ── */}
      {allInputs.map((inp, idx) => {
        const total = allInputs.length
        const pct   = total === 1 ? 50 : 10 + (idx / (total - 1)) * 80
        return (
          <Handle
            key={inp.id}
            id={inp.id}
            type="target"
            position={Position.Left}
            style={{
              top:        `${pct}%`,
              background: inp.color,
              border:     '2px solid #0f1117',
              width:      10,
              height:     10,
              left:       -5,
              transform:  'none',
            }}
            title={inp.label}
            isConnectable={true}
          />
        )
      })}

      {/* ── Handle speciale input_new — distaccato, stesso stile TMap ── */}
      <Handle
        id="input_new"
        type="target"
        position={Position.Left}
        style={{
          top:          '75%',
          background:   '#2a3349',
          border:       '2px dashed #4a5a7a',
          width:        12,
          height:       12,
          left:         -20,
          transform:    'none',
          borderRadius: '50%',
          opacity:      0.6,
        }}
        title="Trascina qui per aggiungere un nuovo flusso"
        isConnectable={true}
      />

      {/* Header */}
      <div style={{
        padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6,
        borderBottom: '1px solid #2a1a4a',
        background: selected ? `color-mix(in srgb, ${ACCENT} 12%, #1e2535)` : '#1e2535',
        borderRadius: '6px 6px 0 0', flexShrink: 0,
      }}>
        <span style={{ fontSize: 16, color: ACCENT }}>⊕</span>
        <span style={{ color: ACCENT, fontWeight: 600, fontSize: 12, flex: 1 }}>
          {displayName}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, color: modeColor,
          padding: '1px 5px', borderRadius: 4,
          background: `color-mix(in srgb, ${modeColor} 12%, #0f1117)`,
          border: `0.5px solid ${modeColor}40`, flexShrink: 0,
        }}>
          {modeLabel}
        </span>
      </div>

      {/* Body */}
      <div style={{ padding: '6px 10px', flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {allInputs.map((inp) => (
            <div key={inp.id} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: inp.color }} />
              <span style={{ fontSize: 10, fontFamily: 'monospace', color: inp.color }}>
                {inp.label}
              </span>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 5, opacity: 0.4, marginTop: 2 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, border: '1px dashed #4a5a7a' }} />
          <span style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic' }}>+ nuovo flusso</span>
        </div>

        <div style={{
          marginTop: 4, fontSize: 10, color: '#4a5a7a',
          fontFamily: 'monospace', textAlign: 'center',
          borderTop: '0.5px solid #2a3349', paddingTop: 4,
        }}>
          {allInputs.length} flussi → 1 output
        </div>
      </div>

      {/* Handle uscita */}
      <Handle
        id="output"
        type="source"
        position={Position.Right}
        style={{
          top: '50%', background: ACCENT,
          border: '2px solid #0f1117', width: 10, height: 10,
          right: -5, transform: 'none',
        }}
        title="output"
        isConnectable={true}
      />

    {/* Fase 8: contatori runtime */}
      <NodeRuntimeBadges nodeId={id} />

    </div>
  )
})

UnionNode.displayName = 'UnionNode'

// ─── Badge errori/warning ─────────────────────────────────────────
interface UIState {
  hasErrors?:    boolean
  errorCount?:   number
  hasWarnings?:  boolean
  warningCount?: number
  issues?:       Array<{ severity: string; message: string; code: string }>
}

function UnionIRBadge({ uiState }: { uiState: UIState }) {
  const color = uiState.hasErrors ? '#ff5f57' : '#ffb347'
  const count = uiState.hasErrors ? uiState.errorCount : uiState.warningCount
  const icon  = uiState.hasErrors ? 'ti-alert-circle' : 'ti-alert-triangle'
  return (
    <div style={{ position: 'absolute', top: -8, left: -8, zIndex: 10 }}>
      <div style={{ width: 18, height: 18, borderRadius: '50%', background: color, border: '2px solid #0f1117', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 6px ${color}80` }}>
        <i className={`ti ${icon}`} style={{ fontSize: 10, color: '#0f1117' }} />
        {(count ?? 0) > 1 && (
          <span style={{ position: 'absolute', top: -4, right: -4, background: color, color: '#0f1117', fontSize: 10, fontWeight: 700, borderRadius: 8, padding: '0 3px', minWidth: 12, textAlign: 'center', lineHeight: '12px', border: '1px solid #0f1117' }}>
           {count}
          </span>
        )}
      </div>
    </div>
  )
}

export { INPUT_COLORS as UNION_FLOW_COLORS }