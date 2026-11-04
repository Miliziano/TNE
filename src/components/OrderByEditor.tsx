/**
 * src/components/OrderByEditor.tsx
 *
 * ORDER BY su più campi (P398), per Aggregate e Window: una riga per campo,
 * con la sua direzione. Il valore resta il testo "campo DESC, campo ASC" nella
 * prop `orderBy`, che il motore legge (engine/ordinamento.rs). Un campo che
 * non esiste fra quelli noti si segnala: il motore lo ignorerebbe.
 */
import { useId, useState } from 'react'
import { leggiOrderBy, scriviOrderBy, type ChiaveOrdine } from '../ir/orderBy'

const box: React.CSSProperties = {
  background: '#0f1117', border: '1px solid #2a3349', borderRadius: 5, color: '#e8ecf4',
  padding: '4px 7px', fontSize: 12, minWidth: 0,
}

export function OrderByEditor({ value, onChange, fields, defaultDir = 'asc', empty = 'No ordering' }: {
  value:       string
  onChange:    (v: string) => void
  /** Campi che si possono usare (suggeriti; altri nomi restano possibili). */
  fields:      string[]
  /** Direzione dei campi scritti senza (vecchia prop orderDir). */
  defaultDir?: string
  empty?:      string
}) {
  const listId = useId()
  // Righe locali: mentre si scrive un nome può essere vuoto, e la riga non
  // deve sparire. Si riallineano quando il valore cambia da fuori.
  const [righe, setRighe] = useState<ChiaveOrdine[]>(() => leggiOrderBy(value, defaultDir))
  const [visto, setVisto] = useState(value)
  if (value !== visto && value !== scriviOrderBy(righe)) {
    setVisto(value)
    setRighe(leggiOrderBy(value, defaultDir))
  }
  const chiavi = righe
  const scrivi = (k: ChiaveOrdine[]) => {
    setRighe(k)
    const testo = scriviOrderBy(k)
    setVisto(testo)
    onChange(testo)
  }
  const cambia = (i: number, patch: Partial<ChiaveOrdine>) => scrivi(chiavi.map((k, j) => (j === i ? { ...k, ...patch } : k)))
  const togli = (i: number) => scrivi(chiavi.filter((_, j) => j !== i))
  const sposta = (i: number, d: -1 | 1) => {
    const n = [...chiavi]; const j = i + d
    if (j < 0 || j >= n.length) return
    ;[n[i], n[j]] = [n[j], n[i]]
    scrivi(n)
  }
  const liberi = fields.filter((f) => !chiavi.some((k) => k.campo === f))
  const aggiungi = () => scrivi([...chiavi, { campo: liberi[0] ?? '', desc: false }])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <datalist id={listId}>{fields.map((f) => <option key={f} value={f} />)}</datalist>
      {chiavi.length === 0 && <div style={{ fontSize: 11, color: '#6a7690' }}>{empty}</div>}
      {chiavi.map((k, i) => {
        const ignoto = fields.length > 0 && k.campo.trim() !== '' && !fields.includes(k.campo.trim())
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 10, color: '#6a7690', width: 14, textAlign: 'right' }}>{i + 1}</span>
            <input list={listId} value={k.campo} onChange={(e) => cambia(i, { campo: e.target.value })} spellCheck={false}
              title={ignoto ? 'This field is not among the known fields: the engine would ignore it' : undefined}
              style={{ ...box, flex: 1, fontFamily: 'monospace', borderColor: ignoto ? '#ffb34780' : '#2a3349' }} />
            <button onClick={() => cambia(i, { desc: !k.desc })} title="Change direction"
              style={{ ...box, cursor: 'pointer', width: 70, color: k.desc ? '#fbbf24' : '#3ddc84' }}>
              {k.desc ? 'DESC ↓' : 'ASC ↑'}
            </button>
            <button onClick={() => sposta(i, -1)} disabled={i === 0} title="Move up"
              style={{ background: 'none', border: 'none', color: '#6a7690', cursor: i === 0 ? 'default' : 'pointer', opacity: i === 0 ? 0.3 : 1 }}>
              <i className="ti ti-chevron-up" />
            </button>
            <button onClick={() => togli(i)} title="Remove"
              style={{ background: 'none', border: 'none', color: '#6a7690', cursor: 'pointer' }}>
              <i className="ti ti-x" />
            </button>
          </div>
        )
      })}
      <button onClick={aggiungi}
        style={{ alignSelf: 'flex-start', fontSize: 11, padding: '3px 10px', borderRadius: 5, cursor: 'pointer',
                 background: 'none', border: '1px dashed #2a3349', color: '#8a94a8' }}>
        <i className="ti ti-plus" style={{ fontSize: 10 }} /> {chiavi.length ? 'then by…' : 'Order by…'}
      </button>
    </div>
  )
}
