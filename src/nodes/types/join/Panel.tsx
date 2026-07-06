/**
 * src/nodes/types/join/Panel.tsx
 */
import { useMemo, useEffect } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useMaterializeSchema } from '../../../nodes/useMaterializeSchema'
import { CustomSelect } from '../../../components/CustomSelect'
import { useIncomingSchemaFromHandle } from '../../useIncomingSchema'

const ACCESS_OPTIONS = [
  { value: 'dataset',  label: 'Dataset — .toDataset() (consigliato — List completa, zero buffering aggiuntivo)' },
  { value: 'iterator', label: 'Iterator — .values() (riga per riga con buffering interno)' },
]


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
  inner: { leftFill: '#0d2a4a', rightFill: '#0d2a4a', overlapColor: '#4a9eff', desc: 'Solo righe con corrispondenza in entrambi i dataset',                  leftLabel: 'L', rightLabel: 'R' },
  left:  { leftFill: '#1a3a6a', rightFill: '#0f1117', overlapColor: '#4a9eff', desc: 'Tutte le righe di sinistra, null per quelle senza corrispondenza a destra', leftLabel: 'L', rightLabel: 'R' },
  right: { leftFill: '#0f1117', rightFill: '#1a3a6a', overlapColor: '#4a9eff', desc: 'Tutte le righe di destra, null per quelle senza corrispondenza a sinistra', leftLabel: 'L', rightLabel: 'R' },
  full:  { leftFill: '#1a3a6a', rightFill: '#1a3a6a', overlapColor: '#4a9eff', desc: 'Tutte le righe di entrambi — null dove manca la corrispondenza',          leftLabel: 'L', rightLabel: 'R' },
  cross: { leftFill: '#3d2a0a', rightFill: '#3d2a0a', overlapColor: '#ffb347', desc: 'Prodotto cartesiano — ogni riga sinistra × ogni riga destra (attenzione!)', leftLabel: 'L', rightLabel: 'R' },
  anti:  { leftFill: '#3d1010', rightFill: '#0f1117', overlapColor: '#ff5f57', desc: 'Solo righe di sinistra SENZA corrispondenza a destra — utile per trovare "non presenti"', leftLabel: 'L', rightLabel: 'R' },
  semi:  { leftFill: '#0d3d20', rightFill: '#0f1117', overlapColor: '#3ddc84', desc: 'Righe di sinistra che HANNO corrispondenza, senza includere i campi di destra', leftLabel: 'L', rightLabel: 'R' },
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
        style={{ padding: '5px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#4a5a7a', border: '0.5px dashed #2a3349', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#4a9eff'; (e.currentTarget as HTMLElement).style.color = '#4a9eff' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349'; (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
        <i className="ti ti-plus" style={{ fontSize: 10 }} /> Aggiungi chiave composta
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
              <option value="">— sinistra —</option>
              {leftFields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </CustomSelect>
          ) : (
            <input style={{ ...inputStyle, fontSize: 10, padding: '3px 5px' }} value={k.left}
              onChange={(e) => update(k.id, 'left', e.target.value)} placeholder="campo_sx" />
          )}
          <span style={{ textAlign: 'center', color: '#4a5a7a', fontSize: 10 }}>=</span>
          {rightFields.length > 0 ? (
            <CustomSelect style={{ ...inputStyle, fontSize: 10, padding: '3px 5px' }} value={k.right}
              onChange={(e) => update(k.id, 'right', e.target.value)}>
              <option value="">— destra —</option>
              {rightFields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </CustomSelect>
          ) : (
            <input style={{ ...inputStyle, fontSize: 10, padding: '3px 5px' }} value={k.right}
              onChange={(e) => update(k.id, 'right', e.target.value)} placeholder="campo_dx" />
          )}
          <button onClick={() => remove(k.id)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
            <i className="ti ti-x" style={{ fontSize: 10 }} />
          </button>
        </div>
      ))}
      <button onClick={add}
        style={{ padding: '4px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#4a5a7a', border: '0.5px dashed #2a3349', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#4a9eff'; (e.currentTarget as HTMLElement).style.color = '#4a9eff' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349'; (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
        <i className="ti ti-plus" style={{ fontSize: 10 }} /> Aggiungi chiave
      </button>
    </div>
  )
}

