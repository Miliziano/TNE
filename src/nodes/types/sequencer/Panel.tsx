/**
 * src/nodes/types/sequencer/Panel.tsx
 */

import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'

const SEQ_COLOR = '#a78bfa'

const COND_COLORS: Record<string, string> = {
  onOk:    '#3ddc84',
  onError: '#ff5f57',
  always:  '#ffb347',
}

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}

function SectionTitle({ label }: { label: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color: SEQ_COLOR, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${SEQ_COLOR}30`, marginBottom: 8 }}>
      {label}
    </div>
  )
}

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: '7px 10px', background: `color-mix(in srgb, ${SEQ_COLOR} 6%, #0f1117)`, borderRadius: 4, border: `0.5px solid ${SEQ_COLOR}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.6 }}>
      {children}
    </div>
  )
}

export function SequencerPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore(s => s.nodes.find(n => n.id === nodeId))
  const updateProp = useFlowStore(s => s.updateNodeProp)
  if (!node) return null

  const p = (key: string, def = '') => String(node.data.props?.[key] ?? def)
  const u = (key: string, val: string) => updateProp(nodeId, key, val)

  const seqCount        = Math.max(1, parseInt(p('seqCount', '2'), 10))
  const defaultCond     = p('defaultCondition', 'onOk')
  const onBlockedError  = p('onBlockedError', 'stop')

  // ── Aggiungi sequenza ──────────────────────────────────────────
  const addSeq = () => {
    const n = seqCount + 1
    u('seqCount', String(n))
    u(`seq_${n}_condition`, defaultCond)
    u(`seq_${n}_label`, '')
    u(`seq_${n}_timeout`, '0')
  }

  // ── Rimuovi sequenza N (non solo l'ultima) ─────────────────────
  // Shift verso l'alto: copia i props della sequenza N+1 in N, ecc.
  const removeSeq = (n: number) => {
    if (seqCount <= 1) return
    // Sposta in su le sequenze successive
    for (let i = n; i < seqCount; i++) {
      u(`seq_${i}_label`,     p(`seq_${i + 1}_label`, ''))
      u(`seq_${i}_condition`, p(`seq_${i + 1}_condition`, defaultCond))
      u(`seq_${i}_timeout`,   p(`seq_${i + 1}_timeout`, '0'))
    }
    // Pulisce l'ultima (ora duplicata)
    u(`seq_${seqCount}_label`,     '')
    u(`seq_${seqCount}_condition`, defaultCond)
    u(`seq_${seqCount}_timeout`,   '0')
    u('seqCount', String(seqCount - 1))
  }

  // ── Sposta sequenza su/giù ────────────────────────────────────
  const moveSeq = (n: number, dir: 'up' | 'down') => {
    const other = dir === 'up' ? n - 1 : n + 1
    if (other < 1 || other > seqCount) return
    // Swap props tra n e other
    const swap = (key: string) => {
      const a = p(`seq_${n}_${key}`, '')
      const b = p(`seq_${other}_${key}`, '')
      u(`seq_${n}_${key}`, b)
      u(`seq_${other}_${key}`, a)
    }
    swap('label')
    swap('condition')
    swap('timeout')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: `color-mix(in srgb, ${SEQ_COLOR} 8%, #161b27)`, borderRadius: 6, border: `1px solid ${SEQ_COLOR}30` }}>
        <i className="ti ti-list-numbers" style={{ fontSize: 16, color: SEQ_COLOR }} />
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: SEQ_COLOR }}>Sequencer</div>
          <div style={{ fontSize: 9, color: '#4a5a7a' }}>Avvia pipeline in sequenza — una dopo l'altra</div>
        </div>
      </div>

      <InfoBox>
        Collega ogni handle <code style={{ color: SEQ_COLOR }}>seq_N</code> al <strong>primo nodo</strong> della
        pipeline corrispondente. Usa <strong>+ Aggiungi sequenza</strong> per aggiungere output, le frecce
        per cambiare l'ordine di esecuzione, × per rimuovere.
      </InfoBox>

      {/* Comportamento globale */}
      <SectionTitle label="Comportamento globale" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
        <div style={labelStyle}>Condizione default per nuove sequenze</div>
        <CustomSelect style={inputStyle} value={defaultCond}
          onChange={e => u('defaultCondition', e.target.value)}>
          <option value="onOk">onOk — parte solo se la precedente ha avuto successo</option>
          <option value="onError">onError — parte solo se la precedente ha fallito</option>
          <option value="always">always — parte sempre, indipendentemente dal risultato</option>
        </CustomSelect>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
        <div style={labelStyle}>Se la condizione non è soddisfatta</div>
        <CustomSelect style={inputStyle} value={onBlockedError}
          onChange={e => u('onBlockedError', e.target.value)}>
          <option value="stop">Interrompi — il Sequencer va in errore</option>
          <option value="skip">Salta — continua con la sequenza successiva</option>
          <option value="proceed">Procedi comunque — ignora l'errore</option>
        </CustomSelect>
      </div>

      {/* Lista sequenze — identico a FilterModal.ConditionEditor */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SectionTitle label={`Sequenze — ${seqCount}`} />
      </div>

      {Array.from({ length: seqCount }, (_, i) => {
        const n    = i + 1
        const cond = p(`seq_${n}_condition`, defaultCond)
        const cc   = COND_COLORS[cond] ?? SEQ_COLOR

        return (
          <div key={n} style={{ border: `1px solid ${cc}40`, borderRadius: 8, overflow: 'hidden', marginBottom: 4 }}>

            {/* Header sequenza — identico a FilterModal.ConditionEditor header */}
            <div style={{ padding: '6px 10px', background: `color-mix(in srgb, ${cc} 10%, #1a2030)`, display: 'flex', alignItems: 'center', gap: 8 }}>

              {/* Frecce riordino — identico a onMoveUp/onMoveDown del Filter */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
                <button onClick={() => moveSeq(n, 'up')} disabled={n === 1}
                  style={{ background: 'none', border: 'none', cursor: n === 1 ? 'not-allowed' : 'pointer', color: n === 1 ? '#2a3349' : '#4a5a7a', padding: 0, lineHeight: 1 }}>
                  <i className="ti ti-chevron-up" style={{ fontSize: 9 }} />
                </button>
                <button onClick={() => moveSeq(n, 'down')} disabled={n === seqCount}
                  style={{ background: 'none', border: 'none', cursor: n === seqCount ? 'not-allowed' : 'pointer', color: n === seqCount ? '#2a3349' : '#4a5a7a', padding: 0, lineHeight: 1 }}>
                  <i className="ti ti-chevron-down" style={{ fontSize: 9 }} />
                </button>
              </div>

              {/* Badge numero */}
              <span style={{ fontSize: 10, fontWeight: 700, color: SEQ_COLOR, background: `color-mix(in srgb, ${SEQ_COLOR} 15%, #0f1117)`, border: `0.5px solid ${SEQ_COLOR}40`, borderRadius: 4, padding: '1px 7px', flexShrink: 0 }}>
                seq_{n}
              </span>

              {/* Label inline editabile */}
              <input
                value={p(`seq_${n}_label`, '')}
                onChange={e => u(`seq_${n}_label`, e.target.value)}
                placeholder={`Pipeline ${n}`}
                style={{ background: 'none', border: 'none', outline: 'none', fontSize: 11, fontWeight: 600, color: cc, fontFamily: 'monospace', flex: 1, minWidth: 0 }}
              />

              {/* Badge condizione */}
              <span style={{ fontSize: 9, fontWeight: 600, color: cc, background: `color-mix(in srgb, ${cc} 12%, #0f1117)`, border: `0.5px solid ${cc}40`, borderRadius: 3, padding: '1px 6px', flexShrink: 0 }}>
                {cond === 'onOk' ? '✓ onOk' : cond === 'onError' ? '✗ onError' : '● always'}
              </span>

              {/* Rimuovi */}
              <button onClick={() => removeSeq(n)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px', flexShrink: 0 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                <i className="ti ti-x" style={{ fontSize: 11 }} />
              </button>
            </div>

            {/* Body sequenza */}
            <div style={{ padding: '10px', background: '#161b27', display: 'flex', flexDirection: 'column', gap: 8 }}>

              {/* Condizione */}
              <div>
                <div style={labelStyle}>Condizione di avvio</div>
                <CustomSelect style={{ ...inputStyle, borderColor: cc + '80' }} value={cond}
                  onChange={e => u(`seq_${n}_condition`, e.target.value)}>
                  <option value="onOk">onOk — la precedente ha avuto successo</option>
                  <option value="onError">onError — la precedente ha fallito</option>
                  <option value="always">always — sempre, qualunque sia l'esito</option>
                </CustomSelect>
                {n === 1 && (
                  <div style={{ fontSize: 9, color: '#4a5a7a', marginTop: 4, fontStyle: 'italic' }}>
                    Per la prima sequenza si riferisce all'esito del nodo trigger in ingresso.
                  </div>
                )}
              </div>

              {/* Timeout */}
              <div>
                <div style={labelStyle}>Timeout (sec) — 0 = nessun limite</div>
                <input type="number" style={inputStyle} min="0"
                  value={p(`seq_${n}_timeout`, '0')}
                  onChange={e => u(`seq_${n}_timeout`, e.target.value)} />
              </div>
            </div>
          </div>
        )
      })}

      {/* Bottone aggiungi — identico a FilterModal "Aggiungi condizione" */}
      <button onClick={addSeq}
        style={{ background: '#1a2030', border: '1px dashed #2a3349', borderRadius: 6, padding: '6px', fontSize: 11, color: SEQ_COLOR, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#1e2535' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#1a2030' }}>
        <i className="ti ti-plus" style={{ fontSize: 11 }} /> Aggiungi sequenza
      </button>

      {/* Schema output */}
      <SectionTitle label="Metadati emessi al completamento" />
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10 }}>
        {[
          { name: 'seq_completed',  color: '#3ddc84', desc: 'Pipeline completate con successo' },
          { name: 'seq_failed',     color: '#ff5f57', desc: 'Pipeline fallite' },
          { name: 'seq_skipped',    color: '#ffb347', desc: 'Pipeline saltate (condizione non soddisfatta)' },
          { name: 'seq_total',      color: '#4a5a7a', desc: 'Totale sequenze configurate' },
          { name: 'seq_elapsed_ms', color: '#4a5a7a', desc: 'Durata totale in ms' },
          { name: 'seq_results',    color: '#4a5a7a', desc: 'Dettaglio esito per ogni sequenza' },
        ].map(f => (
          <div key={f.name} style={{ display: 'flex', gap: 10, marginBottom: 4 }}>
            <code style={{ color: f.color, minWidth: 140, flexShrink: 0 }}>{f.name}</code>
            <span style={{ color: '#4a5a7a', fontSize: 9 }}>{f.desc}</span>
          </div>
        ))}
      </div>

    </div>
  )
}