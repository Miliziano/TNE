/**
 * src/runner/reportGeneratorExecutor.ts
 * ────────────────────────────────────────
 * Aggiunge:
 * - Conditional formatting per cella e per riga
 * - Integrazione automatica campo _dq (Data Quality)
 */

import type { Row, NodeExecutor, ExecutionContext } from '../io/types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'

// ─── Tipi ────────────────────────────────────────────────────────

interface CellRule {
  id:         string
  condition:  'lt' | 'gt' | 'lte' | 'gte' | 'eq' | 'neq' | 'contains' | 'is_null' | 'not_null' | 'custom'
  value:      string
  target:     'cell' | 'row'
  style:      'danger' | 'warning' | 'success' | 'info' | 'custom'
  bgColor?:   string
  textColor?: string
  icon?:      'arrow_up' | 'arrow_down' | 'warning' | 'check' | 'dot' | 'star' | ''
  expression?: string   // per condition === 'custom': row.campo > x
}

interface ColumnConfig {
  id:      string
  field:   string
  label:   string
  type:    'text' | 'number' | 'currency' | 'date'
  total?:  'sum' | 'avg' | 'count' | 'none'
  rules?:  CellRule[]
}

// ─── Preset stili ─────────────────────────────────────────────────
const STYLE_PRESETS: Record<string, { bg: string; text: string; border: string }> = {
  danger:  { bg: '#fff0f0', text: '#c0392b', border: '#e74c3c' },
  warning: { bg: '#fffbf0', text: '#d35400', border: '#f39c12' },
  success: { bg: '#f0fff4', text: '#1e8449', border: '#27ae60' },
  info:    { bg: '#f0f8ff', text: '#1a5276', border: '#2980b9' },
}

// Per tema dark
const STYLE_PRESETS_DARK: Record<string, { bg: string; text: string; border: string }> = {
  danger:  { bg: '#2a0a0a', text: '#ff6b6b', border: '#ff5f57' },
  warning: { bg: '#2a1a00', text: '#ffb347', border: '#f39c12' },
  success: { bg: '#0a2a15', text: '#3ddc84', border: '#27ae60' },
  info:    { bg: '#0a1a2a', text: '#4a9eff', border: '#2980b9' },
}

const ICONS: Record<string, string> = {
  arrow_up:   '↑',
  arrow_down: '↓',
  warning:    '⚠',
  check:      '✓',
  dot:        '●',
  star:       '★',
}

// ─── Valuta una regola su una riga ────────────────────────────────
function evalRule(row: Row, field: string, rule: CellRule): boolean {
  const raw = row[field]
  const str = String(raw ?? '').toLowerCase()
  const num = Number(raw)
  const rv  = rule.value?.toLowerCase() ?? ''
  const rvn = Number(rule.value)

  switch (rule.condition) {
    case 'lt':        return !isNaN(num) && num < rvn
    case 'gt':        return !isNaN(num) && num > rvn
    case 'lte':       return !isNaN(num) && num <= rvn
    case 'gte':       return !isNaN(num) && num >= rvn
    case 'eq':        return str === rv
    case 'neq':       return str !== rv
    case 'contains':  return str.includes(rv)
    case 'is_null':   return raw === null || raw === undefined || raw === ''
    case 'not_null':  return raw !== null && raw !== undefined && raw !== ''
    case 'custom': {
      if (!rule.expression) return false
      try {
        // eslint-disable-next-line no-new-func
        return !!(new Function('row', `return !!(${rule.expression})`)(row))
      } catch { return false }
    }
    default: return false
  }
}

// ─── Calcola stile CSS per una cella ─────────────────────────────
interface CellStyle {
  bg?:     string
  text?:   string
  border?: string
  icon?:   string
  bold?:   boolean
  rowBg?:  string   // se target === 'row', colora tutta la riga
  rowText?: string
}

function getCellStyle(
  row:     Row,
  field:   string,
  rules:   CellRule[],
  isDark:  boolean,
): CellStyle {
  const result: CellStyle = {}

  for (const rule of (rules ?? [])) {
    if (!evalRule(row, field, rule)) continue

    const presets = isDark ? STYLE_PRESETS_DARK : STYLE_PRESETS
    const preset  = rule.style !== 'custom' ? presets[rule.style] : null

    const bg   = rule.style === 'custom' ? (rule.bgColor   ?? '') : (preset?.bg   ?? '')
    const text = rule.style === 'custom' ? (rule.textColor ?? '') : (preset?.text ?? '')
    const brd  = preset?.border ?? ''

    if (rule.target === 'row') {
      result.rowBg   = bg
      result.rowText = text
    } else {
      result.bg     = bg
      result.text   = text
      result.border = brd
    }

    if (rule.icon) result.icon = ICONS[rule.icon] ?? ''
    break  // prima regola che corrisponde vince
  }

  return result
}

