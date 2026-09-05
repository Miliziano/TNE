/**
 * src/components/HelpModal.tsx
 *
 * Help & Guide — placeholder container. Manuals, guided tours and an
 * assistant/wizard will live here. Kept intentionally simple for the beta.
 */
const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const panel: React.CSSProperties = {
  width: 620, maxWidth: '92vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
  background: '#161b26', border: '1px solid #2a3349', borderRadius: 10, overflow: 'hidden',
  boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
}
const ACCENT = '#4a9eff'

const card: React.CSSProperties = {
  background: '#0f1117', border: '0.5px solid #2a3349', borderRadius: 8, padding: '12px 14px',
  display: 'flex', alignItems: 'flex-start', gap: 10,
}

export function HelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>

        <div style={{ padding: '14px 18px', borderBottom: '1px solid #2a3349', display: 'flex', alignItems: 'center', gap: 10 }}>
          <i className="ti ti-help-circle" style={{ fontSize: 18, color: ACCENT }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e8ecf4' }}>Help &amp; Guide</div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#6a7690', cursor: 'pointer', fontSize: 18 }}>
            <i className="ti ti-x" />
          </button>
        </div>

        <div style={{ padding: '16px 18px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12, color: '#8a94a8', lineHeight: 1.6 }}>
            This is where documentation and help will live. Coming soon.
          </div>

          <div style={{ ...card, opacity: 0.6 }}>
            <i className="ti ti-book" style={{ fontSize: 18, color: ACCENT }} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#c8d4f0' }}>Manuals</div>
              <div style={{ fontSize: 11, color: '#6a7690' }}>Reference guides for nodes, the FPEL language and workflows.</div>
            </div>
          </div>

          <div style={{ ...card, opacity: 0.6 }}>
            <i className="ti ti-route" style={{ fontSize: 18, color: '#a78bfa' }} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#c8d4f0' }}>Guided tour</div>
              <div style={{ fontSize: 11, color: '#6a7690' }}>A step-by-step walkthrough to build your first pipeline.</div>
            </div>
          </div>

          <div style={{ ...card, opacity: 0.6 }}>
            <i className="ti ti-sparkles" style={{ fontSize: 18, color: '#f59e0b' }} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#c8d4f0' }}>Assistant</div>
              <div style={{ fontSize: 11, color: '#6a7690' }}>Ask questions and get help designing your flows.</div>
            </div>
          </div>
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid #2a3349', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose}
            style={{ padding: '7px 16px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                     background: `color-mix(in srgb, ${ACCENT} 22%, #0f1117)`, color: ACCENT, border: `0.5px solid ${ACCENT}55` }}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
