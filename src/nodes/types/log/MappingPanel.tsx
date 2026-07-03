/**
 * src/nodes/types/log/MappingPanel.tsx
 *
 * Mostra i campi che transitano nel nodo Log.
 * Sola lettura — il Log non trasforma i dati.
 * Include template builder con tutti i campi selezionabili.
 */
import { useState } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../../nodes/useIncomingSchema'
import { CustomSelect } from '../../../components/CustomSelect'

const ACCENT = '#a78bfa'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}

export function LogMappingPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const fields     = useIncomingSchema(nodeId)

  const [viewMode, setViewMode] = useState<'list' | 'table'>('list')

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def

  const logTemplate = p('logTemplate')

  // Inserisce {campo} nel template alla posizione corrente del cursore
  const insertField = (fieldName: string) => {
    const current = p('logTemplate')
    updateProp(nodeId, 'logTemplate', current + `{${fieldName}}`)
  }

  // Seleziona tutti i campi — costruisce un template con tutti
  const buildFullTemplate = () => {
    const tmpl = fields.map((f) => `${f.name}={${f.name}}`).join(' | ')
    updateProp(nodeId, 'logTemplate', tmpl)
  }

  // Formato tabellare — allinea le colonne
  const buildTableTemplate = () => {
    const tmpl = fields.map((f) => `{${f.name}}`).join('\t')
    updateProp(nodeId, 'logTemplate', tmpl)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Info passthrough */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
        <div style={{ fontWeight: 600, color: ACCENT, marginBottom: 2 }}>
          📋 Log — passthrough
        </div>
        Tutti i campi transitano <strong style={{ color: '#c8d4f0' }}>invariati</strong> — il nodo Log non modifica né filtra i dati.
        Lo schema di uscita è identico allo schema di ingresso.
      </div>

      {/* Template builder */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.08em' }}>
          Template messaggio log
        </div>
        <textarea
          style={{ ...inputStyle, minHeight: 54, resize: 'vertical', fontFamily: 'monospace' }}
          value={logTemplate}
          onChange={(e) => updateProp(nodeId, 'logTemplate', e.target.value)}
          placeholder="id={id} nome={nome} — lascia vuoto per loggare la riga intera come JSON"
          spellCheck={false} />

        {/* Pulsanti template rapido */}
        {fields.length > 0 && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={buildFullTemplate}
              style={{ flex: 1, padding: '4px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 12%, #1a2030)`, color: ACCENT, border: `0.5px solid ${ACCENT}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
              <i className="ti ti-checks" style={{ fontSize: 10 }} /> Tutti i campi (key=value)
            </button>
            <button onClick={buildTableTemplate}
              style={{ flex: 1, padding: '4px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#4a5a7a', border: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = ACCENT; (e.currentTarget as HTMLElement).style.borderColor = ACCENT }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a'; (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
              <i className="ti ti-table" style={{ fontSize: 10 }} /> Formato tab-separated
            </button>
            <button onClick={() => updateProp(nodeId, 'logTemplate', '')}
              style={{ padding: '4px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a0000', color: '#ff5f57', border: '0.5px solid #3d1010' }}>
              <i className="ti ti-x" style={{ fontSize: 10 }} />
            </button>
          </div>
        )}
      </div>

      {/* Campi disponibili */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.08em' }}>
          Campi in transito — {fields.length}
        </div>
        {/* Toggle vista */}
        {fields.length > 0 && (
          <div style={{ display: 'flex', gap: 3 }}>
            {(['list', 'table'] as const).map((mode) => (
              <button key={mode} onClick={() => setViewMode(mode)}
                style={{ padding: '2px 8px', fontSize: 9, borderRadius: 4, cursor: 'pointer', background: viewMode === mode ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030', color: viewMode === mode ? ACCENT : '#4a5a7a', border: viewMode === mode ? `1px solid ${ACCENT}50` : '1px solid #2a3349' }}>
                <i className={`ti ${mode === 'list' ? 'ti-list' : 'ti-table'}`} style={{ fontSize: 9, marginRight: 3 }} />
                {mode === 'list' ? 'Lista' : 'Tabella'}
              </button>
            ))}
          </div>
        )}
      </div>

      {fields.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-plug-connected-x" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} />
          Collega un nodo in ingresso per vedere i campi disponibili.
        </div>
      ) : viewMode === 'table' ? (
        // ── Vista tabellare ──────────────────────────────────────
        <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 100px', gap: 0, background: '#1a2030', borderBottom: '0.5px solid #3a4a6a' }}>
            {['Campo', 'Tipo', 'Fisico', 'Inserisci'].map((h) => (
              <div key={h} style={{ padding: '5px 10px', fontSize: 9, color: ACCENT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', borderRight: '0.5px solid #2a3349' }}>
                {h}
              </div>
            ))}
          </div>
          {fields.map((f, i, arr) => (
            <div key={f.name}
              style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px 100px', gap: 0, background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
              <div style={{ padding: '5px 10px', borderRight: '0.5px solid #2a3349' }}>
                <code style={{ fontFamily: 'monospace', fontSize: 11, color: ACCENT }}>{f.name}</code>
              </div>
              <div style={{ padding: '5px 10px', borderRight: '0.5px solid #2a3349' }}>
                <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 6, background: '#0f1117', color: '#4a5a7a' }}>{f.type}</span>
              </div>
              <div style={{ padding: '5px 10px', borderRight: '0.5px solid #2a3349' }}>
                <code style={{ fontSize: 9, color: '#4a5a7a', fontFamily: 'monospace' }}>{f.physicalName ?? f.name}</code>
              </div>
              <div style={{ padding: '5px 10px', display: 'flex', justifyContent: 'center' }}>
                <button onClick={() => insertField(f.name)}
                  style={{ padding: '2px 8px', fontSize: 9, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 10%, #0f1117)`, color: ACCENT, border: `0.5px solid ${ACCENT}30`, fontFamily: 'monospace' }}
                  title={`Inserisci {${f.name}} nel template`}>
                  + {'{' + f.name + '}'}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        // ── Vista lista ──────────────────────────────────────────
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {fields.map((f) => (
            <div key={f.name}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349' }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: ACCENT, flexShrink: 0 }} />
              <code style={{ fontFamily: 'monospace', fontSize: 11, color: ACCENT, flex: 1 }}>{f.name}</code>
              <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 6, background: '#0f1117', color: '#4a5a7a', flexShrink: 0 }}>{f.type}</span>
              <span style={{ fontSize: 9, color: '#2a3349', flexShrink: 0, fontFamily: 'monospace' }}>→ invariato</span>
              <button onClick={() => insertField(f.name)}
                style={{ padding: '1px 7px', fontSize: 9, borderRadius: 6, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 10%, #0f1117)`, color: ACCENT, border: `0.5px solid ${ACCENT}30`, fontFamily: 'monospace', flexShrink: 0 }}
                title={`Inserisci {${f.name}} nel template`}>
                {'{' + f.name + '}'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Nota schema uscita */}
      {fields.length > 0 && (
        <div style={{ padding: '6px 10px', fontSize: 9, color: '#4a5a7a', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', display: 'flex', gap: 5, alignItems: 'center' }}>
          <i className="ti ti-check" style={{ fontSize: 9, color: '#22d3ee' }} />
          Schema di uscita identico — {fields.length} campi propagati ai nodi a valle.
        </div>
      )}
    </div>
  )
}