// ─── Integrazione DQ automatica ───────────────────────────────────
// Legge il campo _dq (configurabile) e marca le celle riparate
interface DQResult {
  score:    number
  valid:    boolean
  level:    string
  repaired: boolean
  issues:   Array<{
    field:    string
    severity: string
    message:  string
    repaired: boolean
    action?:  string
    original?: unknown
    newValue?: unknown
  }>
}

function getDQStyle(
  dq:     DQResult | null,
  field:  string,
  isDark: boolean,
): { cellStyle?: string; tooltip?: string; badge?: string } {
  if (!dq) return {}

  const issue = dq.issues?.find((i) => i.field === field)
  if (!issue) return {}

  const presets = isDark ? STYLE_PRESETS_DARK : STYLE_PRESETS

  if (issue.repaired) {
    // Cella riparata — evidenziata in warning con badge
    const p = presets.warning
    const originalStr = issue.original !== undefined && issue.original !== null
      ? ` (era: ${String(issue.original)})`
      : ''
    return {
      cellStyle: `background:${p.bg};color:${p.text};border:1px solid ${p.border};`,
      tooltip:   `Riparato: ${issue.message}${originalStr} → ${issue.action ?? 'repair'}`,
      badge:     `<span title="${issue.message}${originalStr}" style="display:inline-block;margin-left:5px;px;padding:1px 4px;border-radius:3px;background:${p.border};color:white;vertical-align:middle;cursor:help">✦</span>`,
    }
  } else if (issue.severity === 'error') {
    const p = presets.danger
    return {
      cellStyle: `background:${p.bg};color:${p.text};border:1px solid ${p.border};`,
      tooltip:   issue.message,
      badge:     `<span title="${issue.message}" style="display:inline-block;margin-left:5px;font-size:10px;padding:1px 4px;border-radius:3px;background:${p.border};color:white;vertical-align:middle;cursor:help">!</span>`,
    }
  } else if (issue.severity === 'warn') {
    const p = presets.warning
    return {
      cellStyle: `background:${p.bg};color:${p.text};`,
      tooltip:   issue.message,
      badge:     `<span title="${issue.message}" style="display:inline-block;margin-left:5px;font-size:10px;padding:1px 4px;border-radius:3px;background:${p.border};color:white;vertical-align:middle;cursor:help">⚠</span>`,
    }
  }

  return {}
}

// ─── Formatta valore cella ────────────────────────────────────────
function formatCell(val: unknown, type: string, locale = 'it'): string {
  if (val === null || val === undefined) return '—'
  const loc = locale === 'it' ? 'it-IT' : 'en-US'
  switch (type) {
    case 'currency': {
      const n = Number(val)
      return isNaN(n) ? String(val)
        : n.toLocaleString(loc, { style: 'currency', currency: locale === 'it' ? 'EUR' : 'USD', minimumFractionDigits: 2 })
    }
    case 'number': {
      const n = Number(val)
      return isNaN(n) ? String(val) : n.toLocaleString(loc)
    }
    case 'date': {
      const d = new Date(String(val))
      return isNaN(d.getTime()) ? String(val) : d.toLocaleDateString(loc)
    }
    default: return String(val)
  }
}

function calcTotal(rows: Row[], field: string, totalType: string, locale: string): string {
  const vals = rows.map((r) => Number(r[field])).filter((n) => !isNaN(n))
  if (vals.length === 0) return ''
  switch (totalType) {
    case 'sum':   return formatCell(vals.reduce((a, b) => a + b, 0), 'number', locale)
    case 'avg':   return formatCell(vals.reduce((a, b) => a + b, 0) / vals.length, 'number', locale)
    case 'count': return String(rows.length)
    default:      return ''
  }
}

function effectiveCols(rows: Row[], columns: ColumnConfig[], dqField: string): ColumnConfig[] {
  if (columns.length > 0 && columns.some((c) => c.field)) return columns
  return Object.keys(rows[0] ?? {})
    .filter((k) => k !== dqField)   // nascondi il campo _dq dalla tabella
    .map((k) => ({
      id: k, field: k,
      label: k.replace(/_/g, ' ').toUpperCase(),
      type: 'text' as const, total: 'none' as const, rules: [],
    }))
}

