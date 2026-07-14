import { useState } from 'react'

// ─── Tipo condiviso ───────────────────────────────────────────────
// Fonte unica di verità: prima era duplicato (interface UIState) in ~10
// file-nodo. node.data.uiState è scritto da applyIssuesToCanvas (pipeline).
export interface UIState {
  hasErrors?:    boolean
  errorCount?:   number
  hasWarnings?:  boolean
  warningCount?: number
  issues?:       Array<{ severity: string; message: string; code: string; hint?: string }>
}

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

function cornerStyle(corner: Corner): React.CSSProperties {
  switch (corner) {
    case 'top-right':    return { top: -8, right: -8 }
    case 'bottom-left':  return { bottom: -8, left: -8 }
    case 'bottom-right': return { bottom: -8, right: -8 }
    case 'top-left':
    default:             return { top: -8, left: -8 }
  }
}

// ─── Badge di validazione (errori/warning) ────────────────────────
// Badge unico per tutti i nodi. Contiene la guardia: se non ci sono
// errori né warning ritorna null, quindi al call-site basta
// <ValidationBadge uiState={nodeData.uiState} /> senza condizioni.
// `corner` per i nodi che hanno l'angolo top-left già occupato.
export function ValidationBadge({
  uiState,
  corner = 'top-left',
}: {
  uiState?: UIState
  corner?:  Corner
}) {
  const [show, setShow] = useState(false)
  if (!uiState || (!uiState.hasErrors && !uiState.hasWarnings)) return null

  const color = uiState.hasErrors ? '#ff5f57' : '#ffb347'
  const count = uiState.hasErrors ? uiState.errorCount : uiState.warningCount

  return (
    <div style={{ position: 'absolute', ...cornerStyle(corner), zIndex: 10 }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <div style={{ width: 18, height: 18, borderRadius: '50%', background: color, border: '2px solid #0f1117', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 6px ${color}80` }}>
        <i className={`ti ${uiState.hasErrors ? 'ti-alert-circle' : 'ti-alert-triangle'}`} style={{ fontSize: 10, color: '#0f1117' }} />
        {(count ?? 0) > 1 && <span style={{ position: 'absolute', top: -4, right: -4, background: color, color: '#0f1117', fontSize: 10, fontWeight: 700, borderRadius: 8, padding: '0 3px', minWidth: 12, textAlign: 'center', lineHeight: '12px', border: '1px solid #0f1117' }}>{count}</span>}
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
