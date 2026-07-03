/**
 * src/nodes/types/dir_watcher/Panel.tsx
 */
import { useMemo, useEffect } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import type { Variable } from '../../../types'
import { CustomSelect } from '../../../components/CustomSelect'

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
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}
function SectionTitle({ label, color = '#22d3ee' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}

const ACCENT = '#22d3ee'

const OUTPUT_SCHEMA = [
  { name: 'path',        type: 'string',  desc: 'Path assoluto del file'         },
  { name: 'filename',    type: 'string',  desc: 'Nome file con estensione'       },
  { name: 'extension',   type: 'string',  desc: 'Estensione senza punto'         },
  { name: 'directory',   type: 'string',  desc: 'Directory contenitore'          },
  { name: 'size',        type: 'integer', desc: 'Dimensione in bytes'            },
  { name: 'created_at',  type: 'date',    desc: 'Data creazione'                 },
  { name: 'modified_at', type: 'date',    desc: 'Data ultima modifica'           },
]
const WATCH_EXTRA = { name: 'event', type: 'string', desc: 'Tipo evento SO (create/modify/delete)' }

const PROP_DEFAULTS: Record<string, string> = {
  mode:            'scan',
  pathSource:      'static',
  pattern:         '*',
  recursive:       'false',
  minSize:         '0',
  maxAgeMin:       '0',
  stabilityMs:     '500',
  debounceMs:      '300',
  watchTimeoutSec: '300',
  events:          'create',
  dedup:           'path',
  dedupStore:      'memory',
  sortBy:          'name',
  sortDir:         'asc',
  limit:           '0',
  checkLocked:     'false',
}

export function DirWatcherPanel({ nodeId }: { nodeId: string }) {
  const node           = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp     = useFlowStore((s) => s.updateNodeProp)
  const updateAdvanced = useFlowStore((s) => s.updateNodeAdvanced)
  const edges          = useFlowStore((s) => s.edges)
  const pool           = useFlowStore((s) => s.pool)

  // ── Inizializza prop mancanti al primo render ─────────────────
  useEffect(() => {
    if (!node) return
    for (const [key, val] of Object.entries(PROP_DEFAULTS)) {
      if (node.data.props[key] === undefined || node.data.props[key] === null) {
        updateProp(nodeId, key, val)
      }
    }
    // Inizializza anche timeoutSec in advanced se mancante
    if (!node.data.config?.advanced?.timeoutSec) {
      updateAdvanced(nodeId, 'timeoutSec', '300')
    }
  }, [nodeId])

  if (!node) return null

  const p   = (key: string, def = '') => node.data.props[key] ?? def
  const u   = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  // Il valore effettivo del timeout — fonte di verità: adv.timeoutSec
  // props.watchTimeoutSec è il mirror per l'executor
  const advTimeout   = String(node.data.config?.advanced?.timeoutSec ?? '300')
  const watchTimeout = p('watchTimeoutSec', advTimeout)
  // Usa advTimeout come fonte primaria se i due sono allineati
  const displayTimeout = advTimeout || watchTimeout

  // Handler timeout: aggiorna entrambe le strutture
  const handleTimeoutChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    updateProp(nodeId, 'watchTimeoutSec', val)       // per l'executor
    updateAdvanced(nodeId, 'timeoutSec', val)         // per tab Avanzate
  }

  const mode       = p('mode', 'scan')
  const pathSource = p('pathSource', 'static')
  const hasInput   = edges.some((e) => e.target === nodeId)

  const laneVars: Variable[] = useMemo(() => {
    const lane = pool.lanes.find((l) => l.id === node.data.laneId)
    return (lane?.variables ?? []).filter(
      (v) => v.type === 'string' || v.type === 'object'
    )
  }, [pool, node.data.laneId])

  const schema = mode === 'watch' ? [...OUTPUT_SCHEMA, WATCH_EXTRA] : OUTPUT_SCHEMA

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      <SectionTitle label="Modalità" />
      <div style={{ display: 'flex', gap: 6 }}>
        {[
          { value: 'scan',  label: '⊞ Scan',  desc: 'Enumera file esistenti in una directory' },
          { value: 'watch', label: '👁 Watch', desc: 'Ascolta eventi del SO per nuovi file'    },
        ].map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'mode', m.value)}
            style={{
              flex: 1, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
              background: mode === m.value ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030',
              border: mode === m.value ? `1px solid ${ACCENT}` : '1px solid #2a3349',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            }}>
            <span style={{ fontSize: 12, color: mode === m.value ? ACCENT : '#4a5a7a', fontWeight: 600 }}>{m.label}</span>
            <span style={{ fontSize: 9, color: mode === m.value ? '#7a9aaa' : '#2a3349', textAlign: 'center' }}>{m.desc}</span>
          </button>
        ))}
      </div>

      <SectionTitle label="Sorgente path directory" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          { value: 'static',   label: '📁 Statico',       desc: 'Path configurato direttamente qui sotto' },
          { value: 'lane_var', label: '◎ Variabile Lane', desc: 'Legge il path da una variabile della lane' },
          { value: 'flow',     label: '→ Da flusso',      desc: 'Usa il campo path da ogni riga in ingresso (richiede edge)' },
        ].map((s) => {
          const disabled = s.value === 'flow' && !hasInput
          return (
            <button key={s.value}
              onClick={() => { if (!disabled) updateProp(nodeId, 'pathSource', s.value) }}
              style={{
                padding: '7px 10px', borderRadius: 6,
                cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
                background: pathSource === s.value ? `color-mix(in srgb, ${ACCENT} 12%, #1a2030)` : '#1a2030',
                border: pathSource === s.value ? `1px solid ${ACCENT}60` : '1px solid #2a3349',
                display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
              }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: pathSource === s.value ? ACCENT : '#2a3349' }} />
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: pathSource === s.value ? ACCENT : '#c8d4f0' }}>{s.label}</div>
                <div style={{ fontSize: 9, color: '#4a5a7a' }}>{s.desc}{disabled ? ' — collega un edge prima' : ''}</div>
              </div>
            </button>
          )
        })}
      </div>

      {pathSource === 'static' && (
        <Field label="Directory" hint="Path assoluto della directory da osservare">
          <input style={inputStyle} value={p('directory')} onChange={u('directory')} placeholder="/data/incoming" />
        </Field>
      )}
      {pathSource === 'lane_var' && (
        <Field label="Variabile Lane" hint="Variabile di tipo stringa che contiene il path della directory">
          {laneVars.length > 0 ? (
            <CustomSelect style={inputStyle} value={p('laneVarName')} onChange={u('laneVarName')}>
              <option value="">— seleziona variabile —</option>
              {laneVars.map((v) => (
                <option key={v.id} value={v.name}>{v.name} {v.value ? `= "${v.value}"` : '(vuota)'}</option>
              ))}
            </CustomSelect>
          ) : (
            <div style={{ fontSize: 10, color: '#ff5f57', fontStyle: 'italic', padding: '4px 0' }}>
              Nessuna variabile stringa disponibile in questa lane.
            </div>
          )}
        </Field>
      )}
      {pathSource === 'flow' && (
        <Field label="Campo path dal flusso" hint="Nome del campo della riga che contiene il path della directory">
          <input style={inputStyle} value={p('pathField', 'path')} onChange={u('pathField')} placeholder="path" />
        </Field>
      )}

      <SectionTitle label="Filtri file" />
      <Row>
        <Field label="Pattern" hint="Glob — es: *.csv, data_*.json">
          <input style={inputStyle} value={p('pattern', '*')} onChange={u('pattern')} placeholder="*.csv" />
        </Field>
        <Field label="Ricorsivo">
          <CustomSelect style={inputStyle} value={p('recursive', 'false')} onChange={u('recursive')}>
            <option value="false">No — solo root</option>
            <option value="true">Sì — include subdir</option>
          </CustomSelect>
        </Field>
      </Row>
      <Row>
        <Field label="Dim. min (bytes)" hint="0 = nessun limite">
          <input type="number" style={inputStyle} value={p('minSize', '0')} onChange={u('minSize')} min="0" />
        </Field>
        <Field label="Età max (minuti)" hint="0 = nessun limite">
          <input type="number" style={inputStyle} value={p('maxAgeMin', '0')} onChange={u('maxAgeMin')} min="0" />
        </Field>
      </Row>

      <SectionTitle label="Integrità e deduplicazione" />
      <Field label="Anti-bumping (deduplicazione)" hint="Evita di emettere lo stesso file più volte nella stessa esecuzione">
        <CustomSelect style={inputStyle} value={p('dedup', 'path')} onChange={u('dedup')}>
          <option value="none">Disabilitato</option>
          <option value="path">Per path — stesso path non viene riemesso</option>
          <option value="hash">Per hash contenuto — rileva anche rinominati</option>
          <option value="path_mtime">Path + data modifica — riemette se il file è cambiato</option>
        </CustomSelect>
      </Field>
      {p('dedup') !== 'none' && (
        <Field label="Persistenza deduplicazione" hint="Dove tenere traccia dei file già emessi">
          <CustomSelect style={inputStyle} value={p('dedupStore', 'memory')} onChange={u('dedupStore')}>
            <option value="memory">In memoria — si azzera a ogni esecuzione</option>
            <option value="file">Su file — persiste tra esecuzioni</option>
          </CustomSelect>
        </Field>
      )}
      {p('dedup') !== 'none' && p('dedupStore') === 'file' && (
        <Field label="Path file stato" hint="File JSON dove salvare i path già processati">
          <input style={inputStyle} value={p('dedupFile', '.flowpilot_dw_state.json')} onChange={u('dedupFile')}
            placeholder=".flowpilot_dw_state.json" />
        </Field>
      )}

      {/* Opzioni Watch */}
      {mode === 'watch' && (
        <>
          <SectionTitle label="Opzioni Watch" />
          <Row>
            <Field label="Eventi">
              <CustomSelect style={inputStyle} value={p('events', 'create')} onChange={u('events')}>
                <option value="create">Solo nuovi file</option>
                <option value="create,modify">Nuovi + modifiche</option>
                <option value="all">Tutti gli eventi</option>
              </CustomSelect>
            </Field>
            <Field label="Debounce (ms)" hint="Attesa prima di processare — evita eventi doppi">
              <input type="number" style={inputStyle} value={p('debounceMs', '300')} onChange={u('debounceMs')} min="0" />
            </Field>
          </Row>
          <Row>
            <Field label="Stabilità file (ms)" hint="Attende che il file non cambi prima di emetterlo">
              <input type="number" style={inputStyle} value={p('stabilityMs', '500')} onChange={u('stabilityMs')} min="0" />
            </Field>
            <Field
              label="Timeout watch (secondi)"
              hint="Sincronizzato con Timeout nel tab Avanzate — 0 = infinito"
            >
              <input
                type="number"
                style={{ ...inputStyle, borderColor: `${ACCENT}60` }}
                value={displayTimeout}
                onChange={handleTimeoutChange}
                min="0"
              />
            </Field>
          </Row>
          {displayTimeout === '0' && (
            <div style={{ padding: '6px 10px', background: '#0d1a10', borderRadius: 4, border: '0.5px solid #3ddc8430', fontSize: 9, color: '#3ddc8490', display: 'flex', gap: 6 }}>
              <i className="ti ti-info-circle" style={{ fontSize: 10, flexShrink: 0 }} />
              Timeout 0 = rimane attivo finché non clicchi Stop.
            </div>
          )}
          <div style={{ padding: '5px 8px', background: '#0f1117', borderRadius: 4, border: `0.5px solid ${ACCENT}20`, fontSize: 9, color: '#4a5a7a', display: 'flex', gap: 5 }}>
            <i className="ti ti-refresh" style={{ fontSize: 9, color: ACCENT, flexShrink: 0 }} />
            Sincronizzato con <strong style={{ color: ACCENT }}>Timeout</strong> nel tab Avanzate.
          </div>
        </>
      )}

      {/* Opzioni Scan */}
      {mode === 'scan' && (
        <>
          <SectionTitle label="Opzioni Scan" />
          <Row>
            <Field label="Ordinamento">
              <CustomSelect style={inputStyle} value={p('sortBy', 'name')} onChange={u('sortBy')}>
                <option value="name">Nome file</option>
                <option value="created">Data creazione</option>
                <option value="modified">Data modifica</option>
                <option value="size">Dimensione</option>
              </CustomSelect>
            </Field>
            <Field label="Direzione">
              <CustomSelect style={inputStyle} value={p('sortDir', 'asc')} onChange={u('sortDir')}>
                <option value="asc">Crescente</option>
                <option value="desc">Decrescente</option>
              </CustomSelect>
            </Field>
          </Row>
          <Field label="Limite file" hint="0 = nessun limite">
            <input type="number" style={inputStyle} value={p('limit', '0')} onChange={u('limit')} min="0" />
          </Field>
        </>
      )}

      <SectionTitle label="Schema output (row by row)" />
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}30` }}>
        <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
          Ogni file produce una riga con questi campi
        </div>
        {schema.map((f, i) => (
          <div key={f.name} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', borderBottom: i < schema.length - 1 ? '0.5px solid #1a2030' : 'none' }}>
            <code style={{ fontSize: 10, color: ACCENT, minWidth: 100, flexShrink: 0 }}>{f.name}</code>
            <span style={{ fontSize: 9, color: '#4a5a7a', minWidth: 50, flexShrink: 0 }}>{f.type}</span>
            <span style={{ fontSize: 9, color: '#2a3349' }}>{f.desc}</span>
          </div>
        ))}
      </div>

      <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a', display: 'flex', gap: 6 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, color: ACCENT, flexShrink: 0, marginTop: 1 }} />
        Il nodo emette una riga per ogni file trovato/rilevato. Collega l'uscita a un nodo <code style={{ color: ACCENT }}>File Input</code> che usa il campo <code style={{ color: ACCENT }}>path</code> per leggere ogni file.
      </div>
    </div>
  )
}