// ─── Temi ─────────────────────────────────────────────────────────
const THEMES: Record<string, {
  primary: string; accent: string; header: string; headerText: string
  rowEven: string; rowOdd: string; rowBorder: string; text: string; bg: string
}> = {
  blue:   { primary: '#1a3a6a', accent: '#4a9eff', header: '#1a3a6a', headerText: '#ffffff', rowEven: '#ffffff', rowOdd: '#e8f0fa', rowBorder: '#c8d4e8', text: '#1a2535', bg: '#f4f7fb' },
  green:  { primary: '#1a4a2a', accent: '#3ddc84', header: '#1a4a2a', headerText: '#ffffff', rowEven: '#ffffff', rowOdd: '#e8f8f0', rowBorder: '#c8e8d0', text: '#1a2a1e', bg: '#f4fbf7' },
  dark:   { primary: '#0f1117', accent: '#4a9eff', header: '#1a2030', headerText: '#c8d4f0', rowEven: '#161b27', rowOdd: '#1e2535', rowBorder: '#2a3349', text: '#c8d4f0', bg: '#0f1117' },
  orange: { primary: '#4a1a00', accent: '#ffb347', header: '#4a1a00', headerText: '#ffffff', rowEven: '#ffffff', rowOdd: '#fff4e8', rowBorder: '#e8d0c0', text: '#2a1a00', bg: '#fffaf4' },
}

