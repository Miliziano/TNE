/**
 * src/nodes/types/github_source/Panel.tsx
 *
 * Sorgente GitHub (lettura) — UN nodo, tre entità (repos / issues / commits) e
 * DUE modalità:
 *   • config   → owner/repo dalla configurazione (un target fisso);
 *   • per-riga → owner/repo dai CAMPI della riga in ingresso (fan-out da una
 *                lista, es. source_file → github_source). In per-riga ogni riga
 *                emessa porta anche `_repo` (owner/repo di provenienza), utile
 *                per aggregare a valle.
 * Connessione (token, baseUrl) dalla risorsa `kind:'github'` collegata.
 * Lo `outputSchema` è scritto per entità (via useEffect, anche al mount).
 */
import { useEffect } from 'react'
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
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}

const ACCENT = '#4a9eff'

type Col = { id: string; name: string; type: string }

const SCHEMAS: Record<string, Col[]> = {
  repos: [
    { id: 'full_name', name: 'full_name', type: 'string' },
    { id: 'name', name: 'name', type: 'string' },
    { id: 'owner_login', name: 'owner_login', type: 'string' },
    { id: 'description', name: 'description', type: 'string' },
    { id: 'private', name: 'private', type: 'boolean' },
    { id: 'fork', name: 'fork', type: 'boolean' },
    { id: 'language', name: 'language', type: 'string' },
    { id: 'stargazers_count', name: 'stargazers_count', type: 'integer' },
    { id: 'forks_count', name: 'forks_count', type: 'integer' },
    { id: 'open_issues_count', name: 'open_issues_count', type: 'integer' },
    { id: 'default_branch', name: 'default_branch', type: 'string' },
    { id: 'topics', name: 'topics', type: 'array' },
    { id: 'html_url', name: 'html_url', type: 'string' },
    { id: 'created_at', name: 'created_at', type: 'string' },
    { id: 'updated_at', name: 'updated_at', type: 'string' },
    { id: 'pushed_at', name: 'pushed_at', type: 'string' },
  ],
  issues: [
    { id: 'number', name: 'number', type: 'integer' },
    { id: 'title', name: 'title', type: 'string' },
    { id: 'state', name: 'state', type: 'string' },
    { id: 'user_login', name: 'user_login', type: 'string' },
    { id: 'labels', name: 'labels', type: 'array' },
    { id: 'assignees', name: 'assignees', type: 'array' },
    { id: 'comments', name: 'comments', type: 'integer' },
    { id: 'is_pull_request', name: 'is_pull_request', type: 'boolean' },
    { id: 'html_url', name: 'html_url', type: 'string' },
    { id: 'created_at', name: 'created_at', type: 'string' },
    { id: 'updated_at', name: 'updated_at', type: 'string' },
    { id: 'closed_at', name: 'closed_at', type: 'string' },
    { id: 'body', name: 'body', type: 'string' },
  ],
  commits: [
    { id: 'sha', name: 'sha', type: 'string' },
    { id: 'message', name: 'message', type: 'string' },
    { id: 'author_name', name: 'author_name', type: 'string' },
    { id: 'author_email', name: 'author_email', type: 'string' },
    { id: 'author_date', name: 'author_date', type: 'string' },
    { id: 'committer_name', name: 'committer_name', type: 'string' },
    { id: 'committer_date', name: 'committer_date', type: 'string' },
    { id: 'html_url', name: 'html_url', type: 'string' },
  ],
}

function schemaFor(entity: string, mode: string): string {
  const cols = [...(SCHEMAS[entity] ?? SCHEMAS.repos)]
  if (mode === 'per_row') cols.push({ id: '_repo', name: '_repo', type: 'string' })
  return JSON.stringify(cols)
}

