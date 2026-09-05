/**
 * src/nodes/types/ldap_source/Panel.tsx
 *
 * Sorgente LDAP — interroga una directory (risorsa `kind:'ldap'`) e produce
 * una riga per voce. La connessione + l'account di servizio vengono dalla
 * risorsa collegata (config.resourceId, impostato dall'azione "query" della
 * strip risorse). Lo schema d'uscita (`dn` + attributi richiesti) è scritto in
 * `props.outputSchema` così il valle vede le colonne, come le altre sorgenti.
 *
 * NB: il MOTORE non esegue ancora questo nodo (fetta 2b). Fino ad allora lo
 * studio avvisa via MOTORE_NON_IMPLEMENTA.
 */
import { useFlowStore } from '../../../store/flowStore'
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

const ACCENT = '#4a9eff'

/** Schema d'uscita = `dn` + attributi richiesti, come JSON per props.outputSchema. */
function buildSchema(attributes: string): string {
  const attrs = attributes.split(',').map((a) => a.trim()).filter(Boolean)
  const fields = [
    { id: 'dn', name: 'dn', type: 'string' },
    ...attrs.map((a) => ({ id: a, name: a, type: 'string' })),
  ]
  return JSON.stringify(fields)
}

export function LdapSourcePanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const pool       = useFlowStore((s) => s.pool)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  const laneId     = node.data.laneId
  const resourceId = node.data.config?.resourceId ?? ''
  const lane       = pool.lanes.find((l) => l.id === laneId)
  const resources  = (lane?.resources ?? []).filter((r) => r.kind === 'ldap')
  const resource   = resources.find((r) => r.id === resourceId)

  const baseDnDefault = resource?.config?.baseDN ?? ''
  const pageDefault   = resource?.config?.pageSize ?? '500'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Info risorsa */}
      {resource ? (
        <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', display: 'flex', gap: 8, alignItems: 'center' }}>
          <i className="ti ti-server" style={{ fontSize: 14, color: ACCENT }} />
          <div>
            <div style={{ fontWeight: 600, color: ACCENT }}>{resource.label}</div>
            <div style={{ fontSize: 9, color: '#8593b5' }}>
              {(resource.config?.tlsMode ?? 'ldaps').toUpperCase()} · {resource.config?.host ?? '—'}:{resource.config?.port ?? '636'}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ padding: '8px 12px', background: '#2a1a0a', borderRadius: 6, border: '0.5px solid #855', fontSize: 10, color: '#c8a060' }}>
          Nessuna risorsa LDAP collegata. Aggiungi una risorsa LDAP dalla strip risorse e usa l'azione «query».
        </div>
      )}

      <Field label="Base DN" hint={baseDnDefault ? `default risorsa: ${baseDnDefault}` : 'es. ou=people,dc=example,dc=org'}>
        <input style={inputStyle} value={p('baseDN', baseDnDefault)} onChange={u('baseDN')} placeholder={baseDnDefault || 'ou=people,dc=example,dc=org'} />
      </Field>

      <Field label="Scope">
        <CustomSelect style={inputStyle} value={p('scope', 'subtree')} onChange={u('scope')}>
          <option value="base">base (solo la voce base)</option>
          <option value="one">one (un livello sotto)</option>
          <option value="subtree">subtree (tutto il sottoalbero)</option>
        </CustomSelect>
      </Field>

      <Field label="Filtro LDAP" hint="es. (&(objectClass=person)(mail=*))">
        <input style={inputStyle} value={p('filter', '(objectClass=*)')} onChange={u('filter')} placeholder="(objectClass=*)" />
      </Field>

      <Field label="Attributi (separati da virgola)" hint="diventano le colonne d'uscita, oltre a dn">
        <input
          style={inputStyle}
          value={p('attributes', 'cn,mail')}
          onChange={(e) => {
            updateProp(nodeId, 'attributes', e.target.value)
            updateProp(nodeId, 'outputSchema', buildSchema(e.target.value))
          }}
          placeholder="cn,mail,memberOf"
        />
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label="Dimensione pagina" hint={`default: ${pageDefault}`}>
          <input style={inputStyle} type="number" value={p('pageSize', pageDefault)} onChange={u('pageSize')} />
        </Field>
        <Field label="Valori multipli" hint="attributi multi-valore">
          <CustomSelect style={inputStyle} value={p('multiValue', 'array')} onChange={u('multiValue')}>
            <option value="array">array JSON</option>
            <option value="join">unisci (;)</option>
            <option value="first">solo il primo</option>
          </CustomSelect>
        </Field>
      </div>
    </div>
  )
}