// ─── Genera HTML tabella con conditional formatting ───────────────
function buildTable(
  rows:     Row[],
  columns:  ColumnConfig[],
  theme:    (typeof THEMES)[string],
  locale:   string,
  dqField:  string,
  isDark:   boolean,
): string {
  if (rows.length === 0) return '<p style="color:#999;font-style:italic">Nessun dato disponibile.</p>'

  const cols      = effectiveCols(rows, columns, dqField)
  const hasTotals = cols.some((c) => c.total && c.total !== 'none')
  const hasDQ     = rows.some((r) => r[dqField] != null)
  const hasRules  = cols.some((c) => (c.rules?.length ?? 0) > 0)

  const thStyle = `padding:10px 14px;text-align:left;background:${theme.header};color:${theme.headerText};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;border-bottom:2px solid ${theme.accent}`

  // Aggiungi colonna _dq score se presente
  const dqHeader = hasDQ
    ? `<th style="${thStyle};width:60px;text-align:center">DTS</th>`
    : ''

  const headerCells = cols.map((c) =>
    `<th style="${thStyle}">${c.label || c.field.replace(/_/g, ' ').toUpperCase()}</th>`
  ).join('') + dqHeader

  const bodyRows = rows.map((row, i) => {
    const dq = row[dqField] as DQResult | null | undefined

    // Calcola override colore riga da regole
    let rowBgOverride  = ''
    let rowTxtOverride = ''
    let rowBorderTop   = ''

    // Controlla regole su tutte le colonne per target === 'row'
    if (hasRules) {
      for (const col of cols) {
        const cs = getCellStyle(row, col.field, col.rules ?? [], isDark)
        if (cs.rowBg) { rowBgOverride = cs.rowBg; rowTxtOverride = cs.rowText ?? ''; break }
      }
    }

    // DQ: riga invalida → bordo top rosso, riga con warning → bordo top arancione
    if (hasDQ && dq) {
      if (!dq.valid) {
        const p = isDark ? STYLE_PRESETS_DARK.danger : STYLE_PRESETS.danger
        if (!rowBgOverride) { rowBgOverride = p.bg; rowTxtOverride = p.text }
        rowBorderTop = `border-top:2px solid ${p.border};`
      } else if (dq.level === 'warn' || dq.repaired) {
        const p = isDark ? STYLE_PRESETS_DARK.warning : STYLE_PRESETS.warning
        if (!rowBgOverride) rowBgOverride = p.bg
        rowBorderTop = `border-top:1px solid ${p.border};`
      }
    }

    const defaultBg = i % 2 === 0 ? theme.rowEven : theme.rowOdd
    const rowBg     = rowBgOverride || defaultBg
    const rowText   = rowTxtOverride || theme.text

    const cells = cols.map((col) => {
      const isNum   = col.type === 'number' || col.type === 'currency'
      let   cellBg  = rowBg
      let   cellTxt = rowText
      let   cellBrd = `border-bottom:1px solid ${theme.rowBorder};`
      let   badge   = ''
      let   icon    = ''

      // Regole di formattazione per target === 'cell'
      if ((col.rules?.length ?? 0) > 0) {
        const cs = getCellStyle(row, col.field, col.rules!, isDark)
        if (cs.bg)     cellBg  = cs.bg
        if (cs.text)   cellTxt = cs.text
        if (cs.border) cellBrd = `border:1px solid ${cs.border};border-bottom:1px solid ${cs.border};`
        if (cs.icon)   icon    = `<span style="margin-right:4px">${cs.icon}</span>`
      }

      // Integrazione DQ automatica
      if (hasDQ && dq) {
        const dqs = getDQStyle(dq, col.field, isDark)
        if (dqs.cellStyle) {
          // DQ override solo se non c'è già un override da regola
          if (!getCellStyle(row, col.field, col.rules ?? [], isDark).bg) {
            cellBg  = ''  // verrà gestito da cellStyle
            cellBrd = ''
          }
          badge = dqs.badge ?? ''
          // Applica stile DQ solo se nessuna regola ha già colorato la cella
          const hasCellRule = (col.rules ?? []).some((r) => r.target === 'cell' && evalRule(row, col.field, r))
          if (!hasCellRule) {
            const dqParts = dqs.cellStyle.match(/background:([^;]+)/)
            if (dqParts) cellBg = dqParts[1]
            const dqText = dqs.cellStyle.match(/color:([^;]+)/)
            if (dqText && dqText[1] !== cellBg) cellTxt = dqText[1]
          }
        }
      }

      const tdBase = `padding:9px 14px;font-size:13px;${rowBorderTop}${cellBrd}${isNum ? 'text-align:right;font-variant-numeric:tabular-nums;font-weight:500;' : ''}`
      const tdColor = `background:${cellBg};color:${cellTxt};`

      return `<td style="${tdBase}${tdColor}">${icon}${formatCell(row[col.field], col.type, locale)}${badge}</td>`
    }).join('')

    // Colonna DQ score
    const dqCell = hasDQ && dq
      ? (() => {
          const score   = dq.score ?? 1
          const pct     = Math.round(score * 100)
          const color   = score >= 0.8 ? '#27ae60' : score >= 0.6 ? '#f39c12' : '#e74c3c'
          const bgScore = score >= 0.8 ? '#f0fff4' : score >= 0.6 ? '#fffbf0' : '#fff0f0'
          const icon    = dq.repaired ? ' ✦' : ''
          const title   = dq.repaired
            ? `Score: ${pct}% — ${dq.issues?.filter((i) => i.repaired).length} campi riparati`
            : `Score: ${pct}%${dq.issues?.length ? ` — ${dq.issues.length} problemi` : ''}`
          return `<td style="padding:6px 10px;text-align:center;background:${bgScore};border-bottom:1px solid ${theme.rowBorder};${rowBorderTop}">
            <span title="${title}" style="font-size:11px;font-weight:700;color:${color};cursor:help;white-space:nowrap">${pct}%${icon}</span>
          </td>`
        })()
      : ''

    return `<tr>${cells}${dqCell}</tr>`
  }).join('')

  const totalRow = hasTotals
    ? `<tr>${cols.map((c) => {
        const isNum = c.type === 'number' || c.type === 'currency'
        const val   = c.total && c.total !== 'none' ? calcTotal(rows, c.field, c.total, locale) : ''
        return `<td style="padding:9px 14px;font-size:13px;font-weight:700;color:${theme.accent};background:${theme.rowOdd};border-top:2px solid ${theme.accent};${isNum ? 'text-align:right' : ''}">${val}</td>`
      }).join('')}${hasDQ ? '<td style="border-top:2px solid #ddd"></td>' : ''}</tr>`
    : ''

  // Legenda DQ se presente
  const dqLegend = hasDQ ? `
    <div style="margin-top:10px;display:flex;gap:16px;font-size:11px;color:#888;flex-wrap:wrap">
      <span><span style="display:inline-block;width:10px;height:10px;background:#fff0f0;border:1px solid #e74c3c;border-radius:2px;margin-right:4px;vertical-align:middle"></span>Dati invalidi</span>
      <span><span style="display:inline-block;width:10px;height:10px;background:#fffbf0;border:1px solid #f39c12;border-radius:2px;margin-right:4px;vertical-align:middle"></span>Warning / Riparato</span>
      <span style="color:#d35400">✦ = campo riparato automaticamente dal DQ</span>
      <span>DTS = Data Trust Score</span>
    </div>` : ''

  return `
  <div style="overflow-x:auto;border-radius:8px;border:1px solid ${theme.rowBorder};box-shadow:0 2px 8px rgba(0,0,0,.06)">
    <table style="width:100%;border-collapse:collapse;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${bodyRows}${totalRow}</tbody>
    </table>
  </div>${dqLegend}`
}

