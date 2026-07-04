import { memo, useCallback, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NodeRuntimeBadges } from './RuntimeBadges'
import type { NodeData, TMapConfig } from '../types'
import { useFlowStore } from '../store/flowStore'
import { TMapModal } from './types/tmap/TMapModal'

const OUTPUT_COLORS = [
  '#3ddc84', '#ff5f57', '#4a9eff', '#ffb347', '#a78bfa', '#22d3ee',
]

export const TMapNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData   = data as NodeData
  const selectNode = useFlowStore((s) => s.selectNode)
  const [showModal, setShowModal] = useState(false)

  const tmap = nodeData.config?.tmap as TMapConfig | undefined

  const inputs  = tmap?.inputs ?? [
    { id: 'input_main', label: 'main', isMain: true, joinType: 'none' as const, fields: [] },
  ]
  const outputs = tmap?.outputs ?? [
    { id: 'output_main',     label: 'main_out', color: '#3ddc84', fields: [] },
    { id: 'output_rejected', label: 'rejected',  color: '#ff5f57', fields: [] },
  ]

  const handleClick       = useCallback(() => selectNode(id), [id, selectNode])
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setShowModal(true)
  }, [])

  const displayName = nodeData.config?.displayName || 'TMap'
  const shortLabel  = nodeData.config?.shortLabel  || `${inputs.length} in · ${outputs.length} out`

  const minHandles = Math.max(inputs.length, outputs.length)
  const minHeight  = Math.max(100, minHandles * 28 + 60)

  const uiState = nodeData.uiState

  return (
    <div
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      title="TMap — doppio click per aprire l'editor"
      style={{
        minWidth:     170,
        minHeight,
        borderRadius: 8,
        border:       `1.5px solid ${selected ? '#a78bfa' : '#2a1a4a'}`,
        background:   '#1e2535',
        boxShadow:    selected ? '0 0 0 2px rgba(167,139,250,0.35)' : undefined,
        userSelect:   'none',
        cursor:       'pointer',
        position:     'relative',
        display:      'flex',
        flexDirection: 'column',
      }}
    >
      {/* ── Badge IR errori/warning ── */}
      {uiState && (uiState.hasErrors || uiState.hasWarnings) && (
        <IRBadge uiState={uiState} />
      )}

      {/* ── Badge editor — sempre visibile, angolo in alto a destra ── */}
      <div
        onClick={(e) => { e.stopPropagation(); setShowModal(true) }}
        title="Apri editor TMap"
        style={{
          position:       'absolute',
          top:            -8,
          right:          -8,
          width:          20,
          height:         20,
          borderRadius:   '50%',
          background:     '#a78bfa',
          border:         '2px solid #0f1117',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          cursor:         'pointer',
          zIndex:         10,
          boxShadow:      '0 2px 6px rgba(167,139,250,0.4)',
        }}
      >
        <i className="ti ti-edit" style={{ fontSize: 10, color: '#fff' }} />
      </div>

      {/* ── Handle ingresso — uno per ogni input ── */}
      {inputs.map((inp, idx) => {
        const total = inputs.length
        const pct   = total === 1 ? 50 : 10 + (idx / (total - 1)) * 80
        const color = inp.isMain ? '#4a9eff' : '#ffb347'
        return (
          <Handle
            key={inp.id}
            id={inp.id}
            type="target"
            position={Position.Left}
            style={{
              top:        `${pct}%`,
              background: color,
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

      {/* ── Handle speciale per nuove connessioni ── */}
      <Handle
        id="input_new"
        type="target"
        position={Position.Left}
        style={{
          top:         '75%',
          background:  '#2a3349',
          border:      '2px dashed #4a5a7a',
          width:       12,
          height:      12,
          left:        -20,
          transform:   'none',
          borderRadius: '50%',
          opacity:     0.6,
        }}
        title="Trascina qui per aggiungere un nuovo input"
      />

      {/* ── Header ── */}
      <div style={{
        padding:      '6px 10px',
        display:      'flex',
        alignItems:   'center',
        gap:          6,
        borderBottom: '1px solid #2a1a4a',
        background:   selected ? 'color-mix(in srgb, #a78bfa 12%, #1e2535)' : '#1e2535',
        borderRadius: '6px 6px 0 0',
        flexShrink:   0,
      }}>
        <span style={{ fontSize: 16, color: '#a78bfa' }}>⇌</span>
        <span style={{ color: '#a78bfa', fontWeight: 600, fontSize: 12, flex: 1 }}>
          {displayName}
        </span>
        {/* Dot di stato — non sovrapposto al badge editor */}
        <div style={{
          width:        7,
          height:       7,
          borderRadius: '50%',
          background:   nodeData.status === 'running' ? '#ffb347'
                      : nodeData.status === 'done'    ? '#3ddc84'
                      : nodeData.status === 'error'   ? '#ff5f57'
                      : '#4a5a7a',
          flexShrink:   0,
          animation:    nodeData.status === 'running' ? 'nodePulse 0.6s infinite' : undefined,
        }} />
      </div>

      {/* ── Body ── */}
      <div style={{ padding: '6px 10px', flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>

        {/* Lista inputs */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {inputs.map((inp) => (
            <div key={inp.id} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{
                width:        6,
                height:       6,
                borderRadius: '50%',
                flexShrink:   0,
                background:   inp.isMain ? '#4a9eff' : '#ffb347',
              }} />
              <span style={{
                fontSize:   10,
                fontFamily: 'monospace',
                color:      inp.isMain ? '#4a9eff' : '#ffb347',
              }}>
                {inp.label}
              </span>
              {!inp.isMain && (
                <span style={{ fontSize: 9, color: '#4a5a7a' }}>{inp.joinType}</span>
              )}
            </div>
          ))}
        </div>

        <div style={{ borderTop: '0.5px solid #2a3349', margin: '2px 0' }} />

        {/* Lista outputs */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {outputs.map((out, idx) => (
            <div key={out.id} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{
                width:        6,
                height:       6,
                borderRadius: '50%',
                flexShrink:   0,
                background:   out.color ?? OUTPUT_COLORS[idx % OUTPUT_COLORS.length],
              }} />
              <span style={{
                fontSize:   10,
                fontFamily: 'monospace',
                color:      out.color ?? OUTPUT_COLORS[idx % OUTPUT_COLORS.length],
                flex:       1,
              }}>
                {out.label}
              </span>
              <span style={{ fontSize: 9, color: '#4a5a7a' }}>
                {out.fields.length}
              </span>
            </div>
          ))}
        </div>

        <div style={{
          marginTop:  4,
          fontSize:   10,
          color:      '#4a5a7a',
          fontFamily: 'monospace',
          textAlign:  'center',
          borderTop:  '0.5px solid #2a3349',
          paddingTop: 4,
        }}>
          {shortLabel}
        </div>
      </div>

      {/* ── Handle uscita per ogni output ── */}
      {outputs.map((out, idx) => {
        const total = outputs.length
        const pct   = total === 1 ? 50 : 10 + (idx / (total - 1)) * 80
        const color = out.color ?? OUTPUT_COLORS[idx % OUTPUT_COLORS.length]
        return (
          <Handle
            key={out.id}
            id={out.id}
            type="source"
            position={Position.Right}
            style={{
              top:        `${pct}%`,
              background: color,
              border:     '2px solid #0f1117',
              width:      10,
              height:     10,
              right:      -5,
              transform:  'none',
            }}
            title={out.label}
            isConnectable={true}
          />
        )
      })}

      {showModal && <TMapModal nodeId={id} onClose={() => setShowModal(false)} />}
    {/* Fase 8: contatori runtime */}
      <NodeRuntimeBadges nodeId={id} />
    </div>
  )
})

TMapNode.displayName = 'TMapNode'

// ─── IRBadge (inline per evitare import circolare) ────────────────
interface UIState {
  hasErrors?:    boolean
  errorCount?:   number
  hasWarnings?:  boolean
  warningCount?: number
  issues?:       Array<{ severity: string; message: string; code: string }>
}

function IRBadge({ uiState }: { uiState: UIState }) {
  const [show, setShow] = useState(false)
  const color = uiState.hasErrors ? '#ff5f57' : '#ffb347'
  const count = uiState.hasErrors ? uiState.errorCount : uiState.warningCount
  const icon  = uiState.hasErrors ? 'ti-alert-circle' : 'ti-alert-triangle'
  return (
    <div
      style={{ position: 'absolute', top: -8, left: -8, zIndex: 10 }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <div style={{
        width: 18, height: 18, borderRadius: '50%',
        background: color, border: '2px solid #0f1117',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: `0 0 6px ${color}80`,
      }}>
        <i className={`ti ${icon}`} style={{ fontSize: 9, color: '#0f1117' }} />
        {(count ?? 0) > 1 && (
          <span style={{ position: 'absolute', top: -4, right: -4, background: color, color: '#0f1117', fontSize: 9, fontWeight: 700, borderRadius: 8, padding: '0 3px', minWidth: 12, textAlign: 'center', lineHeight: '12px', border: '1px solid #0f1117' }}>
            {count}
          </span>
        )}
      </div>
      {show && (uiState.issues?.length ?? 0) > 0 && (
        <div style={{ position: 'absolute', top: 22, left: 0, minWidth: 220, maxWidth: 280, background: '#1a2030', border: `1px solid ${color}60`, borderRadius: 6, padding: '4px 0', boxShadow: '0 8px 24px rgba(0,0,0,.7)', zIndex: 1000, pointerEvents: 'none' }}>
          {uiState.issues!.map((issue, i) => (
            <div key={i} style={{ padding: '4px 10px', fontSize: 10, color: issue.severity === 'error' ? '#ff5f57' : '#ffb347', borderBottom: i < uiState.issues!.length - 1 ? '0.5px solid #2a3349' : 'none', display: 'flex', gap: 6 }}>
              <i className={`ti ${issue.severity === 'error' ? 'ti-alert-circle' : 'ti-alert-triangle'}`} style={{ fontSize: 10, flexShrink: 0 }} />
              <span style={{ lineHeight: 1.4 }}>{issue.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}