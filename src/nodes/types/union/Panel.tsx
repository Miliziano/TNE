/**
 * src/nodes/types/union/Panel.tsx
 */
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'

const ACCENT = '#a78bfa'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}
function SectionTitle({ label, color = ACCENT }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}

export function UnionPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const edges      = useFlowStore((s) => s.edges)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  const unionMode = p('unionMode', 'concat')

  // Edge in ingresso attualmente collegati
  const inEdges = edges.filter((e) => e.target === nodeId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
        <span style={{ color: ACCENT, fontWeight: 600 }}>⊕ Union</span> — fonde N flussi in uno.
        Collega i flussi sorgente agli handle di ingresso numerati sul lato sinistro del nodo.
        Un nuovo handle appare automaticamente quando tutti quelli esistenti sono connessi.
      </div>

      {/* Flussi collegati */}
      <SectionTitle label={`Flussi in ingresso — ${inEdges.length} collegati`} />
      {inEdges.length === 0 ? (
        <div style={{ padding: '12px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          Collega almeno due flussi agli handle sul lato sinistro del nodo.
        </div>
      ) : (
        <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          {inEdges.map((e, i) => (
            <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < inEdges.length - 1 ? '0.5px solid #2a3349' : 'none' }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: ACCENT, flexShrink: 0 }} />
              <code style={{ fontFamily: 'monospace', fontSize: 10, color: ACCENT, flex: 1 }}>
                handle: {e.targetHandle ?? 'input'}
              </code>
              <code style={{ fontFamily: 'monospace', fontSize: 9, color: '#4a5a7a' }}>
                da: {e.source}
              </code>
            </div>
          ))}
        </div>
      )}

      {/* Modalità union */}
      <SectionTitle label="Modalità" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          {
            value: 'concat',
            label: '▤ Concatena',
            desc:  'Un flusso dopo l\'altro — il secondo inizia solo dopo che il primo è terminato. Richiede stesso schema.',
            detail: 'Ordine di emissione: input_1 completo → input_2 completo → ... Utile per unire file o dataset dello stesso tipo.',
          },
          {
            value: 'mix',
            label: '⇄ Interleave',
            desc:  'Le righe dei flussi si mescolano nell\'ordine di arrivo. Accetta schemi diversi.',
            detail: 'L\'ordine non è garantito — dipende dalla velocità di ciascun flusso. Utile per merge di stream in tempo reale.',
          },
          {
            value: 'zip',
            label: '↕ Zip',
            desc:  'Unisce le righe per posizione — riga 1 di A con riga 1 di B. Richiede stesso numero di righe.',
            detail: 'Produce una riga per ogni coppia di righe corrispondenti. Se i flussi hanno lunghezze diverse, le righe in eccesso vengono scartate o riempite con null.',
          },
        ].map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'unionMode', m.value)}
            style={{ padding: '10px 12px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3, background: unionMode === m.value ? `color-mix(in srgb, ${ACCENT} 12%, #1a2030)` : '#1a2030', border: unionMode === m.value ? `1.5px solid ${ACCENT}` : '1px solid #2a3349' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: unionMode === m.value ? ACCENT : '#c8d4f0' }}>{m.label}</div>
            <div style={{ fontSize: 10, color: unionMode === m.value ? ACCENT : '#4a9eff', fontWeight: 600 }}>{m.desc}</div>
            <div style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.4 }}>{m.detail}</div>
          </button>
        ))}
      </div>

      {/* Opzioni per modalità */}
      {unionMode === 'mix' && (
        <>
          <Field label="Campo sorgente" hint="Aggiunge un campo con il nome del flusso sorgente per tracciabilità">
            <CustomSelect style={inputStyle} value={p('addSourceField', 'true')} onChange={u('addSourceField')}>
              <option value="true">Sì — aggiungi campo _union_source</option>
              <option value="false">No — non aggiungere campo sorgente</option>
            </CustomSelect>
          </Field>
          {p('addSourceField', 'true') === 'true' && (
            <Field label="Nome campo sorgente">
              <input style={{ ...inputStyle, color: ACCENT }} value={p('sourceFieldName', '_union_source')}
                onChange={u('sourceFieldName')} placeholder="_union_source" />
            </Field>
          )}
          <Field label="Schema mancante su campo" hint="Come gestire campi presenti in alcuni flussi ma non in altri">
            <CustomSelect style={inputStyle} value={p('missingField', 'null')} onChange={u('missingField')}>
              <option value="null">Scrivi null — campo presente ma nullo</option>
              <option value="omit">Ometti — campo assente nel record</option>
              <option value="error">Errore — richiede schema identico</option>
            </CustomSelect>
          </Field>
        </>
      )}

      {unionMode === 'zip' && (
        <>
          <Field label="Su flussi di lunghezza diversa">
            <CustomSelect style={inputStyle} value={p('zipMismatch', 'truncate')} onChange={u('zipMismatch')}>
              <option value="truncate">Tronca — scarta le righe in eccesso del flusso più lungo</option>
              <option value="pad_null">Padding null — riempie con null le righe mancanti</option>
              <option value="error">Errore — richiede stessa lunghezza</option>
            </CustomSelect>
          </Field>
        </>
      )}

      {unionMode === 'concat' && (
        <Field label="Su schema non compatibile">
          <CustomSelect style={inputStyle} value={p('schemaMismatch', 'error')} onChange={u('schemaMismatch')}>
            <option value="error">Errore — richiede schema identico</option>
            <option value="coerce">Coerce — tenta di adattare i tipi</option>
            <option value="ignore">Ignora — emetti le righe così come sono</option>
          </CustomSelect>
        </Field>
      )}

      {/* Ordinamento output */}
      {unionMode !== 'zip' && (
        <Field label="Ordinamento output" hint="Solo per modalità concat e interleave">
          <CustomSelect style={inputStyle} value={p('outputOrder', 'natural')} onChange={u('outputOrder')}>
            <option value="natural">Naturale — ordine di arrivo</option>
            <option value="field_asc">Per campo ASC (specifica sotto)</option>
            <option value="field_desc">Per campo DESC (specifica sotto)</option>
          </CustomSelect>
        </Field>
      )}
      {(p('outputOrder') === 'field_asc' || p('outputOrder') === 'field_desc') && (
        <Field label="Campo di ordinamento">
          <input style={inputStyle} value={p('orderField')} onChange={u('orderField')} placeholder="data_creazione" />
        </Field>
      )}

      {/* Output */}
      <SectionTitle label="Output del nodo" color="#4a5a7a" />
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a', lineHeight: 1.8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 9, padding: '1px 8px', borderRadius: 8, background: `color-mix(in srgb, ${ACCENT} 15%, #0f1117)`, color: ACCENT, border: `0.5px solid ${ACCENT}40` }}>output</span>
          <span style={{ fontSize: 9 }}>Flusso unificato di tutte le righe dai flussi in ingresso</span>
        </div>
      </div>
    </div>
  )
}