// ─── Grafici (invariati rispetto alla versione precedente) ────────

function buildBarChart(rows: Row[], xField: string, yField: string, title: string, accent: string, width = 680, height = 300): string {
  if (!xField || !yField || rows.length === 0) return ''
  const labels = rows.map((r) => String(r[xField] ?? ''))
  const values = rows.map((r) => Number(r[yField] ?? 0))
  const maxVal = Math.max(...values, 1)
  const padL = 60, padR = 20, padT = 20, padB = 70
  const chartW = width - padL - padR, chartH = height - padT - padB
  const barW = Math.max(8, Math.floor(chartW / rows.length) - 8)
  const bars = rows.map((_, i) => {
    const barH = Math.max(2, Math.floor((values[i] / maxVal) * chartH))
    const x = padL + Math.floor(i * (chartW / rows.length)) + Math.floor((chartW / rows.length - barW) / 2)
    const y = padT + chartH - barH
    const lx = x + barW / 2
    const label = labels[i].length > 10 ? labels[i].slice(0, 9) + '…' : labels[i]
    return `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${accent}" rx="3" opacity="0.9"/>
      <text x="${lx}" y="${y - 4}" text-anchor="middle" font-size="10" fill="${accent}" font-family="sans-serif" font-weight="600">${values[i].toLocaleString()}</text>
      <text x="${lx}" y="${padT + chartH + 18}" text-anchor="middle" font-size="11" fill="#555" font-family="sans-serif">${label}</text>`
  }).join('')
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((pct) => {
    const val = Math.round(maxVal * pct), y = padT + chartH - Math.floor(pct * chartH)
    return `<line x1="${padL}" y1="${y}" x2="${padL + chartW}" y2="${y}" stroke="#ddd" stroke-width="1"/>
      <text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="#888" font-family="sans-serif">${val.toLocaleString()}</text>`
  }).join('')
  return `<div style="margin:24px 0">
    ${title ? `<div style="font-size:14px;font-weight:600;color:#333;margin-bottom:10px;text-align:center">${title}</div>` : ''}
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" style="max-width:100%;display:block;margin:0 auto">
      <rect width="${width}" height="${height}" fill="white" rx="4"/>
      ${yTicks}${bars}
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + chartH}" stroke="#999" stroke-width="1.5"/>
      <line x1="${padL}" y1="${padT + chartH}" x2="${padL + chartW}" y2="${padT + chartH}" stroke="#999" stroke-width="1.5"/>
    </svg>
  </div>`
}

function buildLineChart(rows: Row[], xField: string, yField: string, title: string, accent: string, width = 680, height = 300): string {
  if (!xField || !yField || rows.length < 2) return ''
  const values = rows.map((r) => Number(r[yField] ?? 0))
  const labels = rows.map((r) => String(r[xField] ?? ''))
  const maxVal = Math.max(...values, 1), minVal = Math.min(...values, 0), range = maxVal - minVal || 1
  const padL = 60, padR = 20, padT = 20, padB = 70
  const chartW = width - padL - padR, chartH = height - padT - padB
  const points = rows.map((_, i) => `${padL + Math.floor((i / (rows.length - 1)) * chartW)},${padT + chartH - Math.floor(((values[i] - minVal) / range) * chartH)}`).join(' ')
  const area = `${padL},${padT + chartH} ` + rows.map((_, i) => `${padL + Math.floor((i / (rows.length - 1)) * chartW)},${padT + chartH - Math.floor(((values[i] - minVal) / range) * chartH)}`).join(' ') + ` ${padL + chartW},${padT + chartH}`
  const dots = rows.map((_, i) => {
    const x = padL + Math.floor((i / (rows.length - 1)) * chartW)
    const y = padT + chartH - Math.floor(((values[i] - minVal) / range) * chartH)
    const label = labels[i].length > 10 ? labels[i].slice(0, 9) + '…' : labels[i]
    const show = rows.length <= 16 || i % Math.ceil(rows.length / 16) === 0
    return `<circle cx="${x}" cy="${y}" r="4" fill="${accent}" stroke="white" stroke-width="2"/>
      ${show ? `<text x="${x}" y="${padT + chartH + 18}" text-anchor="middle" font-size="11" fill="#555" font-family="sans-serif">${label}</text>` : ''}`
  }).join('')
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((pct) => {
    const val = (minVal + range * pct).toFixed(0), y = padT + chartH - Math.floor(pct * chartH)
    return `<line x1="${padL}" y1="${y}" x2="${padL + chartW}" y2="${y}" stroke="#ddd" stroke-width="1"/>
      <text x="${padL - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="#888" font-family="sans-serif">${Number(val).toLocaleString()}</text>`
  }).join('')
  return `<div style="margin:24px 0">
    ${title ? `<div style="font-size:14px;font-weight:600;color:#333;margin-bottom:10px;text-align:center">${title}</div>` : ''}
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" style="max-width:100%;display:block;margin:0 auto">
      <rect width="${width}" height="${height}" fill="white" rx="4"/>
      ${yTicks}<polygon points="${area}" fill="${accent}" opacity="0.1"/>
      <polyline points="${points}" fill="none" stroke="${accent}" stroke-width="2.5" stroke-linejoin="round"/>
      ${dots}
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + chartH}" stroke="#999" stroke-width="1.5"/>
      <line x1="${padL}" y1="${padT + chartH}" x2="${padL + chartW}" y2="${padT + chartH}" stroke="#999" stroke-width="1.5"/>
    </svg>
  </div>`
}