export function GithubSourcePanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const pool       = useFlowStore((s) => s.pool)

  const entity = node?.data.props.entity ?? 'repos'
  const mode   = node?.data.props.mode ?? 'config'

  useEffect(() => {
    if (!node) return
    const want = schemaFor(entity, mode)
    if ((node.data.props.outputSchema ?? '') !== want) {
      updateProp(nodeId, 'outputSchema', want)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity, mode, nodeId])

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  const laneId     = node.data.laneId
  const resourceId = node.data.config?.resourceId ?? ''
  const lane       = pool.lanes.find((l) => l.id === laneId)
  const resource   = (lane?.resources ?? []).filter((r) => r.kind === 'github').find((r) => r.id === resourceId)

  const perRow    = mode === 'per_row'
  const needsRepo = entity === 'issues' || entity === 'commits'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {resource ? (
        <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', display: 'flex', gap: 8, alignItems: 'center' }}>
          <i className="ti ti-brand-github" style={{ fontSize: 14, color: ACCENT }} />
          <div>
            <div style={{ fontWeight: 600, color: ACCENT }}>{resource.label}</div>
            <div style={{ fontSize: 9, color: '#4a5a7a' }}>{resource.config?.baseUrl || 'https://api.github.com'}</div>
          </div>
        </div>
      ) : (
        <div style={{ padding: '8px 12px', background: '#2a1a0a', borderRadius: 6, border: '0.5px solid #855', fontSize: 10, color: '#c8a060' }}>
          Nessuna risorsa GitHub collegata. Aggiungila dalla strip risorse e usa l'azione «source».
        </div>
      )}

      <Field label="Modalità" hint={perRow ? 'owner/repo presi dalle righe in ingresso (fan-out)' : 'owner/repo dalla configurazione (target fisso)'}>
        <CustomSelect style={inputStyle} value={mode} onChange={u('mode')}>
          <option value="config">Da configurazione</option>
          <option value="per_row">Per-riga (dalla lista in ingresso)</option>
        </CustomSelect>
      </Field>

      <Field label="Entità" hint="cosa prelevare da GitHub">
        <CustomSelect style={inputStyle} value={entity} onChange={u('entity')}>
          <option value="repos">Repos (di un'org o utente)</option>
          <option value="issues">Issue + Pull Request (di un repo)</option>
          <option value="commits">Commit (di un repo)</option>
        </CustomSelect>
      </Field>

      {entity === 'repos' && (
        <Field label="Tipo owner">
          <CustomSelect style={inputStyle} value={p('ownerType', 'org')} onChange={u('ownerType')}>
            <option value="org">Organizzazione</option>
            <option value="user">Utente</option>
          </CustomSelect>
        </Field>
      )}

      {!perRow ? (
        // Modalità config: owner/repo statici
        needsRepo ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Owner"><input style={inputStyle} value={p('owner')} onChange={u('owner')} placeholder="Miliziano" /></Field>
            <Field label="Repo"><input style={inputStyle} value={p('repo')} onChange={u('repo')} placeholder="TNE" /></Field>
          </div>
        ) : (
          <Field label="Owner" hint="nome dell'org o dell'utente">
            <input style={inputStyle} value={p('owner')} onChange={u('owner')} placeholder="Miliziano" />
          </Field>
        )
      ) : (
        // Modalità per-riga: quali campi della riga contengono owner/repo
        needsRepo ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Campo owner" hint="colonna con l'owner"><input style={inputStyle} value={p('ownerField', 'owner')} onChange={u('ownerField')} placeholder="owner" /></Field>
            <Field label="Campo repo" hint="colonna con il repo"><input style={inputStyle} value={p('repoField', 'repo')} onChange={u('repoField')} placeholder="repo" /></Field>
          </div>
        ) : (
          <Field label="Campo owner" hint="colonna della riga con l'org/utente">
            <input style={inputStyle} value={p('ownerField', 'owner')} onChange={u('ownerField')} placeholder="owner" />
          </Field>
        )
      )}

      {entity === 'issues' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Stato">
            <CustomSelect style={inputStyle} value={p('state', 'open')} onChange={u('state')}>
              <option value="open">open</option>
              <option value="closed">closed</option>
              <option value="all">all</option>
            </CustomSelect>
          </Field>
          <Field label="Pull Request" hint="le issue includono i PR">
            <CustomSelect style={inputStyle} value={p('includePRs', 'false')} onChange={u('includePRs')}>
              <option value="false">Escludi i PR</option>
              <option value="true">Includi i PR</option>
            </CustomSelect>
          </Field>
        </div>
      )}

      {entity === 'commits' && (
        <Field label="Branch (opz.)" hint="vuoto = branch di default del repo">
          <input style={inputStyle} value={p('branch')} onChange={u('branch')} placeholder="main" />
        </Field>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label="Elementi per pagina" hint={`default risorsa: ${resource?.config?.perPage ?? '100'}`}>
          <input style={inputStyle} type="number" value={p('perPage', resource?.config?.perPage ?? '100')} onChange={u('perPage')} />
        </Field>
        <Field label="Max elementi (opz.)" hint={perRow ? '0/vuoto = tutti, per repo' : '0/vuoto = tutte le pagine'}>
          <input style={inputStyle} type="number" value={p('maxItems', '')} onChange={u('maxItems')} placeholder="0" />
        </Field>
      </div>
    </div>
  )
}
