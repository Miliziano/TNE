/**
 * src/nodes/types/xml_serializer/Panel.tsx
 *
 * Serializza righe del flusso in XML.
 * Speculare al XmlParser in ingresso — supporta import XSD,
 * configurazione elementi vs attributi, namespace, strutture nested.
 */
import { useState, useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../../nodes/useIncomingSchema'
import { CustomSelect } from '../../../components/CustomSelect'

const ACCENT = '#f97316'

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
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

// ─── Tipi struttura XML ──────────────────────────────────────────
type XmlNodeKind = 'element' | 'attribute' | 'cdata' | 'group'

interface XmlOutputNode {
  id:          string
  xmlName:     string        // nome elemento/attributo XML
  sourceField: string        // campo sorgente del flusso
  kind:        XmlNodeKind
  namespace:   string        // prefisso namespace opzionale
  transform:   string
  nullable:    'omit' | 'empty' | 'xsi_nil'  // gestione null in XML
  children?:   XmlOutputNode[]
}

const TRANSFORMS = [
  { value: '',           label: 'nessuna'    },
  { value: 'to_string',  label: '→ string'   },
  { value: 'to_int',     label: '→ integer'  },
  { value: 'to_float',   label: '→ decimal'  },
  { value: 'to_bool',    label: '→ boolean'  },
  { value: 'to_date',    label: '→ date ISO' },
  { value: 'uppercase',  label: 'UPPER'      },
  { value: 'lowercase',  label: 'lower'      },
  { value: 'trim',       label: 'trim'       },
]

// ─── Riga nodo XML ───────────────────────────────────────────────
function XmlNodeRow({ node, depth, fields, onChange, onDelete, onAddChild }: {
  node:       XmlOutputNode
  depth:      number
  fields:     Array<{ name: string; type: string }>
  onChange:   (id: string, patch: Partial<XmlOutputNode>) => void
  onDelete:   (id: string) => void
  onAddChild: (parentId: string, kind: XmlNodeKind) => void
}) {
  const indent   = depth * 16
  const isGroup  = node.kind === 'group'
  const isAttr   = node.kind === 'attribute'
  const isCdata  = node.kind === 'cdata'

  const kindColor = isAttr  ? '#4a9eff'
                  : isCdata ? '#a78bfa'
                  : isGroup ? '#ffb347'
                  : ACCENT

  const kindLabel = isAttr  ? '@attr'
                  : isCdata ? 'CDATA'
                  : isGroup ? '<grp>'
                  : '<elm>'

  const fullName = node.namespace ? `${node.namespace}:${node.xmlName}` : node.xmlName

  return (
    <div style={{ marginLeft: indent }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px', background: depth % 2 === 0 ? '#1a2030' : '#1e2535', borderRadius: 4, marginBottom: 2, border: `0.5px solid ${kindColor}20` }}>

        {/* Tipo badge */}
        <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 4, background: `color-mix(in srgb, ${kindColor} 15%, #0f1117)`, color: kindColor, fontWeight: 600, flexShrink: 0, minWidth: 38, textAlign: 'center' }}>
          {kindLabel}
        </span>

        {/* Namespace */}
        <input value={node.namespace}
          onChange={(e) => onChange(node.id, { namespace: e.target.value })}
          style={{ ...inputStyle, fontSize: 9, padding: '2px 4px', width: 50, flexShrink: 0, color: '#4a5a7a' }}
          placeholder="ns" title="Prefisso namespace (opzionale)" />

        {/* Nome XML */}
        <input value={node.xmlName}
          onChange={(e) => onChange(node.id, { xmlName: e.target.value })}
          style={{ ...inputStyle, fontSize: 10, padding: '2px 6px', flex: 1, color: kindColor, fontWeight: 600 }}
          placeholder={isAttr ? 'nome_attributo' : 'nome_elemento'} />

        {/* Campo sorgente — non per group */}
        {!isGroup && (
          <>
            <span style={{ color: '#2a3349', fontSize: 10, flexShrink: 0 }}>←</span>
            {fields.length > 0 ? (
              <CustomSelect value={node.sourceField}
                onChange={(e) => onChange(node.id, { sourceField: e.target.value })}
                style={{ ...inputStyle, fontSize: 10, padding: '2px 3px', flex: 1 }}>
                <option value="">— sorgente —</option>
                {fields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
              </CustomSelect>
            ) : (
              <input value={node.sourceField}
                onChange={(e) => onChange(node.id, { sourceField: e.target.value })}
                style={{ ...inputStyle, fontSize: 10, padding: '2px 6px', flex: 1 }}
                placeholder="campo_sorgente" />
            )}
            <CustomSelect value={node.transform}
              onChange={(e) => onChange(node.id, { transform: e.target.value })}
              style={{ ...inputStyle, fontSize: 9, padding: '2px 2px', width: 70, flexShrink: 0 }}>
              {TRANSFORMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </CustomSelect>
            <CustomSelect value={node.nullable}
              onChange={(e) => onChange(node.id, { nullable: e.target.value as any })}
              style={{ ...inputStyle, fontSize: 9, padding: '2px 2px', width: 72, flexShrink: 0 }}>
              <option value="omit">omit</option>
              <option value="empty">empty</option>
              <option value="xsi_nil">xsi:nil</option>
            </CustomSelect>
          </>
        )}

        {/* Aggiungi figli — solo per element e group */}
        {(node.kind === 'element' || node.kind === 'group') && (
          <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
            <button onClick={() => onAddChild(node.id, 'element')}
              style={{ padding: '1px 4px', fontSize: 9, borderRadius: 3, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 10%, #1a2030)`, color: ACCENT, border: `0.5px solid ${ACCENT}40` }}>
              +elm</button>
            <button onClick={() => onAddChild(node.id, 'attribute')}
              style={{ padding: '1px 4px', fontSize: 9, borderRadius: 3, cursor: 'pointer', background: 'color-mix(in srgb, #4a9eff 10%, #1a2030)', color: '#4a9eff', border: '0.5px solid #4a9eff40' }}>
              @att</button>
            <button onClick={() => onAddChild(node.id, 'cdata')}
              style={{ padding: '1px 4px', fontSize: 9, borderRadius: 3, cursor: 'pointer', background: 'color-mix(in srgb, #a78bfa 10%, #1a2030)', color: '#a78bfa', border: '0.5px solid #a78bfa40' }}>
              CDA</button>
            <button onClick={() => onAddChild(node.id, 'group')}
              style={{ padding: '1px 4px', fontSize: 9, borderRadius: 3, cursor: 'pointer', background: 'color-mix(in srgb, #ffb347 10%, #1a2030)', color: '#ffb347', border: '0.5px solid #ffb34740' }}>
              grp</button>
          </div>
        )}

        {/* Elimina */}
        <button onClick={() => onDelete(node.id)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, flexShrink: 0 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
          <i className="ti ti-x" style={{ fontSize: 10 }} />
        </button>
      </div>

      {/* Figli */}
      {node.children && node.children.length > 0 && (
        <div style={{ borderLeft: `1px dashed ${kindColor}30`, marginLeft: 8, paddingLeft: 4 }}>
          {node.children.map((child) => (
            <XmlNodeRow key={child.id} node={child} depth={depth + 1}
              fields={fields} onChange={onChange} onDelete={onDelete} onAddChild={onAddChild} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Panel principale ────────────────────────────────────────────
export function XmlSerializerPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const inFields   = useIncomingSchema(nodeId)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const structure: XmlOutputNode[] = useMemo(() => {
    try { return JSON.parse(p('xmlStructure', '[]')) }
    catch { return [] }
  }, [p('xmlStructure')])

  const saveStructure = (nodes: XmlOutputNode[]) =>
    updateProp(nodeId, 'xmlStructure', JSON.stringify(nodes))

  const updateInTree = (nodes: XmlOutputNode[], id: string, patch: Partial<XmlOutputNode>): XmlOutputNode[] =>
    nodes.map((n) => {
      if (n.id === id) return { ...n, ...patch }
      if (n.children) return { ...n, children: updateInTree(n.children, id, patch) }
      return n
    })

  const deleteFromTree = (nodes: XmlOutputNode[], id: string): XmlOutputNode[] =>
    nodes.filter((n) => n.id !== id).map((n) =>
      n.children ? { ...n, children: deleteFromTree(n.children, id) } : n
    )

  const addToParent = (nodes: XmlOutputNode[], parentId: string, kind: XmlNodeKind): XmlOutputNode[] =>
    nodes.map((n) => {
      if (n.id === parentId) {
        const child: XmlOutputNode = {
          id: `xn_${Date.now()}`, xmlName: '', sourceField: '', namespace: '',
          kind, transform: '', nullable: 'omit',
          children: (kind === 'element' || kind === 'group') ? [] : undefined,
        }
        return { ...n, children: [...(n.children ?? []), child] }
      }
      if (n.children) return { ...n, children: addToParent(n.children, parentId, kind) }
      return n
    })

  const handleChange   = (id: string, patch: Partial<XmlOutputNode>) => saveStructure(updateInTree(structure, id, patch))
  const handleDelete   = (id: string) => saveStructure(deleteFromTree(structure, id))
  const handleAddChild = (parentId: string, kind: XmlNodeKind) => saveStructure(addToParent(structure, parentId, kind))

  const addRoot = (kind: XmlNodeKind) => {
    const node: XmlOutputNode = {
      id: `xn_${Date.now()}`, xmlName: '', sourceField: '', namespace: '',
      kind, transform: '', nullable: 'omit',
      children: (kind === 'element' || kind === 'group') ? [] : undefined,
    }
    saveStructure([...structure, node])
  }

  const autoPopulate = () => {
    if (inFields.length === 0) return
    const nodes: XmlOutputNode[] = inFields.map((f) => ({
      id: `xn_${Date.now()}_${f.name}`, xmlName: f.name, sourceField: f.name,
      namespace: '', kind: 'element' as const, transform: '', nullable: 'omit' as const,
    }))
    saveStructure(nodes)
  }

  // Import XSD — estrae elementi semplici
  const handleXsdImport = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    if (!text.trim()) return
    try {
      const parser  = new DOMParser()
      const doc     = parser.parseFromString(text, 'application/xml')
      const elements = Array.from(doc.querySelectorAll('element[name]'))
      const nodes: XmlOutputNode[] = elements
        .filter((el) => el.getAttribute('type') && !el.querySelector('complexType'))
        .map((el) => {
          const name = el.getAttribute('name') ?? ''
          return {
            id: `xn_xsd_${Date.now()}_${name}`, xmlName: name, sourceField: name,
            namespace: '', kind: 'element' as const, transform: '', nullable: 'omit' as const,
          }
        })
      if (nodes.length > 0) saveStructure(nodes)
    } catch {}
  }

  // Anteprima XML
  const previewXml = useMemo(() => {
    const buildXml = (nodes: XmlOutputNode[], indent: number): string => {
      const pad = '  '.repeat(indent)
      return nodes.map((n) => {
        const ns  = n.namespace ? `${n.namespace}:` : ''
        const tag = `${ns}${n.xmlName || 'elemento'}`
        if (n.kind === 'attribute') return '' // attributi vanno nel tag padre
        if (n.kind === 'cdata') return `${pad}<${tag}><![CDATA[<${n.sourceField || tag}>]]></${tag}>`
        if (n.kind === 'group' || (n.children && n.children.length > 0)) {
          const attrs = (n.children ?? []).filter((c) => c.kind === 'attribute')
            .map((a) => ` ${a.namespace ? a.namespace + ':' : ''}${a.xmlName || 'attr'}="<${a.sourceField}>"`)
            .join('')
          const childElms = (n.children ?? []).filter((c) => c.kind !== 'attribute')
          return `${pad}<${tag}${attrs}>\n${buildXml(childElms, indent + 1)}\n${pad}</${tag}>`
        }
        return `${pad}<${tag}><${n.sourceField || tag}></${tag}>`
      }).filter(Boolean).join('\n')
    }
    return buildXml(structure, 0)
  }, [structure])

  const [showImport, setShowImport]   = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [importMode, setImportMode]   = useState<'xsd' | 'xml'>('xsd')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
        <span style={{ color: ACCENT, fontWeight: 600 }}>&lt;/&gt; XML Serializer</span> — converte righe del flusso in stringhe XML.
        Il risultato viene scritto nel campo <code style={{ color: ACCENT }}>{p('outputField', 'xml_output')}</code>.
      </div>

      {/* Elemento root */}
      <SectionTitle label="Elemento root" />
      <Row>
        <Field label="Nome elemento root" hint="Elemento radice che contiene ogni riga serializzata">
          <input style={{ ...inputStyle, color: ACCENT }} value={p('rootElement', 'record')}
            onChange={u('rootElement')} placeholder="record" />
        </Field>
        <Field label="Namespace root" hint="Namespace URI dell'elemento root (opzionale)">
          <input style={inputStyle} value={p('rootNamespace')} onChange={u('rootNamespace')}
            placeholder="http://esempio.com/schema" />
        </Field>
      </Row>
      <Row>
        <Field label="Prefisso namespace root">
          <input style={inputStyle} value={p('rootNsPrefix')} onChange={u('rootNsPrefix')} placeholder="ns" />
        </Field>
        <Field label="Campo output nel record">
          <input style={{ ...inputStyle, color: ACCENT }} value={p('outputField', 'xml_output')}
            onChange={u('outputField')} placeholder="xml_output" />
        </Field>
      </Row>

      {/* Opzioni serializzazione */}
      <SectionTitle label="Opzioni serializzazione" />
      <Row>
        <Field label="Pretty print">
          <CustomSelect style={inputStyle} value={p('pretty', 'false')} onChange={u('pretty')}>
            <option value="false">Compatto — una riga</option>
            <option value="true">Indentato — leggibile</option>
          </CustomSelect>
        </Field>
        <Field label="Dichiarazione XML">
          <CustomSelect style={inputStyle} value={p('xmlDeclaration', 'true')} onChange={u('xmlDeclaration')}>
            <option value="true">Includi — &lt;?xml version="1.0"?&gt;</option>
            <option value="false">Ometti</option>
          </CustomSelect>
        </Field>
      </Row>
      <Row>
        <Field label="Encoding dichiarazione">
          <CustomSelect style={inputStyle} value={p('encoding', 'UTF-8')} onChange={u('encoding')}>
            <option value="UTF-8">UTF-8</option>
            <option value="UTF-16">UTF-16</option>
            <option value="ISO-8859-1">ISO-8859-1</option>
          </CustomSelect>
        </Field>
        <Field label="Su errore serializzazione">
          <CustomSelect style={inputStyle} value={p('onError', 'reject')} onChange={u('onError')}>
            <option value="reject">Invia a output reject</option>
            <option value="empty">Elemento vuoto</option>
            <option value="skip">Salta la riga</option>
            <option value="stop">Interrompi pipeline</option>
          </CustomSelect>
        </Field>
      </Row>

      {/* Namespace aggiuntivi */}
      <Field label="Dichiarazioni namespace aggiuntive" hint="Una per riga: prefisso=http://uri">
        <textarea style={{ ...inputStyle, minHeight: 50, resize: 'vertical', fontFamily: 'monospace', fontSize: 10 }}
          value={p('namespaces')} onChange={u('namespaces')}
          placeholder={'xsi=http://www.w3.org/2001/XMLSchema-instance\nxsd=http://www.w3.org/2001/XMLSchema'}
          spellCheck={false} />
      </Field>

      {/* Struttura XML */}
      <SectionTitle label="Struttura XML output" />

      {/* Legenda */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        {[
          { label: '<elm> elemento', color: ACCENT },
          { label: '@att attributo', color: '#4a9eff' },
          { label: 'CDA CDATA',      color: '#a78bfa' },
          { label: '<grp> gruppo',   color: '#ffb347' },
        ].map((item) => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: item.color }} />
            <span style={{ fontSize: 9, color: item.color }}>{item.label}</span>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {[
          { label: '+ elemento', kind: 'element' as const,   color: ACCENT },
          { label: '+ @attributo', kind: 'attribute' as const, color: '#4a9eff' },
          { label: '+ CDATA',    kind: 'cdata' as const,    color: '#a78bfa' },
          { label: '+ gruppo',   kind: 'group' as const,    color: '#ffb347' },
        ].map((btn) => (
          <button key={btn.kind} onClick={() => addRoot(btn.kind)}
            style={{ padding: '4px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${btn.color} 12%, #1a2030)`, color: btn.color, border: `0.5px solid ${btn.color}40` }}>
            {btn.label}
          </button>
        ))}
        {inFields.length > 0 && (
          <button onClick={autoPopulate}
            style={{ padding: '4px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#4a5a7a', border: '0.5px solid #2a3349', marginLeft: 'auto' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = ACCENT }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
            <i className="ti ti-wand" style={{ fontSize: 10, marginRight: 4 }} />Auto da schema
          </button>
        )}
        <button onClick={() => setShowImport((v) => !v)}
          style={{ padding: '4px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#4a5a7a', border: '0.5px solid #2a3349' }}>
          <i className="ti ti-upload" style={{ fontSize: 10, marginRight: 4 }} />Import XSD
        </button>
        <button onClick={() => setShowPreview((v) => !v)}
          style={{ padding: '4px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#4a5a7a', border: '0.5px solid #2a3349' }}>
          <i className="ti ti-eye" style={{ fontSize: 10, marginRight: 4 }} />Anteprima
        </button>
      </div>

      {/* Import */}
      {showImport && (
        <div style={{ padding: '8px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}30` }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            {['xsd', 'xml'].map((mode) => (
              <button key={mode} onClick={() => setImportMode(mode as any)}
                style={{ padding: '2px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: importMode === mode ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030', color: importMode === mode ? ACCENT : '#4a5a7a', border: importMode === mode ? `1px solid ${ACCENT}50` : '1px solid #2a3349' }}>
                {mode.toUpperCase()}
              </button>
            ))}
            <span style={{ fontSize: 9, color: '#4a5a7a', alignSelf: 'center', marginLeft: 4 }}>
              {importMode === 'xsd' ? 'Incolla un XSD — gli elementi semplici vengono importati come mapping' : 'Incolla XML di esempio — la struttura viene importata come template'}
            </span>
          </div>
          <textarea
            style={{ ...inputStyle, minHeight: 120, resize: 'vertical', fontFamily: 'monospace', fontSize: 10 }}
            placeholder={importMode === 'xsd'
              ? '<xs:schema>\n  <xs:element name="id" type="xs:integer"/>\n  <xs:element name="nome" type="xs:string"/>\n</xs:schema>'
              : '<record>\n  <id>1</id>\n  <nome>Mario</nome>\n</record>'}
            onChange={importMode === 'xsd' ? handleXsdImport : undefined}
            spellCheck={false} />
        </div>
      )}

      {/* Anteprima */}
      {showPreview && previewXml && (
        <div style={{ padding: '8px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}30` }}>
          <div style={{ fontSize: 9, color: '#4a5a7a', marginBottom: 4 }}>Anteprima struttura XML (valori come segnaposto)</div>
          <pre style={{ margin: 0, fontSize: 10, color: '#3ddc84', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {p('xmlDeclaration', 'true') === 'true' ? `<?xml version="1.0" encoding="${p('encoding', 'UTF-8')}"?>\n` : ''}
            {`<${p('rootNsPrefix') ? p('rootNsPrefix') + ':' : ''}${p('rootElement', 'record')}>\n${previewXml}\n</${p('rootNsPrefix') ? p('rootNsPrefix') + ':' : ''}${p('rootElement', 'record')}>`}
          </pre>
        </div>
      )}

      {/* Struttura */}
      {structure.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-code" style={{ fontSize: 24, display: 'block', marginBottom: 8, color: `${ACCENT}40` }} />
          Aggiungi elementi o importa un XSD per definire la struttura XML output.
        </div>
      ) : (
        <div style={{ background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', padding: '8px' }}>
          {structure.map((node) => (
            <XmlNodeRow key={node.id} node={node} depth={0}
              fields={inFields} onChange={handleChange}
              onDelete={handleDelete} onAddChild={handleAddChild} />
          ))}
        </div>
      )}

      {/* Validazione XSD output */}
      <SectionTitle label="Validazione output" color="#4a5a7a" />
      <Field label="Valida output contro XSD" hint="Opzionale — rallenta la pipeline, utile in sviluppo">
        <CustomSelect style={inputStyle} value={p('validateOutput', 'false')} onChange={u('validateOutput')}>
          <option value="false">No — salta validazione</option>
          <option value="true">Sì — valida ogni riga XML prodotta</option>
        </CustomSelect>
      </Field>

      {/* Output nodo */}
      <SectionTitle label="Output del nodo" color="#4a5a7a" />
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a', lineHeight: 1.8 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 9, padding: '1px 8px', borderRadius: 8, background: '#0d3d20', color: '#3ddc84', border: '0.5px solid #1d6d40' }}>output</span>
          <span style={{ fontSize: 9, color: '#4a5a7a' }}>Righe originali + campo <code style={{ color: ACCENT }}>{p('outputField', 'xml_output')}</code> con XML serializzato</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <span style={{ fontSize: 9, padding: '1px 8px', borderRadius: 8, background: '#1a0000', color: '#ff5f57', border: '0.5px solid #3d1010' }}>reject</span>
          <span style={{ fontSize: 9, color: '#4a5a7a' }}>Righe non serializzabili + campo <code style={{ color: '#ff5f57' }}>_xml_error</code></span>
        </div>
      </div>
    </div>
  )
}