function buildPieChart(rows: Row[], xField: string, yField: string, title: string, accent: string): string {
  if (!xField || !yField || rows.length === 0) return ''
  const COLORS = [accent, '#3ddc84', '#ffb347', '#a78bfa', '#22d3ee', '#f472b6', '#ff5f57', '#84cc16', '#fb923c', '#e879f9']
  const values = rows.map((r) => Math.abs(Number(r[yField] ?? 0)))
  const labels = rows.map((r) => String(r[xField] ?? ''))
  const total = values.reduce((a, b) => a + b, 0) || 1
  const cx = 140, cy = 130, r = 100
  let currentAngle = -Math.PI / 2
  const slices = rows.map((_, i) => {
    const pct = values[i] / total; if (pct === 0) return ''
    const angle = pct * 2 * Math.PI
    const x1 = cx + r * Math.cos(currentAngle), y1 = cy + r * Math.sin(currentAngle)
    const x2 = cx + r * Math.cos(currentAngle + angle), y2 = cy + r * Math.sin(currentAngle + angle)
    const large = angle > Math.PI ? 1 : 0
    const midA = currentAngle + angle / 2
    const lx = cx + (r * 0.65) * Math.cos(midA), ly = cy + (r * 0.65) * Math.sin(midA)
    const color = COLORS[i % COLORS.length]
    const path = `M ${cx} ${cy} L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z`
    currentAngle += angle
    return `<path d="${path}" fill="${color}" stroke="white" stroke-width="2"/>
      ${pct > 0.04 ? `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="white" font-weight="600" font-family="sans-serif">${(pct * 100).toFixed(0)}%</text>` : ''}`
  }).join('')
  const legendItems = rows.map((_, i) => {
    const label = labels[i].length > 22 ? labels[i].slice(0, 21) + '…' : labels[i]
    const pct = ((values[i] / total) * 100).toFixed(1), ly = 20 + i * 22
    return `<rect x="295" y="${ly}" width="12" height="12" fill="${COLORS[i % COLORS.length]}" rx="2"/>
      <text x="313" y="${ly + 10}" font-size="11" fill="#333" font-family="sans-serif">${label} (${pct}%)</text>`
  }).join('')
  const svgH = Math.max(280, 20 + rows.length * 22 + 20)
  return `<div style="margin:24px 0">
    ${title ? `<div style="font-size:14px;font-weight:600;color:#333;margin-bottom:10px;text-align:center">${title}</div>` : ''}
    <svg xmlns="http://www.w3.org/2000/svg" width="560" height="${svgH}" style="max-width:100%;display:block;margin:0 auto">
      <rect width="560" height="${svgH}" fill="white" rx="4"/>
      ${slices}${legendItems}
    </svg>
  </div>`
}

