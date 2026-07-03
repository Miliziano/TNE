/**
 * src/nodes/types/report_generator/MappingPanel.tsx
 * ────────────────────────────────────────────────────
 * Tab Mapping del Report Generator.
 * Mostra i campi in ingresso e la struttura del record in uscita.
 */
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../useIncomingSchema'
import { useMemo } from 'react'
import { CustomSelect } from '../../../components/CustomSelect'

const ACCENT = '#f472b6'

export function ReportGeneratorMappingPanel({ nodeId }: { nodeId: string }) {
  const node   = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const fields = useIncomingSchema(nodeId)

  if (!node) return null

  const props      = node.data.props ?? {}
  const templateId = (props['templateId']   as string) ?? 'table'
  const outputFmt  = (props['outputFormat'] as string) ?? 'html'
  const xField     = (props['chartXField']  as string) ?? ''
  const yField     = (props['chartYField']  as string) ?? ''
  const kpiRaw     = (props['kpiFields']    as string) ?? ''
  const kpiFields  = kpiRaw.split(',').map((s) => s.trim()).filter(Boolean)

  let columns: Array<{ field: string; label: string; type: string }> = []
  try { columns = JSON.parse((props['columns'] as string) ?? '[]') } catch {}

  // Campi usati in base al template
  const usedFields = useMemo(() => {
    const used = new Set<string>()
    if (templateId === 'table' || templateId === 'mixed') {
      if (columns.length > 0) columns.forEach((c) => { if (c.field) used.add(c.field) })
      else fields.forEach((f) => used.add(f.name))
    }
    if (['bar_chart','line_chart','pie_chart','mixed'].includes(templateId)) {
      if (xField) used.add(xField)
      if (yField) used.add(yField)
    }
    if (templateId === 'summary' || templateId === 'mixed') {
      kpiFields.forEach((f) => used.add(f))
    }
    return used
  }, [templateId, columns, fields, xField, yField, kpiFields])

  const templateLabels: Record<string, string> = {
    table:      '⊞ Tabella dati',
    summary:    '◉ Summary KPI',
    bar_chart:  '▦ Bar Chart',
    line_chart: '↗ Line Chart',
    pie_chart:  '◔ Pie Chart',
    mixed:      '⊕ Report completo',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
        <div style={{ fontWeight: 600, color: ACCENT, marginBottom: 2 }}>📊 Report Generator</div>
        Bufferizza tutte le righe in ingresso e produce <strong style={{ color: '#c8d4f0' }}>un solo record</strong> in uscita
        con il report completo in formato <strong style={{ color: ACCENT }}>{outputFmt.toUpperCase()}</strong>.
      </div>

      {/* Template e formato attivi */}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ padding: '4px 10px', borderRadius: 8, background: `color-mix(in srgb, ${ACCENT} 10%, #0f1117)`, color: ACCENT, fontSize: 10, border: `0.5px solid ${ACCENT}30` }}>
          {templateLabels[templateId] ?? templateId}
        </div>
        <div style={{ padding: '4px 10px', borderRadius: 8, background: '#1a2030', color: '#4a9eff', fontSize: 10, border: '0.5px solid #2a3349' }}>
          {outputFmt.toUpperCase()}
        </div>
      </div>

      {/* Campi in ingresso */}
      <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${ACCENT}30` }}>
        Campi in ingresso — {fields.length}
      </div>

      {fields.length === 0 ? (
        <div style={{ padding: '16px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-plug-connected-x" style={{ fontSize: 20, display: 'block', marginBottom: 6 }} />
          Collega un nodo in ingresso per vedere i campi disponibili.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {fields.map((field) => {
            const isUsed = usedFields.has(field.name)
            return (
              <div key={field.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: '#1a2030', borderRadius: 4, border: `0.5px solid ${isUsed ? ACCENT + '40' : '#2a3349'}`, borderLeft: `3px solid ${isUsed ? ACCENT : '#2a3349'}` }}>
                <code style={{ fontSize: 11, color: isUsed ? ACCENT : '#9a9aaa', flex: 1 }}>{field.name}</code>
                <span style={{ fontSize: 9, color: '#4a5a7a', minWidth: 50 }}>{field.type}</span>
                {isUsed && (
                  <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, background: `color-mix(in srgb, ${ACCENT} 10%, #0f1117)`, color: ACCENT, border: `0.5px solid ${ACCENT}30` }}>
                    usato
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Configurazione attiva */}
      {(xField || yField || kpiFields.length > 0 || columns.length > 0) && (
        <>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: '0.5px solid #2a3349' }}>
            Configurazione attiva
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 10, color: '#9a9aaa' }}>
            {xField && <div>Asse X / Categoria: <code style={{ color: ACCENT }}>{xField}</code></div>}
            {yField && <div>Asse Y / Valore: <code style={{ color: ACCENT }}>{yField}</code></div>}
            {kpiFields.length > 0 && <div>KPI: {kpiFields.map((f) => <code key={f} style={{ color: ACCENT, marginRight: 4 }}>{f}</code>)}</div>}
            {columns.length > 0 && <div>Colonne configurate: <strong style={{ color: '#c8d4f0' }}>{columns.length}</strong></div>}
            {columns.length === 0 && (templateId === 'table' || templateId === 'mixed') && (
              <div style={{ color: '#ffb347' }}>
                <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 4 }} />
                Nessuna colonna configurata — verranno usati tutti i campi in ingresso.
              </div>
            )}
          </div>
        </>
      )}

      {/* Schema output */}
      <div style={{ fontSize: 10, fontWeight: 600, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: '0.5px solid #2a3349' }}>
        Record in uscita — 1 record
      </div>
      <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 70px 1fr', gap: 8, padding: '5px 10px', background: '#1a2030', borderBottom: '0.5px solid #3a4a6a' }}>
          {['Campo', 'Tipo', 'Descrizione'].map((h) => (
            <div key={h} style={{ fontSize: 9, color: ACCENT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
          ))}
        </div>
        {[
          { name: 'content',      type: 'string',  desc: outputFmt === 'excel' ? 'Contenuto Excel codificato base64' : 'Documento HTML completo' },
          { name: 'content_type', type: 'string',  desc: outputFmt === 'excel' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/html' },
          { name: 'filename',     type: 'string',  desc: `Nome file suggerito (es. report.${outputFmt === 'excel' ? 'xlsx' : 'html'})` },
          { name: 'row_count',    type: 'integer', desc: 'Numero di righe elaborate' },
          { name: 'generated_at', type: 'date',    desc: 'Timestamp generazione ISO8601' },
          { name: 'template',     type: 'string',  desc: `Template usato: ${templateId}` },
          { name: 'format',       type: 'string',  desc: `Formato: ${outputFmt}` },
        ].map((f, i, arr) => (
          <div key={f.name} style={{ display: 'grid', gridTemplateColumns: '120px 70px 1fr', gap: 8, padding: '6px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
            <code style={{ fontFamily: 'monospace', fontSize: 10, color: ACCENT }}>{f.name}</code>
            <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.type}</span>
            <span style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.4 }}>{f.desc}</span>
          </div>
        ))}
      </div>

      {/* Suggerimento */}
      <div style={{ padding: '6px 10px', fontSize: 10, color: '#4a5a7a', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', display: 'flex', gap: 6 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, color: ACCENT, flexShrink: 0 }} />
        {outputFmt === 'excel'
          ? 'Per salvare il file: collega un nodo Script che legge content (base64) e lo scrive su disco con Buffer.from(content, "base64").'
          : 'Per salvare il file HTML: collega un nodo File Output configurato con formato "testo" e scrivi il campo content.'}
      </div>
    </div>
  )
}