// ─── JoinPanel ────────────────────────────────────────────────────
export function JoinPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const pool       = useFlowStore((s) => s.pool)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const joinType    = p('join_type', 'inner')
  const rightSource = p('rightSource', 'stream')
  const matName     = p('materializeName', '')
  const accessMode = p('accessMode', 'dataset')   // ← definito qui
  const laneId      = node.data.laneId

  // Variabili Materialize disponibili
  const materializeVars = useMemo(() => {
    const lane = pool.lanes.find((l) => l.id === laneId)
    return (lane?.variables ?? []).filter((v) => v.type === 'materialize')
  }, [pool, laneId])


    // Schema sinistro — da incomingSchema o dal nodo sorgente
  const leftFields = useIncomingSchemaFromHandle(nodeId, 'input_left')
  
  

  // Schema destro — dal Materialize, dal flusso connesso (rightSchema), o vuoto
  const materializeFields = useMaterializeSchema(nodeId, matName)
  const streamRightFields = useMemo(() => {
    try {
      const raw = node.data.props['rightSchema']
      if (!raw) return []
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.map((f: any) => ({ name: f.name ?? f.sourceField, type: f.type ?? 'string' }))
    } catch { return [] }
  }, [node.data.props['rightSchema']])

  const rightFields = rightSource === 'materialize' ? materializeFields
                    : rightSource === 'stream'      ? streamRightFields
                    : []

  // Chiavi composite
  const compositeKeys: CompositeKey[] = useMemo(() => {
    try { return JSON.parse(p('compositeKeys', '[]')) }
    catch { return [] }
  }, [p('compositeKeys')])

  const saveCompositeKeys = (keys: CompositeKey[]) =>
    updateProp(nodeId, 'compositeKeys', JSON.stringify(keys))

  // Schema output — unione dei campi sinistro + destro con prefisso
  const rightPrefix = p('rightPrefix', 'r_')

  useEffect(() => {
    if (leftFields.length === 0 && rightFields.length === 0) return

    const leftSchema = leftFields.map((f) => ({
      id: `join_l_${f.name}`, name: f.name, type: f.type, physicalName: f.name, side: 'left',
    }))

    const rightSchema = rightFields
      .filter((f) => {
        // In SEMI e ANTI join non includere campi del lato destro
        if (joinType === 'anti' || joinType === 'semi') return false
        return true
      })
      .map((f) => {
        // Applica prefisso se il nome collide con un campo sinistro
        const leftNames = new Set(leftFields.map((lf) => lf.name))
        const name = leftNames.has(f.name) ? `${rightPrefix}${f.name}` : f.name
        return { id: `join_r_${f.name}`, name, type: f.type, physicalName: f.name, side: 'right' }
      })

    updateProp(nodeId, 'outputSchema', JSON.stringify([...leftSchema, ...rightSchema]))
  }, [
    leftFields.map((f) => f.name).join(','),
    rightFields.map((f) => f.name).join(','),
    joinType, rightPrefix,
  ])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a', lineHeight: 1.5 }}>
        <span style={{ color: '#4a9eff', fontWeight: 600 }}>⋈</span> Combina righe di due dataset in base a una chiave comune.
        Il flusso principale (sinistra) viene elaborato riga per riga.
        Il dataset destro deve essere accessibile come lookup — tramite Materialize o flusso connesso.
      </div>

      {/* Tipo join */}
      <SectionTitle label="Tipo di join" />
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
              color:      joinType === t.value ? t.color : '#4a5a7a',
              border: joinType === t.value ? `1px solid ${t.color}60` : '1px solid #2a3349',
              fontWeight: joinType === t.value ? 600 : 400,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            }}>
            <i className={`ti ${t.icon}`} style={{ fontSize: 12, color: joinType === t.value ? t.color : '#4a5a7a' }} />
            {t.label}
          </button>
        ))}
      </div>

      <JoinVisual type={joinType === 'custom' ? 'inner' : joinType} />

      {/* Condizione custom */}
      {joinType === 'custom' && (
        <Field label="Condizione join" hint="Condizione non-equi — es: range join, lookup per fascia">
          <textarea
            style={{ ...inputStyle, resize: 'vertical', minHeight: 60, fontFamily: 'monospace', color: '#a78bfa' }}
            value={p('customCondition')}
            onChange={u('customCondition')}
            placeholder="left.price >= right.min_price AND left.price <= right.max_price"
            spellCheck={false} />
          <div style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic' }}>
            Usa <code style={{ color: '#a78bfa' }}>left.campo</code> e <code style={{ color: '#a78bfa' }}>right.campo</code> per riferirsi ai due dataset.
            Attenzione: richiede nested loop — potenzialmente lento su dataset grandi.
          </div>
        </Field>
      )}

      {/* Sorgente destra */}
      <SectionTitle label="Sorgente destra (lookup)" color="#22d3ee" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          {
            value: 'materialize',
            label: '◈ Da Materialize',
            desc:  'Lookup O(1) sulla hashtable — il pattern più efficiente. Il Materialize deve essere già popolato.',
            disabled: materializeVars.length === 0,
            hint:  materializeVars.length === 0 ? 'Nessun Materialize pubblicato in questa lane' : undefined,
          },
          {
            value: 'stream',
            label: '→ Da flusso connesso',
            desc:  'Il flusso destro arriva via edge. Viene bufferizzato internamente prima del join.',
            disabled: false,
          },
          {
            value: 'inline',
            label: '⬡ Query inline',
            desc:  'Esegue una query sulla stessa risorsa DB configurata nel nodo sorgente.',
            disabled: false,
          },
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
              <div style={{ fontSize: 9, color: '#4a5a7a' }}>{s.hint ?? s.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Selettore Materialize */}
      {rightSource === 'materialize' && (
        <>
          <Field label="Materialize sorgente">
            <CustomSelect style={inputStyle} value={matName} onChange={u('materializeName')}>
              <option value="">— seleziona —</option>
              {materializeVars.map((v) => (
                <option key={v.id} value={v.name}>{v.name}</option>
              ))}
            </CustomSelect>
          </Field>
          {matName && materializeFields.length > 0 && (
            <div style={{ padding: '5px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #22d3ee20', fontSize: 9, color: '#4a5a7a', display: 'flex', gap: 5, alignItems: 'center' }}>
              <i className="ti ti-check" style={{ fontSize: 9, color: '#22d3ee' }} />
              <code style={{ color: '#22d3ee' }}>context.lane.{matName}.get(row.chiave)</code>
              — {materializeFields.length} campi disponibili · accesso O(1)
            </div>
          )}
          {matName && materializeFields.length === 0 && (
            <div style={{ padding: '6px 10px', fontSize: 9, color: '#ffb347', background: '#1a1000', borderRadius: 4, border: '0.5px solid #3a2a0a', display: 'flex', gap: 5 }}>
              <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} />
              Il Materialize "{matName}" non ha ancora ricevuto campi.
            </div>
          )}
          {/* accessMode — come Aggregate accede al Materialize */}
          {matName && (
            <Field label="Modalità accesso al Materialize" hint="Determina come il codegen legge i dati dal Materialize">
              <CustomSelect style={inputStyle} value={accessMode} onChange={u('accessMode')}>
                {ACCESS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </CustomSelect>
              <div style={{ fontSize: 9, color: '#4a5a7a', marginTop: 4, fontStyle: 'italic' }}>
                {accessMode === 'dataset'  && '→ context.lane.' + matName + '.toDataset() — List<Row> completa, zero buffering aggiuntivo nel nodo'}
                {accessMode === 'iterator' && '→ context.lane.' + matName + '.values() — riga per riga, Aggregate bufferizza internamente per gruppo'}
              </div>
            </Field>
          )}

        </>
        
      )}

      {/* Query inline */}
      {rightSource === 'inline' && (
        <Field label="Query sorgente destra" hint="Eseguita sulla stessa risorsa DB del nodo sorgente">
          <textarea
            style={{ ...inputStyle, resize: 'vertical', minHeight: 80, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 }}
            value={p('rightQuery')} onChange={u('rightQuery')}
            placeholder="SELECT id, nome, prezzo FROM prodotti WHERE attivo = true"
            spellCheck={false} />
        </Field>
      )}

      {/* Chiavi di join */}
      {joinType !== 'cross' && joinType !== 'custom' && (
        <>
          <SectionTitle label="Chiavi di join" />
          <Row>
            <Field label="Campo sinistra" hint="Campo del flusso principale">
              {leftFields.length > 0 ? (
                <CustomSelect style={inputStyle} value={p('leftKey')} onChange={u('leftKey')}>
                  <option value="">— seleziona —</option>
                  {leftFields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
                </CustomSelect>
              ) : (
                <input style={inputStyle} value={p('leftKey')} onChange={u('leftKey')} placeholder="user_id" />
              )}
            </Field>
            <Field label="Campo destra" hint="Campo del dataset di lookup">
              {rightFields.length > 0 ? (
                <CustomSelect style={inputStyle} value={p('rightKey')} onChange={u('rightKey')}>
                  <option value="">— seleziona —</option>
                  {rightFields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
                </CustomSelect>
              ) : (
                <input style={inputStyle} value={p('rightKey')} onChange={u('rightKey')} placeholder="user_id" />
              )}
            </Field>
          </Row>

          {/* Chiavi composite */}
          <Field label="Chiavi composite aggiuntive" hint="Per join su più campi">
            <CompositeKeyEditor
              keys={compositeKeys}
              leftFields={leftFields}
              rightFields={rightFields}
              onChange={saveCompositeKeys} />
          </Field>
        </>
      )}

      {/* Opzioni */}
      <SectionTitle label="Opzioni" />
      <Row>
        <Field label="Case sensitive">
          <CustomSelect style={inputStyle} value={p('caseSensitive', 'true')} onChange={u('caseSensitive')}>
            <option value="true">Sì — distingue maiuscole</option>
            <option value="false">No — case insensitive</option>
          </CustomSelect>
        </Field>
        <Field label="Prefisso campi destra" hint="Applicato ai campi che collidono con sinistra">
          <input style={inputStyle} value={p('rightPrefix', 'r_')} onChange={u('rightPrefix')} placeholder="r_" />
        </Field>
      </Row>
      <Row>
        <Field label="Corrispondenze multiple">
          <CustomSelect style={inputStyle} value={p('duplicates', 'all')} onChange={u('duplicates')}>
            <option value="all">Tutte — una riga per ogni match</option>
            <option value="first">Solo la prima corrispondenza</option>
            <option value="last">Solo l'ultima corrispondenza</option>
            <option value="error">Errore se più di una</option>
          </CustomSelect>
        </Field>
        <Field label="Chiavi null">
          <CustomSelect style={inputStyle} value={p('nullKeys', 'exclude')} onChange={u('nullKeys')}>
            <option value="exclude">Escludi (null non fa match)</option>
            <option value="include">Includi (null = null)</option>
            <option value="error">Errore su null</option>
          </CustomSelect>
        </Field>
      </Row>

      {/* Performance */}
      <SectionTitle label="Performance" color="#a78bfa" />
      <Row>
        <Field label="Algoritmo">
          <CustomSelect style={inputStyle} value={p('algorithm', 'hash')} onChange={u('algorithm')}>
            <option value="hash">Hash join — O(n+m), dataset destro in memoria</option>
            <option value="sort_merge">Sort-merge — entrambi ordinati per chiave</option>
            <option value="nested_loop">Nested loop — lento, per condizioni custom</option>
          </CustomSelect>
        </Field>
        <Field label="Broadcast threshold (MB)" hint="Se il dataset destro è più piccolo → broadcast automatico">
          <input type="number" style={inputStyle} value={p('broadcastThreshold', '100')} onChange={u('broadcastThreshold')} min="0" />
        </Field>
      </Row>

      {rightSource === 'materialize' && (
        <div style={{ padding: '6px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #22d3ee20', fontSize: 10, color: '#4a5a7a', display: 'flex', gap: 6 }}>
          <i className="ti ti-zap" style={{ fontSize: 11, color: '#22d3ee', flexShrink: 0, marginTop: 1 }} />
          Il Materialize è già una hashtable — l'algoritmo è automaticamente Hash Join con accesso O(1).
          Nessun buffering aggiuntivo necessario.
        </div>
      )}

      {/* Schema output */}
      {(leftFields.length > 0 || rightFields.length > 0) && joinType !== 'cross' && joinType !== 'custom' && (
        <>
          <SectionTitle label="Schema output" color="#22d3ee" />
          <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 80px', gap: 8, padding: '4px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
              {['Campo', 'Tipo', 'Lato'].map((h) => (
                <div key={h} style={{ fontSize: 9, color: '#22d3ee', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
              ))}
            </div>
            {[
              ...leftFields.map((f) => ({ name: f.name, type: f.type, side: 'left' as const })),
              ...(joinType === 'anti' || joinType === 'semi' ? [] : rightFields.map((f) => {
                const leftNames = new Set(leftFields.map((lf) => lf.name))
                const name = leftNames.has(f.name) ? `${p('rightPrefix', 'r_')}${f.name}` : f.name
                return { name, type: f.type, side: 'right' as const }
              })),
            ].map((f, i, arr) => (
              <div key={`${f.side}_${f.name}`}
                style={{ display: 'grid', gridTemplateColumns: '1fr 70px 80px', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
                <code style={{ fontFamily: 'monospace', fontSize: 11, color: f.side === 'left' ? '#4a9eff' : '#22d3ee' }}>{f.name}</code>
                <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.type}</span>
                <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: f.side === 'left' ? '#0d2a4a' : '#0d3d3d', color: f.side === 'left' ? '#4a9eff' : '#22d3ee', border: `0.5px solid ${f.side === 'left' ? '#4a9eff' : '#22d3ee'}30`, textAlign: 'center' }}>
                  {f.side === 'left' ? '← sinistra' : '→ destra'}
                </span>
              </div>
            ))}
          </div>
          {joinType === 'anti' && (
            <div style={{ fontSize: 9, color: '#ff5f57', fontStyle: 'italic', display: 'flex', gap: 5 }}>
              <i className="ti ti-info-circle" style={{ fontSize: 9 }} />
              ANTI JOIN — solo campi del lato sinistro in output.
            </div>
          )}
          {joinType === 'semi' && (
            <div style={{ fontSize: 9, color: '#3ddc84', fontStyle: 'italic', display: 'flex', gap: 5 }}>
              <i className="ti ti-info-circle" style={{ fontSize: 9 }} />
              SEMI JOIN — solo campi del lato sinistro in output. Il lato destro è usato solo per il filtro.
            </div>
          )}
        </>
      )}

    </div>
  )
}