function buildSummary(rows: Row[], kpiFields: string[], theme: (typeof THEMES)[string], locale: string, dqField: string): string {
  if (rows.length === 0) return ''
  const fields = kpiFields.length > 0 ? kpiFields : Object.keys(rows[0] ?? {}).filter((k) => k !== dqField).slice(0, 4)
  const cards = fields.map((field) => {
    const vals  = rows.map((r) => r[field])
    const nums  = vals.map(Number).filter((n) => !isNaN(n))
    const isNum = nums.length > 0 && nums.length === vals.filter((v) => v !== null && v !== undefined).length
    const display = isNum ? formatCell(nums.reduce((a, b) => a + b, 0), 'number', locale) : String(new Set(vals.filter((v) => v != null).map(String)).size)
    const subinfo = isNum
      ? `Media: ${formatCell(nums.reduce((a, b) => a + b, 0) / nums.length, 'number', locale)} · N: ${nums.length}`
      : `Valori unici: ${new Set(vals.filter((v) => v != null).map(String)).size}`
    return `<div style="flex:1;min-width:150px;padding:18px 20px;background:${theme.primary};border-radius:8px;border-left:4px solid ${theme.accent};box-shadow:0 2px 8px rgba(0,0,0,.1)">
      <div style="font-size:10px;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;font-weight:600">${field.replace(/_/g, ' ')}</div>
      <div style="font-size:26px;font-weight:700;color:${theme.accent};margin-bottom:4px;font-variant-numeric:tabular-nums">${display}</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.5)">${subinfo}</div>
    </div>`
  }).join('')
  return `<div style="display:flex;flex-wrap:wrap;gap:14px;margin-bottom:24px">${cards}</div>`
}

