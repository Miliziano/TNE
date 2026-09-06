import { useState } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { ScriptEditor } from '../../../components/ScriptEditor'
import { DB_DIALECT_COLORS, DB_DIALECT_LABELS, type DbDialect } from '../../../nodes/resourceDefaults'
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

function Field({ label, children, hint }: {
  label: string; children: React.ReactNode; hint?: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#8593b5', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}

function SectionTitle({ label, color = '#4a9eff' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: '0.5px solid #2a3349', marginBottom: 4 }}>
      {label}
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

// ─── Snippet SQL per dialetto ─────────────────────────────────────
const SQL_SNIPPETS: Record<string, Array<{ label: string; code: string }>> = {
  postgresql: [
    { label: 'Basic SELECT',        code: 'SELECT *\nFROM public.my_table\nWHERE 1=1\nLIMIT 1000;' },
    { label: 'JOIN',               code: 'SELECT a.*, b.name\nFROM public.my_table a\nJOIN public.other_table b ON a.id = b.ref_id\nWHERE a.active = true;' },
    { label: 'JSONB extract field', code: "SELECT id,\n  data->>'name' AS name,\n  data->>'email' AS email\nFROM public.my_table\nWHERE data IS NOT NULL;" },
    { label: 'JSONB filter @>',    code: "SELECT *\nFROM public.my_table\nWHERE data @> '{\"status\": \"active\"}'::jsonb;" },
    { label: 'JSONB array rows',   code: "SELECT id, elem\nFROM public.my_table,\njsonb_array_elements(data->'items') AS elem;" },
    { label: 'Window function',    code: 'SELECT *,\n  ROW_NUMBER() OVER (PARTITION BY category ORDER BY created_at DESC) AS rn\nFROM public.my_table;' },
    { label: 'CTE',                code: 'WITH filtered AS (\n  SELECT * FROM public.my_table WHERE active = true\n)\nSELECT * FROM filtered\nORDER BY id;' },
    { label: 'Recent date',       code: "SELECT *\nFROM public.my_table\nWHERE created_at >= NOW() - INTERVAL '7 days';" },
    { label: 'Aggregation',       code: 'SELECT category,\n  COUNT(*) AS total,\n  SUM(amount) AS total_sum\nFROM public.my_table\nGROUP BY category\nORDER BY total DESC;' },
  ],
  mysql: [
    { label: 'Basic SELECT',   code: 'SELECT *\nFROM `database`.`my_table`\nWHERE 1=1\nLIMIT 1000;' },
    { label: 'JOIN',          code: 'SELECT a.*, b.name\nFROM `my_table` a\nJOIN `other_table` b ON a.id = b.ref_id;' },
    { label: 'JSON extract',   code: "SELECT id,\n  JSON_EXTRACT(data, '$.name') AS name\nFROM `my_table`\nWHERE JSON_VALID(data);" },
    { label: 'Recent date',  code: "SELECT *\nFROM `my_table`\nWHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY);" },
    { label: 'GROUP BY',      code: 'SELECT category,\n  COUNT(*) AS total\nFROM `my_table`\nGROUP BY category\nORDER BY total DESC;' },
  ],
  sqlite: [
    { label: 'Basic SELECT',   code: 'SELECT *\nFROM my_table\nWHERE 1=1\nLIMIT 1000;' },
    { label: 'JOIN',          code: 'SELECT a.*, b.name\nFROM my_table a\nJOIN other_table b ON a.id = b.ref_id;' },
    { label: 'JSON extract',   code: "SELECT id,\n  json_extract(data, '$.name') AS name\nFROM my_table;" },
    { label: 'Recent date',  code: "SELECT *\nFROM my_table\nWHERE created_at >= datetime('now', '-7 days');" },
  ],
  oracle: [
    { label: 'Basic SELECT',   code: 'SELECT *\nFROM schema.my_table\nWHERE ROWNUM <= 1000;' },
    { label: 'JOIN',          code: 'SELECT a.*, b.name\nFROM schema.my_table a\nJOIN schema.other_table b ON a.id = b.ref_id;' },
    { label: 'JSON extract',   code: "SELECT id,\n  JSON_VALUE(data, '$.name') AS name\nFROM schema.my_table;" },
    { label: 'Recent date',  code: 'SELECT *\nFROM schema.my_table\nWHERE created_at >= SYSDATE - 7;' },
    { label: 'CONNECT BY',    code: 'SELECT LEVEL, id, parent_id, name\nFROM schema.my_table\nSTART WITH parent_id IS NULL\nCONNECT BY PRIOR id = parent_id;' },
  ],
  informix: [
    { label: 'Basic SELECT',      code: 'SELECT FIRST 1000 *\nFROM my_table\nWHERE 1=1;' },
    { label: 'JOIN',             code: 'SELECT a.*, b.name\nFROM my_table a\nJOIN other_table b ON a.id = b.ref_id;' },
    { label: 'Recent date',     code: 'SELECT *\nFROM my_table\nWHERE created_at >= TODAY - 7;' },
  ],
}

// ─── Operatori JSONB ──────────────────────────────────────────────
const JSONB_SNIPPETS = [
  { label: "->>'field'",             code: "data->>'field'"                                   },
  { label: "->'object'",            code: "data->'object'->>'field'"                        },
  { label: "@> filter",              code: "data @> '{\"key\": \"value\"}'::jsonb"         },
  { label: "? contains key",      code: "data ? 'key'"                                  },
  { label: "jsonb_array_elements",   code: "jsonb_array_elements(data->'array')"              },
  { label: "jsonb_array_length",     code: "jsonb_array_length(data->'array')"                },
  { label: "jsonb_build_object",     code: "jsonb_build_object('key', val, 'key2', val2)"     },
  { label: "jsonb_agg",              code: "jsonb_agg(rec ORDER BY id)"                      },
  { label: "::numeric cast",         code: "(data->>'number')::numeric"                       },
  { label: "::date cast",            code: "(data->>'date')::date"                            },
  { label: "|| merge",               code: "data || '{\"new\": \"value\"}'::jsonb"         },
  { label: "#- remove key",      code: "data #- '{key}'"                               },
]

export function SourceDbQueryPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)

  const [showJsonb,  setShowJsonb]  = useState(false)
  const [sqlSnippet, setSqlSnippet] = useState<string | undefined>(undefined)

  if (!node) return null

  const p        = (key: string, def = '') => node.data.props[key] ?? def
  const u        = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  const dialect    = p('dialect', 'postgresql') as DbDialect
  const isSqlite   = dialect === 'sqlite'
  const isPostgres = dialect === 'postgresql'
  const color      = DB_DIALECT_COLORS[dialect] ?? '#4a9eff'
  const label      = DB_DIALECT_LABELS[dialect] ?? 'DB'
  const snippets   = SQL_SNIPPETS[dialect] ?? SQL_SNIPPETS.postgresql

  const defaultQuery = isSqlite
    ? 'SELECT *\nFROM my_table\nWHERE 1=1\nLIMIT 1000;'
    : 'SELECT *\nFROM public.my_table\nWHERE 1=1\nLIMIT 1000;'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* ── Sorgente data ────────────────────────────────────── */}
      <SectionTitle label="Data source" color={color} />

      <Row>
        {!isSqlite && (
          <Field label="Schema">
            <input type="text" style={inputStyle} value={p('querySchema', 'public')} onChange={u('querySchema')} placeholder="public" />
          </Field>
        )}
        <Field label="Table" hint="Used if there is no custom query">
          <input type="text" style={inputStyle} value={p('table')} onChange={u('table')} placeholder="table_name" />
        </Field>
      </Row>

      {/* ── Query SQL ────────────────────────────────────────── */}
      <SectionTitle label={`SQL Query — ${label}`} color={color} />

      {/* Toolbar snippet + JSONB */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <CustomSelect
          style={{ ...inputStyle, width: 'auto', fontSize: 10, padding: '2px 6px', color }}
          value="" onChange={(e) => { if (e.target.value) { setSqlSnippet(e.target.value); e.target.value = '' } }}>
          <option value="">⚡ snippet {label}</option>
          {snippets.map((s) => (
            <option key={s.label} value={s.code}>{s.label}</option>
          ))}
        </CustomSelect>

        {isPostgres && (
          <button onClick={() => setShowJsonb((v) => !v)}
            style={{ padding: '2px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: showJsonb ? '#1a1030' : '#1e2535', color: showJsonb ? '#a78bfa' : '#8593b5', border: showJsonb ? '1px solid #a78bfa' : '1px solid #2a3349', display: 'flex', alignItems: 'center', gap: 4 }}>
            <i className="ti ti-braces" style={{ fontSize: 10 }} /> JSONB
          </button>
        )}

        <button onClick={() => updateProp(nodeId, 'query', '')}
          style={{ background: 'none', border: '0.5px solid #2a3349', borderRadius: 4, padding: '2px 8px', fontSize: 10, cursor: 'pointer', color: '#8593b5' }}
          title="Clear query">
          <i className="ti ti-eraser" style={{ fontSize: 10 }} />
        </button>

        <span style={{ marginLeft: 'auto', fontSize: 9, color: '#2a3349' }}>
          Ctrl+Shift+F format · Alt+T suggestions
        </span>
      </div>

      {/* Panel JSONB */}
      {isPostgres && showJsonb && (
        <div style={{ background: '#1a1030', border: '1px solid #3a1a6a', borderRadius: 6, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 9, color: '#a78bfa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>
            PostgreSQL JSONB operators — click to insert
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {JSONB_SNIPPETS.map((s) => (
              <button key={s.label} onClick={() => setSqlSnippet(s.code)}
                style={{ padding: '2px 8px', borderRadius: 10, fontSize: 9, background: '#0f0820', border: '1px solid #3a1a6a', color: '#a78bfa', cursor: 'pointer', fontFamily: 'monospace', flexShrink: 0 }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a1040' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#0f0820' }}>
                {s.label}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 9, color: '#8593b5', fontStyle: 'italic' }}>
            JSONB fields → type <code style={{ color: '#a78bfa' }}>object</code> in the schema · use JSON Parser to unpack them
          </div>
        </div>
      )}

      {/* Editor Monaco SQL */}
      <ScriptEditor
        value={p('query', defaultQuery)}
        onChange={(v) => updateProp(nodeId, 'query', v)}
        language="sql"
        height={220}
        snippetToInsert={sqlSnippet}
        onSnippetInserted={() => setSqlSnippet(undefined)}
      />

      {/* ── Opzioni lettura ──────────────────────────────────── */}
      <SectionTitle label="Read options" color={color} />

      <Row>
        <Field label="Row limit" hint="0 = no limit">
          <input type="number" style={inputStyle} value={p('limit', '0')} onChange={u('limit')} min="0" />
        </Field>
        <Field label="Offset">
          <input type="number" style={inputStyle} value={p('offset', '0')} onChange={u('offset')} min="0" />
        </Field>
      </Row>
      <Row>
        <Field label="Fetch size (batch)">
          <input type="number" style={inputStyle} value={p('fetchSize', '1000')} onChange={u('fetchSize')} />
        </Field>
        <Field label="Query timeout (s)">
          <input type="number" style={inputStyle} value={p('queryTimeout', '30')} onChange={u('queryTimeout')} />
        </Field>
      </Row>
      <Field label="Order (ORDER BY)">
        <input type="text" style={inputStyle} value={p('orderBy')} onChange={u('orderBy')} placeholder="id ASC, created_at DESC" />
      </Field>

    </div>
  )
}
