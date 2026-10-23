/**
 * src/nodes/types/join/Panel.tsx
 *
 * P365: ogni opzione è applicata dal motore (join.rs). Join custom con
 * condizione FPEL, lato destro da Materialize, null = null. Tolti: query
 * inline, algoritmo/broadcast e "access mode" (mai letti dal motore).
 */
import { useMemo, useEffect } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useMaterializeSchema } from '../../../nodes/useMaterializeSchema'
import { CustomSelect } from '../../../components/CustomSelect'
import { useIncomingSchemaFromHandle } from '../../useIncomingSchema'
import { joinOutputFields } from './schema'


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
function SectionTitle({ label, color = '#4a9eff' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

// ─── Diagramma di Venn ────────────────────────────────────────────
const JOIN_CONFIGS: Record<string, { leftFill: string; rightFill: string; overlapColor: string; desc: string; leftLabel: string; rightLabel: string }> = {
  inner: { leftFill: '#0d2a4a', rightFill: '#0d2a4a', overlapColor: '#4a9eff', desc: 'Only rows with a match in both datasets',                  leftLabel: 'L', rightLabel: 'R' },
  left:  { leftFill: '#1a3a6a', rightFill: '#0f1117', overlapColor: '#4a9eff', desc: 'All left rows, null for those without a match on the right', leftLabel: 'L', rightLabel: 'R' },
  right: { leftFill: '#0f1117', rightFill: '#1a3a6a', overlapColor: '#4a9eff', desc: 'All right rows, null for those without a match on the left', leftLabel: 'L', rightLabel: 'R' },
  full:  { leftFill: '#1a3a6a', rightFill: '#1a3a6a', overlapColor: '#4a9eff', desc: 'All rows from both — null where the match is missing',          leftLabel: 'L', rightLabel: 'R' },
  cross: { leftFill: '#3d2a0a', rightFill: '#3d2a0a', overlapColor: '#ffb347', desc: 'Cartesian product — every left row × every right row (careful!)', leftLabel: 'L', rightLabel: 'R' },
  anti:  { leftFill: '#3d1010', rightFill: '#0f1117', overlapColor: '#ff5f57', desc: 'Only left rows WITHOUT a match on the right — useful to find "not present"', leftLabel: 'L', rightLabel: 'R' },
  semi:  { leftFill: '#0d3d20', rightFill: '#0f1117', overlapColor: '#3ddc84', desc: 'Left rows that HAVE a match, without including the right fields', leftLabel: 'L', rightLabel: 'R' },
}

function JoinVisual({ type }: { type: string }) {
  const cfg = JOIN_CONFIGS[type] ?? JOIN_CONFIGS.inner
  return (
    <div style={{ padding: '10px 12px', background: '#161b27', borderRadius: 6, border: '0.5px solid #2a3349', display: 'flex', gap: 16, alignItems: 'center' }}>
      {/* Diagramma */}
      <div style={{ position: 'relative', width: 90, height: 44, flexShrink: 0 }}>
        {/* Cerchio sinistro */}
        <div style={{ position: 'absolute', left: 0, top: 2, width: 48, height: 40, borderRadius: '50%', background: cfg.leftFill, border: `1.5px solid ${cfg.overlapColor}`, opacity: 0.9 }} />
        {/* Cerchio destro */}
        <div style={{ position: 'absolute', right: 0, top: 2, width: 48, height: 40, borderRadius: '50%', background: cfg.rightFill, border: `1.5px solid ${cfg.overlapColor}`, opacity: 0.9 }} />
        {/* Label L */}
        <span style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 9, color: cfg.overlapColor, fontWeight: 700 }}>L</span>
        {/* Label R */}
        <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 9, color: cfg.overlapColor, fontWeight: 700 }}>R</span>
        {/* Tipo */}
        <span style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', fontSize: 9, color: cfg.overlapColor, fontWeight: 700, whiteSpace: 'nowrap' }}>
          {type.toUpperCase()}
        </span>
      </div>
      {/* Descrizione */}
      <div style={{ fontSize: 10, color: '#9a9aaa', lineHeight: 1.4, flex: 1 }}>{cfg.desc}</div>
    </div>
  )
}

