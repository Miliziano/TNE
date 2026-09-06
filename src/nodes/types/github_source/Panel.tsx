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
      {hint && <div style={{ fontSize: 10, color: '#8593b5', fontStyle: 'italic' }}>{hint}</div>}
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
            <div style={{ fontSize: 9, color: '#8593b5' }}>{resource.config?.baseUrl || 'https://api.github.com'}</div>
          </div>
        </div>
      ) : (
        <div style={{ padding: '8px 12px', background: '#2a1a0a', borderRadius: 6, border: '0.5px solid #855', fontSize: 10, color: '#c8a060' }}>
          No GitHub resource connected. Add it from the resource strip and use the «source» action.
        </div>
      )}

      <Field label="Mode" hint={perRow ? 'owner/repo taken from the incoming rows (fan-out)' : 'owner/repo from the configuration (fixed target)'}>
        <CustomSelect style={inputStyle} value={mode} onChange={u('mode')}>
          <option value="config">From configuration</option>
          <option value="per_row">Per-row (from the incoming list)</option>
        </CustomSelect>
      </Field>

      <Field label="Entity" hint="what to fetch from GitHub">
        <CustomSelect style={inputStyle} value={entity} onChange={u('entity')}>
          <option value="repos">Repos (of an org or user)</option>
          <option value="issues">Issues + Pull Requests (of a repo)</option>
          <option value="commits">Commits (of a repo)</option>
        </CustomSelect>
      </Field>

      {entity === 'repos' && (
        <Field label="Owner type">
          <CustomSelect style={inputStyle} value={p('ownerType', 'org')} onChange={u('ownerType')}>
            <option value="org">Organization</option>
            <option value="user">User</option>
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
          <Field label="Owner" hint="name of the org or user">
            <input style={inputStyle} value={p('owner')} onChange={u('owner')} placeholder="Miliziano" />
          </Field>
        )
      ) : (
        // Modalità per-riga: quali campi della riga contengono owner/repo
        needsRepo ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Owner field" hint="column with the owner"><input style={inputStyle} value={p('ownerField', 'owner')} onChange={u('ownerField')} placeholder="owner" /></Field>
            <Field label="Repo field" hint="column with the repo"><input style={inputStyle} value={p('repoField', 'repo')} onChange={u('repoField')} placeholder="repo" /></Field>
          </div>
        ) : (
          <Field label="Owner field" hint="row column with the org/user">
            <input style={inputStyle} value={p('ownerField', 'owner')} onChange={u('ownerField')} placeholder="owner" />
          </Field>
        )
      )}

      {entity === 'issues' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="State">
            <CustomSelect style={inputStyle} value={p('state', 'open')} onChange={u('state')}>
              <option value="open">open</option>
              <option value="closed">closed</option>
              <option value="all">all</option>
            </CustomSelect>
          </Field>
          <Field label="Pull Requests" hint="issues include PRs">
            <CustomSelect style={inputStyle} value={p('includePRs', 'false')} onChange={u('includePRs')}>
              <option value="false">Exclude PRs</option>
              <option value="true">Include PRs</option>
            </CustomSelect>
          </Field>
        </div>
      )}

      {entity === 'commits' && (
        <Field label="Branch (opt.)" hint="empty = repo default branch">
          <input style={inputStyle} value={p('branch')} onChange={u('branch')} placeholder="main" />
        </Field>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label="Elementi per pagina" hint={`resource default: ${resource?.config?.perPage ?? '100'}`}>
          <input style={inputStyle} type="number" value={p('perPage', resource?.config?.perPage ?? '100')} onChange={u('perPage')} />
        </Field>
        <Field label="Max items (opt.)" hint={perRow ? '0/empty = all, per repo' : '0/empty = all pages'}>
          <input style={inputStyle} type="number" value={p('maxItems', '')} onChange={u('maxItems')} placeholder="0" />
        </Field>
      </div>
    </div>
  )
}
