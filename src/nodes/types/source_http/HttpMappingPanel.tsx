import { useCallback, useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { propagateSchema } from '../../../utils/schemaUtils'
import type { SchemaField } from '../../../utils/schemaUtils'
import { CustomSelect } from '../../../components/CustomSelect'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}

import { FIELD_TYPES } from '../../../types/fieldTypes'

interface OutputField {
  id:     string
  name:   string
  type:   string
  fixed:  boolean
  hint?:  string
}

// ─── Campi fissi sempre presenti ─────────────────────────────────
const FIXED_FIELDS: OutputField[] = [
  { id: 'f_status_code',  name: 'status_code',  type: 'integer', fixed: true, hint: 'Codice HTTP risposta' },
  { id: 'f_content_type', name: 'content_type', type: 'string',  fixed: true, hint: 'Content-Type header'  },
  { id: 'f_latency_ms',   name: 'latency_ms',   type: 'integer', fixed: true, hint: 'Tempo risposta in ms' },
  { id: 'f_headers',      name: 'headers',      type: 'object',  fixed: true, hint: 'Headers risposta'     },
]

// ─── Campi aggiuntivi per tipo risposta ──────────────────────────
const RESPONSE_TYPE_FIELDS: Record<string, OutputField[]> = {
  json: [],  // campi dichiarati dall'utente nel pannello custom
  json_raw: [
    { id: 'f_body',        name: 'body',        type: 'string', fixed: true, hint: 'Body JSON grezzo come stringa'   },
    { id: 'f_body_parsed', name: 'body_parsed', type: 'object', fixed: true, hint: 'Body JSON già parsato come oggetto' },
  ],
  text: [
    { id: 'f_body', name: 'body', type: 'string', fixed: true, hint: 'Body testuale grezzo' },
  ],
  xml: [
    { id: 'f_body', name: 'body', type: 'string', fixed: true, hint: 'Body XML grezzo' },
  ],
  csv: [
    { id: 'f_body', name: 'body', type: 'string', fixed: true, hint: 'Body CSV grezzo' },
  ],
  binary: [
    { id: 'f_content',        name: 'content',        type: 'string',  fixed: true, hint: 'Body in base64'       },
    { id: 'f_content_length', name: 'content_length', type: 'integer', fixed: true, hint: 'Dimensione in byte'   },
  ],
  pdf: [
    { id: 'f_content',        name: 'content',        type: 'string',  fixed: true, hint: 'PDF in base64'        },
    { id: 'f_content_length', name: 'content_length', type: 'integer', fixed: true, hint: 'Dimensione in byte'   },
  ],
}

const RESPONSE_TYPE_LABELS: Record<string, string> = {
  json:     'JSON — campi estratti',
  json_raw: 'JSON raw — body completo',
  text:     'Testo',
  xml:      'XML',
  csv:      'CSV',
  binary:   'Binario',
  pdf:      'PDF',
}