// ─── Editor chiavi composite ──────────────────────────────────────
interface CompositeKey { id: string; left: string; right: string }

function CompositeKeyEditor({ keys, leftFields, rightFields, onChange }: {
  keys:        CompositeKey[]
  leftFields:  Array<{ name: string; type: string }>
  rightFields: Array<{ name: string; type: string }>
  onChange:    (keys: CompositeKey[]) => void
}) {
  const add = () => onChange([...keys, { id: `ck_${Date.now()}`, left: '', right: '' }])
  const update = (id: string, side: 'left' | 'right', value: string) =>
    onChange(keys.map((k) => k.id === id ? { ...k, [side]: value } : k))
  const remove = (id: string) => onChange(keys.filter((k) => k.id !== id))

  if (keys.length === 0) {
    return (
      <button onClick={add}
        style={{ padding: '5px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#8593b5', border: '0.5px dashed #2a3349', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#4a9eff'; (e.currentTarget as HTMLElement).style.color = '#4a9eff' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349'; (e.currentTarget as HTMLElement).style.color = '#8593b5' }}>
        <i className="ti ti-plus" style={{ fontSize: 10 }} /> Add a composite key
      </button>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {keys.map((k) => (
        <div key={k.id} style={{ display: 'grid', gridTemplateColumns: '1fr 24px 1fr 24px', gap: 4, alignItems: 'center' }}>
          {leftFields.length > 0 ? (
            <CustomSelect style={{ ...inputStyle, fontSize: 10, padding: '3px 5px' }} value={k.left}
              onChange={(e) => update(k.id, 'left', e.target.value)}>
              <option value="">— left —</option>
              {leftFields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </CustomSelect>
          ) : (
            <input style={{ ...inputStyle, fontSize: 10, padding: '3px 5px' }} value={k.left}
              onChange={(e) => update(k.id, 'left', e.target.value)} placeholder="left_field" />
          )}
          <span style={{ textAlign: 'center', color: '#8593b5', fontSize: 10 }}>=</span>
          {rightFields.length > 0 ? (
            <CustomSelect style={{ ...inputStyle, fontSize: 10, padding: '3px 5px' }} value={k.right}
              onChange={(e) => update(k.id, 'right', e.target.value)}>
              <option value="">— right —</option>
              {rightFields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </CustomSelect>
          ) : (
            <input style={{ ...inputStyle, fontSize: 10, padding: '3px 5px' }} value={k.right}
              onChange={(e) => update(k.id, 'right', e.target.value)} placeholder="right_field" />
          )}
          <button onClick={() => remove(k.id)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8593b5', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#8593b5' }}>
            <i className="ti ti-x" style={{ fontSize: 10 }} />
          </button>
        </div>
      ))}
      <button onClick={add}
        style={{ padding: '4px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#8593b5', border: '0.5px dashed #2a3349', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#4a9eff'; (e.currentTarget as HTMLElement).style.color = '#4a9eff' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349'; (e.currentTarget as HTMLElement).style.color = '#8593b5' }}>
        <i className="ti ti-plus" style={{ fontSize: 10 }} /> Add key
      </button>
    </div>
  )
}

// ─── JoinPanel ────────────────────────────────────────────────────
export function JoinPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const pool       = useFlowStore((s) => s.pool)

  const props       = node?.data.props ?? {}
  const joinType    = props['join_type'] ?? 'inner'
  const rightSource = props['rightSource'] ?? 'stream'
  const matName     = props['materializeName'] ?? ''
  const rightPrefix = props['rightPrefix'] ?? 'r_'
  const laneId      = node?.data.laneId

  // Variabili Materialize disponibili
  const materializeVars = useMemo(() => {
    const lane = pool.lanes.find((l) => l.id === laneId)
    return (lane?.variables ?? []).filter((v) => v.type === 'materialize')
  }, [pool, laneId])

  // Schema sinistro e destro (dal flusso collegato o dal Materialize)
  const leftFields        = useIncomingSchemaFromHandle(nodeId, 'input_left')
  const streamRightFields = useIncomingSchemaFromHandle(nodeId, 'input_right')
  const materializeFields = useMaterializeSchema(nodeId, matName)
  const rightFields = rightSource === 'materialize' ? materializeFields : streamRightFields

  // Chiavi composite
  const compositeRaw = props['compositeKeys'] ?? '[]'
  const compositeKeys: CompositeKey[] = useMemo(() => {
    try { return JSON.parse(compositeRaw) }
    catch { return [] }
  }, [compositeRaw])

  // Schema d'uscita: la regola del motore (./schema.ts)
  const outFields  = joinOutputFields(leftFields, rightFields, joinType, rightPrefix)
  const outJson    = JSON.stringify(outFields.map((f) => ({ id: `join_${f.side[0]}_${f.physicalName}`, ...f })))
  useEffect(() => {
    if (!node || (leftFields.length === 0 && rightFields.length === 0)) return
    if (props['outputSchema'] !== outJson) updateProp(nodeId, 'outputSchema', outJson)
  }, [outJson])

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const saveCompositeKeys = (keys: CompositeKey[]) =>
    updateProp(nodeId, 'compositeKeys', JSON.stringify(keys))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 10, color: '#8593b5', lineHeight: 1.5 }}>
        <span style={{ color: '#4a9eff', fontWeight: 600 }}>⋈</span> Combines the rows of two datasets on a common key.
        The main flow (left) is processed row by row; the right side is kept in memory as a lookup —
        from the connected flow or from a Materialize.
      </div>

      {/* Tipo join */}
      <SectionTitle label="Join type" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 5 }}>
        {[
          { value: 'inner', label: 'INNER',  icon: 'ti-circles-relation', color: '#4a9eff' },
          { value: 'left',  label: 'LEFT',   icon: 'ti-circle',           color: '#4a9eff' },
          { value: 'right', label: 'RIGHT',  icon: 'ti-circle',           color: '#4a9eff' },
          { value: 'full',  label: 'FULL',   icon: 'ti-circles',          color: '#4a9eff' },
          { value: 'cross', label: 'CROSS',  icon: 'ti-grid-dots',        color: '#ffb347' },
          { value: 'anti',  label: 'ANTI',   icon: 'ti-circle-minus',     color: '#ff5f57' },
          { value: 'semi',  label: 'SEMI',   icon: 'ti-circle-check',     color: '#3ddc84' },
          { value: 'custom',label: 'CUSTOM', icon: 'ti-code',             color: '#a78bfa' },
        ].map((t) => (
          <button key={t.value}
            onClick={() => updateProp(nodeId, 'join_type', t.value)}
            style={{
              padding: '6px 4px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
              background: joinType === t.value ? `color-mix(in srgb, ${t.color} 15%, #1a2030)` : '#1a2030',
              color:      joinType === t.value ? t.color : '#8593b5',
              border: joinType === t.value ? `1px solid ${t.color}60` : '1px solid #2a3349',
              fontWeight: joinType === t.value ? 600 : 400,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            }}>
            <i className={`ti ${t.icon}`} style={{ fontSize: 12, color: joinType === t.value ? t.color : '#8593b5' }} />
            {t.label}
          </button>
        ))}
      </div>

      <JoinVisual type={joinType === 'custom' ? 'inner' : joinType} />

      {/* Condizione custom */}
      {joinType === 'custom' && (
        <Field label="Join condition (FPEL)" hint="Any condition — e.g. a range join or a band lookup. It works like an INNER join: left rows without a match go to the reject output.">
          <textarea
            style={{ ...inputStyle, resize: 'vertical', minHeight: 60, fontFamily: 'monospace', color: '#a78bfa' }}
            value={p('customCondition')}
            onChange={u('customCondition')}
            placeholder="left.price >= right.min_price && left.price <= right.max_price"
            spellCheck={false} />
          <div style={{ fontSize: 9, color: '#8593b5', fontStyle: 'italic' }}>
            Every field needs its side: <code style={{ color: '#a78bfa' }}>left.field</code> or <code style={{ color: '#a78bfa' }}>right.field</code>.
            Each left row is compared with every right row (n × m): slow on large datasets.
          </div>
        </Field>
      )}

      {/* Sorgente destra */}
      <SectionTitle label="Right source (lookup)" color="#22d3ee" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          {
            value: 'materialize',
            label: '◈ From Materialize',
            desc:  'Reads the dataset published by a Materialize of this lane. A right edge, if connected, only acts as a trigger.',
            disabled: materializeVars.length === 0,
            hint:  materializeVars.length === 0 ? 'No Materialize published in this lane' : undefined,
          },
          {
            value: 'stream',
            label: '→ From connected flow',
            desc:  'The right flow arrives via edge. It is buffered in memory before the join.',
            disabled: false,
          },
          ...(rightSource === 'inline' ? [{
            value: 'inline',
            label: '⬡ Inline query (not supported)',
            desc:  'Not supported by the engine: the run stops with an error. Put a DB Source on the right input instead.',
            disabled: false,
          }] : []),
        ].map((s) => (
          <button key={s.value}
            onClick={() => { if (!s.disabled) updateProp(nodeId, 'rightSource', s.value) }}
            style={{
              padding: '8px 10px', borderRadius: 6, cursor: s.disabled ? 'not-allowed' : 'pointer',
              opacity: s.disabled ? 0.4 : 1, textAlign: 'left',
              background: rightSource === s.value ? 'color-mix(in srgb, #22d3ee 10%, #1a2030)' : '#1a2030',
              border: rightSource === s.value ? '1px solid #22d3ee60' : '1px solid #2a3349',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: rightSource === s.value ? '#22d3ee' : 'transparent', border: `1.5px solid ${rightSource === s.value ? '#22d3ee' : '#2a3349'}` }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: rightSource === s.value ? '#22d3ee' : '#c8d4f0' }}>{s.label}</div>
              <div style={{ fontSize: 9, color: '#8593b5' }}>{s.hint ?? s.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Selettore Materialize */}
      {rightSource === 'materialize' && (
        <>
          <Field label="Source Materialize">
            <CustomSelect style={inputStyle} value={matName} onChange={u('materializeName')}>
              <option value="">— select —</option>
              {materializeVars.map((v) => (
                <option key={v.id} value={v.name}>{v.name}</option>
              ))}
            </CustomSelect>
          </Field>
          {matName && materializeFields.length > 0 && (
            <div style={{ padding: '5px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #22d3ee20', fontSize: 9, color: '#8593b5', display: 'flex', gap: 5, alignItems: 'center' }}>
              <i className="ti ti-check" style={{ fontSize: 9, color: '#22d3ee' }} />
              dataset <code style={{ color: '#22d3ee' }}>{matName}</code>
              — {materializeFields.length} fields available
            </div>
          )}
          {matName && materializeFields.length === 0 && (
            <div style={{ padding: '6px 10px', fontSize: 9, color: '#ffb347', background: '#1a1000', borderRadius: 4, border: '0.5px solid #3a2a0a', display: 'flex', gap: 5 }}>
              <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} />
              The Materialize "{matName}" has not received fields yet.
            </div>
          )}
        </>
        
      )}

      {/* Chiavi di join */}
      {joinType !== 'cross' && joinType !== 'custom' && (
        <>
          <SectionTitle label="Join keys" />
          <Row>
            <Field label="Left field" hint="Field of the main flow">
              {leftFields.length > 0 ? (
                <CustomSelect style={inputStyle} value={p('leftKey')} onChange={u('leftKey')}>
                  <option value="">— select —</option>
                  {leftFields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
                </CustomSelect>
              ) : (
                <input style={inputStyle} value={p('leftKey')} onChange={u('leftKey')} placeholder="user_id" />
              )}
            </Field>
            <Field label="Right field" hint="Field of the lookup dataset">
              {rightFields.length > 0 ? (
                <CustomSelect style={inputStyle} value={p('rightKey')} onChange={u('rightKey')}>
                  <option value="">— select —</option>
                  {rightFields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
                </CustomSelect>
              ) : (
                <input style={inputStyle} value={p('rightKey')} onChange={u('rightKey')} placeholder="user_id" />
              )}
            </Field>
          </Row>

          {/* Chiavi composite */}
          <Field label="Additional composite keys" hint="For joins on multiple fields">
            <CompositeKeyEditor
              keys={compositeKeys}
              leftFields={leftFields}
              rightFields={rightFields}
              onChange={saveCompositeKeys} />
          </Field>
        </>
      )}

      {/* Opzioni */}
      <SectionTitle label="Options" />
      <Row>
        <Field label="Case sensitive">
          <CustomSelect style={inputStyle} value={p('caseSensitive', 'true')} onChange={u('caseSensitive')}>
            <option value="true">Yes — case sensitive</option>
            <option value="false">No — case insensitive</option>
          </CustomSelect>
        </Field>
        <Field label="Right fields prefix" hint="Applied to fields that collide with the left">
          <input style={inputStyle} value={p('rightPrefix', 'r_')} onChange={u('rightPrefix')} placeholder="r_" />
        </Field>
      </Row>
      <Row>
        <Field label="Multiple matches">
          <CustomSelect style={inputStyle} value={p('duplicates', 'all')} onChange={u('duplicates')}>
            <option value="all">All — one row per match</option>
            <option value="first">Only the first match</option>
            <option value="last">Only the last match</option>
            <option value="error">Error if more than one</option>
          </CustomSelect>
        </Field>
        <Field label="Null keys">
          <CustomSelect style={inputStyle} value={p('nullKeys', 'exclude')} onChange={u('nullKeys')}>
            <option value="exclude">Exclude (null does not match)</option>
            <option value="include">Include (null = null)</option>
            <option value="error">Error on a null left key</option>
          </CustomSelect>
        </Field>
      </Row>

      <div style={{ padding: '6px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #a78bfa30', fontSize: 10, color: '#8593b5', display: 'flex', gap: 6 }}>
        <i className="ti ti-cpu" style={{ fontSize: 11, color: '#a78bfa', flexShrink: 0, marginTop: 1 }} />
        {joinType === 'custom'
          ? 'Custom join: every left row is compared with every right row. The right side is kept in memory.'
          : 'Hash join: the right side is kept in memory as a table keyed by the join key; the left flow streams through it.'}
      </div>

      {/* Schema output */}
      {(leftFields.length > 0 || rightFields.length > 0) && (
        <>
          <SectionTitle label="Schema output" color="#22d3ee" />
          <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 80px', gap: 8, padding: '4px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
              {['Field', 'Type', 'Side'].map((h) => (
                <div key={h} style={{ fontSize: 9, color: '#22d3ee', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
              ))}
            </div>
            {outFields.map((f, i, arr) => (
              <div key={`${f.side}_${f.name}`}
                style={{ display: 'grid', gridTemplateColumns: '1fr 70px 80px', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
                <code style={{ fontFamily: 'monospace', fontSize: 11, color: f.side === 'left' ? '#4a9eff' : '#22d3ee' }}>{f.name}</code>
                <span style={{ fontSize: 9, color: '#8593b5' }}>{f.type}</span>
                <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: f.side === 'left' ? '#0d2a4a' : '#0d3d3d', color: f.side === 'left' ? '#4a9eff' : '#22d3ee', border: `0.5px solid ${f.side === 'left' ? '#4a9eff' : '#22d3ee'}30`, textAlign: 'center' }}>
                  {f.side === 'left' ? '← left' : '→ right'}
                </span>
              </div>
            ))}
          </div>
          {joinType === 'anti' && (
            <div style={{ fontSize: 9, color: '#ff5f57', fontStyle: 'italic', display: 'flex', gap: 5 }}>
              <i className="ti ti-info-circle" style={{ fontSize: 9 }} />
              ANTI JOIN — only left-side fields in output.
            </div>
          )}
          {joinType === 'semi' && (
            <div style={{ fontSize: 9, color: '#3ddc84', fontStyle: 'italic', display: 'flex', gap: 5 }}>
              <i className="ti ti-info-circle" style={{ fontSize: 9 }} />
              SEMI JOIN — only left-side fields in output. The right side is used only for filtering.
            </div>
          )}
        </>
      )}

    </div>
  )
}
