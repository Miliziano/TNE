/**
 * src/nodes/types/ldap_auth/Panel.tsx
 *
 * Autenticatore LDAP — per ogni riga in ingresso verifica le credenziali contro
 * la directory con **search-then-bind**: bind come account di servizio (dalla
 * risorsa) → cerca l'utente per l'attributo di login → secondo bind con la
 * password dell'utente. Le righe autenticate escono da «output», quelle fallite
 * dalla porta «reject» (per instradare, es., un 401 via webhook_responder).
 *
 * La password dell'utente arriva TRANSITORIA nella riga (campo `passwordField`)
 * e non viene mai salvata né loggata. La connessione/servizio è nella risorsa.
 *
 * NB: il MOTORE non esegue ancora questo nodo (fetta 3b). Fino ad allora lo
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

const ACCENT = '#ffb347'

export function LdapAuthPanel({ nodeId }: { nodeId: string }) {
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {resource ? (
        <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', display: 'flex', gap: 8, alignItems: 'center' }}>
          <i className="ti ti-shield-lock" style={{ fontSize: 14, color: ACCENT }} />
          <div>
            <div style={{ fontWeight: 600, color: ACCENT }}>{resource.label}</div>
            <div style={{ fontSize: 9, color: '#8593b5' }}>
              {(resource.config?.tlsMode ?? 'ldaps').toUpperCase()} · {resource.config?.host ?? '—'}:{resource.config?.port ?? '636'}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ padding: '8px 12px', background: '#2a1a0a', borderRadius: 6, border: '0.5px solid #855', fontSize: 10, color: '#c8a060' }}>
          Nessuna risorsa LDAP collegata. Aggiungi una risorsa LDAP dalla strip risorse e usa l'azione «auth».
        </div>
      )}

      <Field label="Campo utente (nella riga)" hint="da quale campo prendere lo username">
        <input style={inputStyle} value={p('usernameField', 'username')} onChange={u('usernameField')} placeholder="username" />
      </Field>

      <Field label="Campo password (nella riga)" hint="transitorio: usato per il bind, mai salvato né loggato">
        <input style={inputStyle} value={p('passwordField', 'password')} onChange={u('passwordField')} placeholder="password" />
      </Field>

      <Field label="Attributo di login" hint="l'attributo LDAP confrontato con lo username">
        <CustomSelect style={inputStyle} value={p('loginAttribute', 'uid')} onChange={u('loginAttribute')}>
          <option value="uid">uid</option>
          <option value="sAMAccountName">sAMAccountName (AD)</option>
          <option value="mail">mail</option>
          <option value="userPrincipalName">userPrincipalName (AD)</option>
          <option value="cn">cn</option>
        </CustomSelect>
      </Field>

      <Field label="Base DN" hint={baseDnDefault ? `default risorsa: ${baseDnDefault}` : 'dove cercare gli utenti'}>
        <input style={inputStyle} value={p('baseDN', baseDnDefault)} onChange={u('baseDN')} placeholder={baseDnDefault || 'ou=people,dc=example,dc=org'} />
      </Field>

      <Field label="Filtro aggiuntivo (opz.)" hint="ANDato al match di login, es. (objectClass=person)">
        <input style={inputStyle} value={p('userFilter', '')} onChange={u('userFilter')} placeholder="(objectClass=person)" />
      </Field>

      <Field label="Attributi da restituire (opz.)" hint="es. memberOf,displayName — aggiunti alle righe autenticate">
        <input style={inputStyle} value={p('returnAttributes', '')} onChange={u('returnAttributes')} placeholder="memberOf,displayName" />
      </Field>

      <Field label="Gruppo richiesto (opz.)" hint="autentica E dev'essere membro di questo gruppo (DN)">
        <input style={inputStyle} value={p('requireGroup', '')} onChange={u('requireGroup')} placeholder="cn=admins,ou=groups,dc=example,dc=org" />
      </Field>
    </div>
  )
}
