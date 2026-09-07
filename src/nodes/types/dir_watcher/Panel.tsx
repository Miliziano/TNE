/**
 * src/nodes/types/dir_watcher/Panel.tsx
 */
import { useMemo, useEffect } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useDirWatcherSchemaSync } from './schema'
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
      {hint && <div style={{ fontSize: 10, color: '#8593b5', fontStyle: 'italic' }}>{hint}</div>}
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
  { name: 'path',        type: 'string',  desc: 'Absolute file path'         },
  { name: 'filename',    type: 'string',  desc: 'File name with extension'       },
  { name: 'extension',   type: 'string',  desc: 'Extension without dot'         },
  { name: 'directory',   type: 'string',  desc: 'Container directory'          },
  { name: 'size',        type: 'integer', desc: 'Size in bytes'            },
  { name: 'created_at',  type: 'date',    desc: 'Creation date'                 },
  { name: 'modified_at', type: 'date',    desc: 'Last modified date'           },
]
const WATCH_EXTRA = { name: 'event',    type: 'string', desc: 'new / update / rename / delete' }
const WATCH_OLDP  = { name: 'old_path', type: 'string', desc: 'Path precedente (solo rename atomico), altrimenti null' }

const PROP_DEFAULTS: Record<string, string> = {
  mode:            'scan',
  submode:         'oneshot',
  pathSource:      'static',
  pattern:         '*',
  recursive:       'false',
  minSize:         '0',
  maxAgeMin:       '0',
  stabilityMs:     '500',
  debounceMs:      '300',
  watchTimeoutSec: '300',
  events:          'all',
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

  // Schema d'uscita → props.outputSchema + propagazione a valle (vedi schema.ts).
  useDirWatcherSchemaSync(nodeId)

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

  const schema = mode === 'watch' ? [...OUTPUT_SCHEMA, WATCH_EXTRA, WATCH_OLDP] : OUTPUT_SCHEMA

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      <SectionTitle label="Mode" />
      <div style={{ display: 'flex', gap: 6 }}>
        {[
          { value: 'scan',  label: '⊞ Scan',  desc: 'Enumerates existing files in a directory' },
          { value: 'watch', label: '👁 Watch', desc: 'Listens to OS events for new files'    },
        ].map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'mode', m.value)}
            style={{
              flex: 1, padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
              background: mode === m.value ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030',
              border: mode === m.value ? `1px solid ${ACCENT}` : '1px solid #2a3349',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            }}>
            <span style={{ fontSize: 12, color: mode === m.value ? ACCENT : '#8593b5', fontWeight: 600 }}>{m.label}</span>
            <span style={{ fontSize: 9, color: mode === m.value ? '#7a9aaa' : '#2a3349', textAlign: 'center' }}>{m.desc}</span>
          </button>
        ))}
      </div>

      <SectionTitle label="Directory path source" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          { value: 'static',   label: '📁 Static',       desc: 'Path configured directly below' },
          { value: 'lane_var', label: '◎ Lane variable', desc: 'Reads the path from a lane variable' },
          { value: 'flow',     label: '→ From flow',      desc: 'Uses the path field from each incoming row (requires edge)' },
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
                <div style={{ fontSize: 9, color: '#8593b5' }}>{s.desc}{disabled ? ' — connect an edge first' : ''}</div>
              </div>
            </button>
          )
        })}
      </div>

      {pathSource === 'static' && (
        <Field label="Directory" hint="Absolute path of the directory to watch">
          <input style={inputStyle} value={p('directory')} onChange={u('directory')} placeholder="/data/incoming" />
        </Field>
      )}
      {pathSource === 'lane_var' && (
        <Field label="Lane variable" hint="String variable that contains the directory path">
          {laneVars.length > 0 ? (
            <CustomSelect style={inputStyle} value={p('laneVarName')} onChange={u('laneVarName')}>
              <option value="">— select variable —</option>
              {laneVars.map((v) => (
                <option key={v.id} value={v.name}>{v.name} {v.value ? `= "${v.value}"` : '(empty)'}</option>
              ))}
            </CustomSelect>
          ) : (
            <div style={{ fontSize: 10, color: '#ff5f57', fontStyle: 'italic', padding: '4px 0' }}>
              No string variable available in this lane.
            </div>
          )}
        </Field>
      )}
      {pathSource === 'flow' && (
        <Field label="Path field from flow" hint="Name of the row field that contains the directory path">
          <input style={inputStyle} value={p('pathField', 'path')} onChange={u('pathField')} placeholder="path" />
        </Field>
      )}

      <SectionTitle label="File filters" />
      <Row>
        <Field label="Pattern" hint="Glob — e.g. *.csv, data_*.json">
          <input style={inputStyle} value={p('pattern', '*')} onChange={u('pattern')} placeholder="*.csv" />
        </Field>
        <Field label="Recursive">
          <CustomSelect style={inputStyle} value={p('recursive', 'false')} onChange={u('recursive')}>
            <option value="false">No — root only</option>
            <option value="true">Yes — include subdir</option>
          </CustomSelect>
        </Field>
      </Row>
      <Row>
        <Field label="Min size (bytes)" hint="0 = no limit">
          <input type="number" style={inputStyle} value={p('minSize', '0')} onChange={u('minSize')} min="0" />
        </Field>
        <Field label="Max age (minutes)" hint="0 = no limit">
          <input type="number" style={inputStyle} value={p('maxAgeMin', '0')} onChange={u('maxAgeMin')} min="0" />
        </Field>
      </Row>

      <SectionTitle label="Integrity and deduplication" />
      <Field label="Anti-bumping (deduplication)" hint="Avoids emitting the same file multiple times in the same run">
        <CustomSelect style={inputStyle} value={p('dedup', 'path')} onChange={u('dedup')}>
          <option value="none">Disabled</option>
          <option value="path">By path — same path is not re-emitted</option>
          <option value="hash">By content hash — also detects renamed files</option>
          <option value="path_mtime">Path + modified date — re-emits if the file changed</option>
        </CustomSelect>
      </Field>
      {p('dedup') !== 'none' && (
        <Field label="Deduplication persistence" hint="Where to track already-emitted files">
          <CustomSelect style={inputStyle} value={p('dedupStore', 'memory')} onChange={u('dedupStore')}>
            <option value="memory">In memory — resets each run</option>
            <option value="file">To file — persists across runs</option>
          </CustomSelect>
        </Field>
      )}
      {p('dedup') !== 'none' && p('dedupStore') === 'file' && (
        <Field label="State file path" hint="JSON file where already-processed paths are saved">
          <input style={inputStyle} value={p('dedupFile', '.flowpilot_dw_state.json')} onChange={u('dedupFile')}
            placeholder=".flowpilot_dw_state.json" />
        </Field>
      )}

      {/* Opzioni Watch */}
      {mode === 'watch' && (
        <>
          <SectionTitle label="Watch options" />
          <Field label="Listening" hint="One-shot: waits for a batch of events, emits and ends. Continuous: the lane re-runs for each group of events (with commit) until you press Stop.">
            <CustomSelect style={inputStyle} value={p('submode', 'oneshot')} onChange={u('submode')}>
              <option value="oneshot">Once (one-shot)</option>
              <option value="continuo">Continuous (per session)</option>
            </CustomSelect>
          </Field>
          <Row>
            <Field label="Events">
              <CustomSelect style={inputStyle} value={p('events', 'all')} onChange={u('events')}>
                <option value="new">New files only</option>
                <option value="new,update">New + updates</option>
                <option value="all">All (new/update/rename/delete)</option>
              </CustomSelect>
            </Field>
            <Field label="Debounce (ms)" hint="Wait before processing — avoids duplicate events">
              <input type="number" style={inputStyle} value={p('debounceMs', '300')} onChange={u('debounceMs')} min="0" />
            </Field>
          </Row>
          <Row>
            <Field label="File stability (ms)" hint="Waits for the file to stop changing before emitting it">
              <input type="number" style={inputStyle} value={p('stabilityMs', '500')} onChange={u('stabilityMs')} min="0" />
            </Field>
            <Field
              label="Watch timeout (seconds)"
              hint="Synced with Timeout in the Advanced tab — 0 = infinite"
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
              Timeout 0 = stays active until you click Stop.
            </div>
          )}
          <div style={{ padding: '5px 8px', background: '#0f1117', borderRadius: 4, border: `0.5px solid ${ACCENT}20`, fontSize: 9, color: '#8593b5', display: 'flex', gap: 5 }}>
            <i className="ti ti-refresh" style={{ fontSize: 9, color: ACCENT, flexShrink: 0 }} />
            Synced with <strong style={{ color: ACCENT }}>Timeout</strong> in the Advanced tab.
          </div>
        </>
      )}

      {/* Opzioni Scan */}
      {mode === 'scan' && (
        <>
          <SectionTitle label="Scan options" />
          <Row>
            <Field label="Sorting">
              <CustomSelect style={inputStyle} value={p('sortBy', 'name')} onChange={u('sortBy')}>
                <option value="name">File name</option>
                <option value="created">Creation date</option>
                <option value="modified">Modified date</option>
                <option value="size">Size</option>
              </CustomSelect>
            </Field>
            <Field label="Direction">
              <CustomSelect style={inputStyle} value={p('sortDir', 'asc')} onChange={u('sortDir')}>
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </CustomSelect>
            </Field>
          </Row>
          <Field label="File limit" hint="0 = no limit">
            <input type="number" style={inputStyle} value={p('limit', '0')} onChange={u('limit')} min="0" />
          </Field>
        </>
      )}

      <SectionTitle label="Output schema (row by row)" />
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}30` }}>
        <div style={{ fontSize: 9, color: '#8593b5', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
          Each file produces one row with these fields
        </div>
        {schema.map((f, i) => (
          <div key={f.name} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', borderBottom: i < schema.length - 1 ? '0.5px solid #1a2030' : 'none' }}>
            <code style={{ fontSize: 10, color: ACCENT, minWidth: 100, flexShrink: 0 }}>{f.name}</code>
            <span style={{ fontSize: 9, color: '#8593b5', minWidth: 50, flexShrink: 0 }}>{f.type}</span>
            <span style={{ fontSize: 9, color: '#2a3349' }}>{f.desc}</span>
          </div>
        ))}
      </div>

      <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#8593b5', display: 'flex', gap: 6 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, color: ACCENT, flexShrink: 0, marginTop: 1 }} />
        The node emits one row per file found/detected. Connect the output to a <code style={{ color: ACCENT }}>File Input</code> node that uses the <code style={{ color: ACCENT }}>path</code> field to read each file.
      </div>
    </div>
  )
}