import { useState, useEffect } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import type { TMapInputField, TMapFieldType } from '../../../types'
import { FIXED_SCHEMA, isFixedFormat, FIXED_FORMAT_HINT } from '../../fileSchema'
import { readFile } from '../../../lib/tauri'
import { readFileContent } from '../../../runner/readers'
import { CustomSelect } from '../../../components/CustomSelect'
import { readBinaryFile } from '../../../lib/tauri'

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#1e2535',
  border: '1px solid #3a4a6a',
  borderRadius: 4,
  color: '#c8d4f0',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  padding: '5px 8px',
  outline: 'none',
}

import { FIELD_TYPES, TYPE_META } from '../../../types/fieldTypes'
import type { FieldType } from '../../../types/fieldTypes'

// ─── Inferisce il tipo da un valore campione ──────────────────────
function inferType(value: unknown): TMapFieldType {
  if (value === null || value === undefined) return 'string'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'object') return 'object'
  const str = String(value).trim()
  if (str === '') return 'string'
  if (!isNaN(Number(str))) {
    return Number.isInteger(Number(str)) ? 'integer' : 'decimal'
  }
  // Date — pattern semplice
  if (/^\d{4}-\d{2}-\d{2}/.test(str) || /^\d{2}[\/\-]\d{2}[\/\-]\d{4}/.test(str)) {
    return 'date'
  }
  if (['true','false','si','no','yes'].includes(str.toLowerCase())) return 'boolean'
  return 'string'
}

// ─── Inferisce schema da un campione di righe ─────────────────────
function inferSchema(rows: Record<string, unknown>[]): TMapInputField[] {
  if (rows.length === 0) return []

  // Prendi le prime 20 righe per l'inferenza
  const sample = rows.slice(0, 20)
  const keys   = Object.keys(rows[0])

  return keys.map((key, i) => {
    // Conta i tipi nelle righe campione
    const typeCounts = new Map<TMapFieldType, number>()
    for (const row of sample) {
      const t = inferType(row[key])
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1)
    }
    // Tipo più frequente
    let bestType: TMapFieldType = 'string'
    let bestCount = 0
    for (const [type, count] of typeCounts) {
      if (count > bestCount) { bestType = type; bestCount = count }
    }
    return {
      id:           `field_${Date.now()}_${i}`,
      name:         key,
      physicalName: key,
      type:         bestType,
    }
  })
}