export function HttpMappingPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const responseType = p('responseType', 'json')

  // ── Campi custom dichiarati dall'utente ───────────────────────
  const customFields: OutputField[] = useMemo(() => {
    try { return JSON.parse(p('customFields')) } catch { return [] }
  }, [p('customFields')])

  // ── Schema completo = fissi + tipo risposta + custom ──────────
  const fixedForType = RESPONSE_TYPE_FIELDS[responseType] ?? []

  const allFixed: OutputField[] = [...FIXED_FIELDS, ...fixedForType]

  // ── Salva e propaga ───────────────────────────────────────────
  const saveAndPropagate = useCallback((custom: OutputField[]) => {
    updateProp(nodeId, 'customFields', JSON.stringify(custom))
    const schema: SchemaField[] = [
      ...FIXED_FIELDS,
      ...fixedForType,
      ...custom,
    ].map((f) => ({ id: f.id, name: f.name, type: f.type, physicalName: f.name }))
    updateProp(nodeId, 'outputSchema', JSON.stringify(schema))
    propagateSchema(nodeId, schema, useFlowStore.getState())
  }, [nodeId, updateProp, fixedForType])

  const addField = useCallback(() => {
    const n = customFields.length + 1
    saveAndPropagate([...customFields, {
      id: `cf_${n}`, name: `campo_${n}`, type: 'string', fixed: false,
    }])
  }, [customFields, saveAndPropagate])

  const updateField = useCallback((id: string, key: string, value: string) => {
    saveAndPropagate(customFields.map((f) => f.id === id ? { ...f, [key]: value } : f))
  }, [customFields, saveAndPropagate])

  const deleteField = useCallback((id: string) => {
    saveAndPropagate(customFields.filter((f) => f.id !== id))
  }, [customFields, saveAndPropagate])

  // ── Mostra campi custom solo per json ─────────────────────────
  const showCustomFields = responseType === 'json'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Info tipo risposta ───────────────────────────────── */}
      <div style={{ padding: '8px 12px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', gap: 8 }}>
        <i className="ti ti-world" style={{ fontSize: 14, color: '#4a9eff' }} />
        <div>
          <div style={{ fontSize: 11, color: '#c8d4f0', fontWeight: 600 }}>
            Tipo risposta: <span style={{ color: '#4a9eff' }}>{RESPONSE_TYPE_LABELS[responseType] ?? responseType}</span>
          </div>
          <div style={{ fontSize: 10, color: '#4a5a7a' }}>
            Configura il tipo nel tab Configurazione · i campi fissi cambiano di conseguenza
          </div>
        </div>
      </div>

      {/* ── Campi fissi ──────────────────────────────────────── */}
      <div style={{ background: '#161b27', border: '1px solid #2a3349', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '8px 12px', background: '#1a2030', borderBottom: '1px solid #2a3349', display: 'flex', alignItems: 'center', gap: 6 }}>
          <i className="ti ti-lock" style={{ fontSize: 11, color: '#4a5a7a' }} />
          <span style={{ fontSize: 11, fontWeight: 600, color: '#9a9aaa' }}>Campi fissi — sempre presenti</span>
        </div>
        <div style={{ padding: '4px 0' }}>
          {allFixed.map((f, idx) => (
            <div key={f.id}
              style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 6, alignItems: 'center', padding: '5px 12px', background: idx % 2 === 0 ? '#1a2030' : 'transparent', borderBottom: idx < allFixed.length - 1 ? '0.5px solid #2a3349' : 'none' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <code style={{ fontSize: 10, color: responseType === 'json_raw' && f.id.startsWith('f_body') ? '#a78bfa' : '#4a9eff' }}>
                  {f.name}
                </code>
                {f.hint && <span style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic' }}>{f.hint}</span>}
              </div>
              <div style={{ fontSize: 9, color: '#4a5a7a', padding: '2px 6px', background: '#0f1117', borderRadius: 4, textAlign: 'center', border: '0.5px solid #2a3349' }}>
                {f.type}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Info json_raw ─────────────────────────────────────── */}
      {responseType === 'json_raw' && (
        <div style={{ padding: '8px 12px', background: '#1a1030', border: '1px solid #3a1a6a', borderRadius: 6, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <i className="ti ti-info-circle" style={{ fontSize: 13, color: '#a78bfa', flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 10, color: '#a78bfa' }}>
            In modalità <strong>JSON raw</strong> il body completo viene passato ai nodi successivi senza estrarre campi.
            Usa un nodo <strong>JSON Parser</strong> o <strong>Script</strong> dopo questo per elaborare <code>body_parsed</code>.
          </div>
        </div>
      )}

      {/* ── Campi JSON custom (solo per tipo json) ────────────── */}
      {showCustomFields && (
        <div style={{ background: '#161b27', border: '1px solid #2a3349', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', background: '#1a2030', borderBottom: '1px solid #2a3349', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#c8d4f0' }}>Campi JSON da estrarre</div>
              <div style={{ fontSize: 9, color: '#4a5a7a' }}>
                Dichiara i campi del JSON che vuoi propagare ai nodi successivi
              </div>
            </div>
            <button onClick={addField}
              style={{ background: 'none', border: '0.5px dashed #2a3349', borderRadius: 4, padding: '2px 8px', fontSize: 9, cursor: 'pointer', color: '#4a9eff' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#4a9eff' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
              <i className="ti ti-plus" style={{ fontSize: 9 }} /> campo
            </button>
          </div>

          {customFields.length === 0 ? (
            <div style={{ padding: '16px 12px', fontSize: 10, color: '#2a3349', fontStyle: 'italic', textAlign: 'center' }}>
              Aggiungi i campi che il JSON di risposta contiene — oppure usa il bottone "Testa connessione" per rilevarli automaticamente
            </div>
          ) : (
            <div style={{ padding: '4px 0' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 24px', gap: 6, padding: '3px 12px 5px', borderBottom: '0.5px solid #2a3349' }}>
                {['Nome', 'Tipo', ''].map((h, i) => (
                  <div key={i} style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>{h}</div>
                ))}
              </div>
              {customFields.map((f, idx) => (
                <div key={f.id}
                  style={{ display: 'grid', gridTemplateColumns: '1fr 80px 24px', gap: 6, alignItems: 'center', padding: '4px 12px', background: idx % 2 === 0 ? '#1a2030' : 'transparent' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1e2535' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = idx % 2 === 0 ? '#1a2030' : 'transparent' }}>
                  <input value={f.name}
                    onChange={(e) => updateField(f.id, 'name', e.target.value)}
                    style={{ ...inputStyle, fontSize: 10, padding: '3px 6px' }}
                    placeholder="nome campo" />
                  <CustomSelect value={f.type}
                    onChange={(e) => updateField(f.id, 'type', e.target.value)}
                    style={{ ...inputStyle, fontSize: 10, padding: '3px 4px' }}>
                    {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </CustomSelect>
                  <button onClick={() => deleteField(f.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                    <i className="ti ti-x" style={{ fontSize: 10 }} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Info propagazione ────────────────────────────────── */}
      <div style={{ padding: '6px 10px', fontSize: 10, color: '#4a5a7a', fontStyle: 'italic', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', display: 'flex', alignItems: 'flex-start', gap: 5 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }} />
        Lo schema viene propagato automaticamente ai nodi collegati.
        {responseType === 'json' && ' Usa "Testa connessione" nel tab Configurazione per rilevare i campi automaticamente.'}
        {responseType === 'json_raw' && ' Usa un nodo Script o JSON Parser per elaborare il body completo.'}
      </div>

    </div>
  )
}