// ─── HTML completo ────────────────────────────────────────────────
function buildHTML(rows: Row[], templateId: string, columns: ColumnConfig[], opts: {
  title: string; subtitle: string; logoUrl: string
  chartTitle: string; xField: string; yField: string
  kpiFields: string[]; theme: (typeof THEMES)[string]
  accent: string; locale: string; dqField: string
}): string {
  const { title, subtitle, logoUrl, chartTitle, xField, yField, kpiFields, theme, accent, locale, dqField } = opts
  const isDark = theme.bg === '#0f1117'

  let body = ''
  switch (templateId) {
    case 'table':
      body = buildTable(rows, columns, theme, locale, dqField, isDark); break
    case 'summary':
      body = buildSummary(rows, kpiFields, theme, locale, dqField); break
    case 'bar_chart':
      body = buildBarChart(rows, xField, yField, chartTitle, accent); break
    case 'line_chart':
      body = buildLineChart(rows, xField, yField, chartTitle, accent); break
    case 'pie_chart':
      body = buildPieChart(rows, xField, yField, chartTitle, accent); break
    case 'mixed':
      body = [
        buildSummary(rows, kpiFields, theme, locale, dqField),
        buildBarChart(rows, xField, yField, chartTitle || (xField && yField ? `${yField} per ${xField}` : ''), accent),
        `<div style="margin-top:28px"><div style="font-size:14px;font-weight:600;color:${isDark ? '#c8d4f0' : '#333'};margin-bottom:12px">Dati dettagliati</div>`,
        buildTable(rows, columns, theme, locale, dqField, isDark),
        `</div>`,
      ].join('\n'); break
    default:
      body = buildTable(rows, columns, theme, locale, dqField, isDark)
  }

  const logoHtml = logoUrl ? `<img src="${logoUrl}" style="max-height:48px;max-width:140px;object-fit:contain" alt="logo"/>` : ''
  const dateStr  = new Date().toLocaleDateString(locale === 'it' ? 'it-IT' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' })

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title || 'Report'}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;background:${theme.bg};color:${theme.text};padding:24px;min-height:100vh}
  .report{max-width:980px;margin:0 auto;background:${isDark ? '#161b27' : '#fff'};border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.12)}
  .report-header{padding:22px 28px;background:${theme.header};display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
  .report-title{font-size:22px;font-weight:700;color:${theme.headerText}}
  .report-subtitle{font-size:13px;color:${theme.headerText}90;margin-top:4px}
  .report-meta{text-align:right;font-size:11px;color:${theme.headerText}70;line-height:1.6}
  .report-body{padding:28px}
  @media print{body{background:#fff;padding:0}.report{box-shadow:none;border-radius:0}}
</style>
</head>
<body>
<div class="report">
  <div class="report-header">
    <div>
      <div class="report-title">${title || 'Report'}</div>
      ${subtitle ? `<div class="report-subtitle">${subtitle}</div>` : ''}
    </div>
    <div class="report-meta">${logoHtml}<div>${dateStr}</div><div>${rows.length.toLocaleString()} righe</div></div>
  </div>
  <div class="report-body">${body}</div>
</div>
</body>
</html>`
}

// ─── Excel ────────────────────────────────────────────────────────
async function buildExcel(rows: Row[], columns: ColumnConfig[], title: string, dqField: string): Promise<string> {
  const XLSX  = await import('xlsx')
  const cols  = effectiveCols(rows, columns, dqField)
  const header = cols.map((c) => c.label || c.field.replace(/_/g, ' ').toUpperCase())
  const data   = rows.map((row) => cols.map((c) => {
    const val = row[c.field]
    if (val === null || val === undefined) return ''
    if (c.type === 'number' || c.type === 'currency') return Number(val) || 0
    if (c.type === 'date') { const d = new Date(String(val)); return isNaN(d.getTime()) ? String(val) : d }
    return String(val)
  }))
  const ws = XLSX.utils.aoa_to_sheet([header, ...data])
  ws['!cols'] = cols.map((c) => ({ wch: Math.max((c.label || c.field).length + 2, 14) }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, (title || 'Report').slice(0, 31))
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }) as string
}

// ─── Executor ─────────────────────────────────────────────────────
export const reportGeneratorExecutor: NodeExecutor = {
  handles: ['report_generator'],
  requiresCompleteInput: () => true,

  async execute(node: FlowNode<NodeData>, input: Row[], context: ExecutionContext) {
    const props = node.data.props ?? {}

    const templateId   = (props['templateId']    as string) ?? 'table'
    const outputFmt    = (props['outputFormat']  as string) ?? 'html'
    const title        = (props['reportTitle']   as string) ?? 'Report'
    const subtitle     = (props['reportSubtitle']as string) ?? ''
    const filename     = (props['filename']      as string) ?? `report_${new Date().toISOString().slice(0,10)}`
    const logoUrl      = (props['logoUrl']       as string) ?? ''
    const chartTitle   = (props['chartTitle']    as string) ?? ''
    const xField       = (props['chartXField']   as string) ?? ''
    const yField       = (props['chartYField']   as string) ?? ''
    const kpiRaw       = (props['kpiFields']     as string) ?? ''
    const colorTheme   = (props['colorTheme']    as string) ?? 'blue'
    const primaryColor = (props['primaryColor']  as string) ?? ''
    const accentColor  = (props['accentColor']   as string) ?? ''
    const locale       = (props['locale']        as string) ?? 'it'
    const dqField      = (props['dqField']       as string) ?? '_dq'

    let columns: ColumnConfig[] = []
    try { columns = JSON.parse((props['columns'] as string) ?? '[]') } catch {}

    const kpiFields = kpiRaw.split(',').map((s) => s.trim()).filter(Boolean)

    if (input.length === 0) context.callbacks.onLog('warn', 'ReportGenerator: nessuna riga in ingresso', node.id)

    // Conta righe con DQ
    const dqRows = input.filter((r) => r[dqField] != null).length
    if (dqRows > 0) {
      const repaired = input.filter((r) => (r[dqField] as any)?.repaired).length
      context.callbacks.onLog('info', `ReportGenerator: ${dqRows} righe con DQ score, ${repaired} riparate`, node.id)
    }

    context.callbacks.onLog('info', `ReportGenerator: ${input.length} righe → ${outputFmt.toUpperCase()} (${templateId})`, node.id)

    const baseTheme = THEMES[colorTheme] ?? THEMES.blue
    const theme     = colorTheme === 'custom'
      ? { ...baseTheme, header: primaryColor || baseTheme.primary, accent: accentColor || baseTheme.accent, primary: primaryColor || baseTheme.primary }
      : baseTheme
    const accent = theme.accent

    let content = '', contentType = 'text/html', ext = 'html'

    if (outputFmt === 'excel') {
      content     = await buildExcel(input, columns, title, dqField)
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ext         = 'xlsx'
    } else {
      content = buildHTML(input, templateId, columns, {
        title, subtitle, logoUrl,
        chartTitle: chartTitle || (xField && yField ? `${yField} per ${xField}` : ''),
        xField, yField, kpiFields, theme, accent, locale, dqField,
      })
      contentType = 'text/html'
      ext         = 'html'
    }

    const filenameWithExt = filename.includes('.') ? filename : `${filename}.${ext}`
    context.callbacks.onLog('ok', `ReportGenerator: report generato → ${filenameWithExt}`, node.id)

    return new Map([['output', [{
      content, content_type: contentType, filename: filenameWithExt,
      row_count: input.length, generated_at: new Date().toISOString(),
      template: templateId, format: outputFmt,
    }]]])
  },
}