export function SourceFileMappingPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const [loading, setLoading]   = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  if (!node) return null

  const format      = node.data.props['format'] ?? 'csv'
  const pathSource  = node.data.props['pathSource'] ?? 'static'
  const hasEffectivePath =
    pathSource === 'static'   ? !!node.data.props['path'] :
    pathSource === 'lane_var' ? !!node.data.props['laneVarName'] :
    pathSource === 'flow'     ? !!node.data.props['pathField'] :
    false
  const isFixed     = isFixedFormat(format)
  const fixedSchema = FIXED_SCHEMA[format]

  const getSchema = (): TMapInputField[] => {
    try {
      const raw = node.data.props['outputSchema']
      if (raw) return JSON.parse(raw)
    } catch {}
    return fixedSchema ?? []
  }

  const saveSchema = (fields: TMapInputField[]) => {
    const oldSchema = getSchema()
    updateProp(nodeId, 'outputSchema', JSON.stringify(fields))

    const store    = useFlowStore.getState()
    const outEdges = store.edges.filter((e) => e.source === nodeId)

    outEdges.forEach((edge) => {
      const tgt = store.nodes.find((n) => n.id === edge.target)
      if (!tgt || tgt.data.type !== 'tmap') return

      const tmap = tgt.data.config?.tmap as import('../../../types').TMapConfig | undefined
      if (!tmap) return

      const input = tmap.inputs.find((i) => i.id === edge.targetHandle)
      if (!input) return

      const idToNewName = new Map<string, string>()
      fields.forEach((f) => { if (f.id) idToNewName.set(f.id, f.name) })

      const renames: import('../../../types').FieldRenameEntry[] = []
      oldSchema.forEach((oldField) => {
        if (!oldField.id) return
        const newName = idToNewName.get(oldField.id)
        if (newName && newName !== oldField.name) {
          renames.push({ fieldId: oldField.id, inputId: input.id, oldName: oldField.name, newName })
        }
      })

      const deletedFields = oldSchema.filter((f) =>
        !fields.find((nf) => nf.name === f.name || (f.id && nf.id === f.id))
      )

      const newFieldNames = new Set(fields.map((f) => f.name))
      const existingNames = new Set(input.fields.map((f) => f.name))

      const merged = [
        ...input.fields
          .filter((f) => f.name.startsWith('status.') || newFieldNames.has(f.name) || renames.some((r) => r.oldName === f.name))
          .map((f) => {
            const rename = renames.find((r) => r.oldName === f.name)
            if (rename) return { ...f, name: rename.newName }
            const updated = fields.find((nf) => nf.name === f.name)
            return updated ? { ...f, type: updated.type } : f
          }),
        ...fields
          .filter((f) => !existingNames.has(f.name) && !renames.some((r) => r.newName === f.name))
          .map((f) => ({ name: f.name, type: f.type })),
      ]

      if (renames.length > 0 && tmap.connections?.length) {
        const updatedConnections = tmap.connections.map((conn) => {
          if (conn.inputId !== input.id) return conn
          const rename = renames.find((r) => r.oldName === conn.fieldName)
          return rename
            ? { ...conn, fieldName: rename.newName, id: conn.id.replace(`__${conn.fieldName}__`, `__${rename.newName}__`) }
            : conn
        })
        store.setTMapConnections(tgt.id, updatedConnections)
      }
      if (renames.length > 0) store.applyTMapRenames(tgt.id, renames)
      deletedFields.forEach((f) => store.removeFieldFromTransforms(tgt.id, input.id, f.name))
      store.updateTMapInput(tgt.id, input.id, { fields: merged })
    })
  }

  const schema = getSchema()

  const addField = () => {
    const n = schema.length + 1
    const name = `campo_${n}`
    saveSchema([...schema, { id: `field_${Date.now()}`, name, physicalName: name, type: 'string' as TMapFieldType }])
  }

  const updateField = (idx: number, key: string, value: string) => {
    if (key === 'physicalName') return
    saveSchema(schema.map((f, i) => i === idx ? { ...f, [key]: value } : f))
  }

  const deleteField = (idx: number) => {
    saveSchema(schema.filter((_, i) => i !== idx))
  }

  const moveField = (idx: number, dir: 'up' | 'down') => {
    const arr     = [...schema]
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= arr.length) return
    ;[arr[idx], arr[swapIdx]] = [arr[swapIdx], arr[idx]]
    saveSchema(arr)
  }

  // ── Carica schema reale dal file ──────────────────────────────
  const loadPreview = async () => {
    const path = node.data.props['path'] ?? ''
    if (!path) return

    setLoading(true)
    setLoadError(null)

    try {
      const filename  = path.split('/').pop() ?? path
      const ext       = filename.split('.').pop()?.toLowerCase() ?? ''
      const delimiter = node.data.props['delimiter'] ?? ','
      const sheetName = node.data.props['sheetName'] ?? undefined
      const rootPath  = node.data.props['xmlRootPath'] ?? undefined

      let content: string | ArrayBuffer

      if (ext === 'xlsx' || ext === 'xls') {
        content = await readBinaryFile(path)
      } else {
        content = await readFile(path)
      }

      // Leggi le prime 50 righe per inferire lo schema
      const allRows = await readFileContent(content, filename, {
        delimiter: delimiter || ',',
        sheetName: sheetName || undefined,
        rootPath:  rootPath  || undefined,
      })

      const sample = allRows.slice(0, 50)
      if (sample.length === 0) {
        setLoadError('Il file è vuoto o non contiene righe leggibili.')
        return
      }

      const inferred    = inferSchema(sample as Record<string, unknown>[])
      const existingIds = new Set(schema.map((f) => f.id))

      // Sostituisci schema esistente con quello reale
      // Mantieni personalizzazioni (tipo, nome logico) se il campo fisico coincide
      const merged = inferred.map((newField) => {
        const existing = schema.find((f) => (f as any).physicalName === newField.physicalName || f.name === newField.name)
        if (existing) {
          return { ...newField, id: existing.id, name: existing.name, type: existing.type }
        }
        return newField
      })

      saveSchema(merged)
      setLoadError(null)

    } catch (err) {
      setLoadError(`Errore lettura file: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const s = getSchema()
    const needsFix = s.some((f) => !f.id || !(f as any).physicalName)
    if (needsFix) {
      updateProp(nodeId, 'outputSchema', JSON.stringify(
        s.map((f, i) => ({
          ...f,
          id:           f.id ?? `field_${Date.now()}_${i}`,
          physicalName: (f as any).physicalName ?? f.name,
        }))
      ))
    }
  }, [nodeId])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#c8d4f0', flex: 1 }}>
          Schema di uscita
          <span style={{ fontSize: 10, color: '#4a5a7a', fontWeight: 400, marginLeft: 8 }}>
            — i campi propagati ai nodi successivi
          </span>
        </div>
        {!isFixed && (
          <button
            onClick={loadPreview}
            disabled={loading || !hasEffectivePath}
            title={!hasEffectivePath ? 'Configura prima il path del file nel tab Configurazione' : 'Legge il file reale e inferisce i tipi automaticamente'}
            style={{
              padding: '5px 12px', fontSize: 11, borderRadius: 4,
              cursor: loading || !hasEffectivePath ? 'not-allowed' : 'pointer',
              opacity: !hasEffectivePath ? 0.5 : 1,
              background: '#1a3a6a', color: '#4a9eff',
              border: '1px solid #2a5a9a',
              display: 'flex', alignItems: 'center', gap: 5,
            }}
            onMouseEnter={(e) => { if (hasEffectivePath) (e.currentTarget as HTMLElement).style.background = '#2a4a7a' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a3a6a' }}
          >
            <i className={`ti ${loading ? 'ti-loader spin' : 'ti-file-search'}`} style={{ fontSize: 12 }} aria-hidden="true" />
            {loading ? 'Lettura...' : 'Rileva dal file'}
          </button>
        )}
      </div>

      <div style={{ borderBottom: '0.5px solid #2a3349' }} />

      {/* Errore lettura */}
      {loadError && (
        <div style={{ padding: '8px 10px', background: '#2a0a0a', borderRadius: 6, border: '0.5px solid #ff5f5730', fontSize: 10, color: '#ff5f57', display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <i className="ti ti-alert-circle" style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }} />
          {loadError}
        </div>
      )}

      {/* Info formato */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 11 }}>
        <i className="ti ti-file" style={{ fontSize: 13, color: '#4a9eff' }} aria-hidden="true" />
        <span style={{ color: '#9a9aaa' }}>Formato:</span>
        <span style={{ padding: '1px 7px', borderRadius: 8, fontSize: 10, background: '#1a3a6a', color: '#4a9eff', fontWeight: 600 }}>
          {format.toUpperCase()}
        </span>
        {isFixed && <span style={{ fontSize: 10, color: '#4a5a7a', marginLeft: 4, fontStyle: 'italic' }}>schema fisso</span>}
        {!isFixed && <span style={{ fontSize: 10, color: '#4a5a7a', marginLeft: 4, fontStyle: 'italic' }}>{schema.length} campi</span>}
      </div>

      {/* Schema fisso */}
      {isFixed && fixedSchema && (
        <>
          <div style={{ padding: '8px 10px', fontSize: 11, color: '#4a5a7a', fontStyle: 'italic', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
            <i className="ti ti-info-circle" style={{ fontSize: 12, marginRight: 5 }} />
            {FIXED_FORMAT_HINT[format] ?? `Il formato ${format} produce uno schema fisso non modificabile.`}
          </div>
          <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8, padding: '5px 10px', background: '#1a2030', borderBottom: '0.5px solid #3a4a6a' }}>
              {['Campo', 'Tipo'].map((h) => (
                <div key={h} style={{ fontSize: 10, color: '#4a9eff', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
              ))}
            </div>
            {fixedSchema.map((f, i) => (
              <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8, padding: '6px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < fixedSchema.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#c8d4f0' }}>{f.name}</span>
                <span style={{
                    fontSize: 9, padding: '1px 6px', borderRadius: 8, textAlign: 'center',
                    background: TYPE_META[f.type as FieldType]?.bg    ?? '#1a3a6a',
                    color:      TYPE_META[f.type as FieldType]?.color ?? '#4a9eff',
                  }}>
                  {f.type}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Schema modificabile */}
      {!isFixed && (
        <>
          {schema.length === 0 && (
            <div style={{ padding: '20px', textAlign: 'center', color: '#4a5a7a', fontSize: 12, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
              <i className="ti ti-file-search" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} aria-hidden="true" />
              Clicca <strong style={{ color: '#4a9eff' }}>Rileva dal file</strong> per leggere lo schema reale,<br />oppure aggiungi i campi manualmente.
            </div>
          )}

          {schema.length > 0 && (
            <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '24px minmax(80px, 1fr) minmax(80px, 1fr) 80px minmax(80px, 1fr) 24px', gap: 6, padding: '5px 8px', background: '#1a2030', borderBottom: '0.5px solid #3a4a6a' }}>
                {['', 'Col. fisica', 'Nome logico', 'Tipo', 'Trasformazione', ''].map((h, i) => (
                  <div key={i} style={{ fontSize: 10, color: '#4a9eff', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
                ))}
              </div>

              {schema.map((field, idx) => (
                <div key={idx} style={{ display: 'grid', gridTemplateColumns: '24px minmax(80px, 1fr) minmax(80px, 1fr) 80px minmax(80px, 1fr) 24px', gap: 6, alignItems: 'center', padding: '4px 8px', background: idx % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: idx < schema.length - 1 ? '0.5px solid #2a3349' : 'none' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <button onClick={() => moveField(idx, 'up')} disabled={idx === 0}
                      style={{ background: 'none', border: 'none', cursor: idx === 0 ? 'not-allowed' : 'pointer', color: idx === 0 ? '#2a3349' : '#4a5a7a', padding: 0, lineHeight: 1 }}>
                      <i className="ti ti-chevron-up" style={{ fontSize: 9 }} aria-hidden="true" />
                    </button>
                    <button onClick={() => moveField(idx, 'down')} disabled={idx === schema.length - 1}
                      style={{ background: 'none', border: 'none', cursor: idx === schema.length - 1 ? 'not-allowed' : 'pointer', color: idx === schema.length - 1 ? '#2a3349' : '#4a5a7a', padding: 0, lineHeight: 1 }}>
                      <i className="ti ti-chevron-down" style={{ fontSize: 9 }} aria-hidden="true" />
                    </button>
                  </div>

                  <div title={(field as any).physicalName || field.name}
                    style={{ fontFamily: 'monospace', fontSize: 10, color: '#4a5a7a', padding: '3px 6px', background: '#161b27', borderRadius: 4, border: '0.5px solid #2a3349', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {(field as any).physicalName || field.name}
                  </div>

                  <input type="text" value={field.name}
                    onChange={(e) => updateField(idx, 'name', e.target.value)}
                    style={{ ...inputStyle, fontSize: 11, padding: '3px 6px' }}
                    placeholder="nome_logico" />

                  <CustomSelect value={field.type}
                    onChange={(e) => updateField(idx, 'type', e.target.value)}
                    style={{
                      ...inputStyle, fontSize: 10, padding: '3px 4px',
                      color:      TYPE_META[field.type as FieldType]?.color ?? '#c8d4f0',
                      background: TYPE_META[field.type as FieldType]?.bg    ?? '#1e2535',
                      border:     `1px solid ${TYPE_META[field.type as FieldType]?.color ?? '#3a4a6a'}40`,
                    }}>
                    {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </CustomSelect>

                  <CustomSelect value={(field as any).transform ?? ''} onChange={(e) => updateField(idx, 'transform', e.target.value)}
                    style={{ ...inputStyle, fontSize: 10, padding: '3px 2px' }}>
                    <option value="">nessuna</option>
                    <option value="trim">trim</option>
                    <option value="uppercase">UPPER</option>
                    <option value="lowercase">lower</option>
                    <option value="to_int">→ int</option>
                    <option value="to_float">→ dec</option>
                    <option value="to_date">→ data</option>
                    <option value="to_bool">→ bool</option>
                    <option value="to_string">→ str</option>
                    <option value="nullify_empty">vuoto→null</option>
                  </CustomSelect>

                  <button onClick={() => deleteField(idx)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                    <i className="ti ti-x" style={{ fontSize: 11 }} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <button onClick={addField}
            style={{ background: '#1a2030', border: '1px dashed #2a3349', borderRadius: 6, padding: '7px', fontSize: 11, color: '#4a9eff', cursor: 'pointer', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1e2535' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a2030' }}>
            <i className="ti ti-plus" style={{ fontSize: 12 }} aria-hidden="true" />
            Aggiungi campo manualmente
          </button>

          <div style={{ padding: '6px 10px', fontSize: 10, color: '#4a5a7a', fontStyle: 'italic', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349' }}>
            <i className="ti ti-info-circle" style={{ fontSize: 11, marginRight: 4 }} aria-hidden="true" />
            <strong style={{ color: '#9a9aaa' }}>Rileva dal file</strong> legge le prime 50 righe e inferisce i tipi automaticamente.
            Puoi modificare nome logico e tipo dopo il rilevamento.
          </div>
        </>
      )}
    </div>
  )
}