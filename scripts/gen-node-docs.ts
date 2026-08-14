/**
 * gen-node-docs.ts — generatore di SCHEDE-NODO (manuale di riferimento per-nodo).
 *
 * Fonti (dati puri, nessun React):
 *   - NODE_DEFS + PALETTE_SECTIONS  (src/nodes/nodeDefs.ts) — label, categoria,
 *     icona, colore, campi di configurazione, descrizione.
 *   - NODE_SEMANTICS                (src/ir/nodeSemantics.ts) — operazioni logiche,
 *     execution semantics, porte statiche in/out, multi-output, input multipli/
 *     dinamici, runtime preferiti, pushdown.
 *
 * Output: docs/nodes/<type>.md (una scheda per nodo) + docs/nodes/README.md (indice).
 *
 * MODELLO robusto (non una toppa "dump & overwrite"):
 *   ogni scheda ha un BLOCCO AUTO delimitato dai marcatori qui sotto, rigenerato
 *   a ogni run; TUTTO ciò che sta DOPO il marcatore di fine (la sezione
 *   "Approfondimento") è scritto a mano e viene PRESERVATO verbatim a ogni
 *   rigenerazione. Così lo scheletro auto per i ~43 nodi si arricchisce nel
 *   tempo senza che una rigenerazione cancelli il lavoro umano.
 *
 * Uso:  npm run docs:nodes      (equivale a  tsx scripts/gen-node-docs.ts)
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NODE_DEFS, PALETTE_SECTIONS } from '../src/nodes/nodeDefs'
import { NODE_SEMANTICS } from '../src/ir/nodeSemantics'
import type { FieldDef } from '../src/types'
import type { PortSpec } from '../src/ir/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'docs', 'nodes')

const AUTO_BEGIN = '<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->'
const AUTO_END   = '<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->'

// Coda di default, usata SOLO alla prima generazione di una scheda nuova.
function seedTail(label: string): string {
  return [
    '',
    '',
    '## Approfondimento',
    '',
    `_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **${label}**.`,
    'Questa sezione è scritta a mano e sopravvive alle rigenerazioni.',
    '',
  ].join('\n')
}

/** Etichette leggibili per l'execution semantics. */
const EXEC_LABEL: Record<string, string> = {
  row:      'riga-per-riga (`row`)',
  dataset:  'sull\'intero dataset (`dataset`)',
  stateful: 'con stato (`stateful`)',
  stream:   'a flusso (`stream`)',
}

const CATEGORY_LABEL: Record<string, string> = {
  input: 'Input', transform: 'Transform', output: 'Output',
}

function esc(s: string): string {
  // pipe e newline romperebbero le tabelle markdown
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function fieldsTable(fields: FieldDef[]): string {
  if (!fields || fields.length === 0) return '_Nessun campo di configurazione._\n'
  const head =
    '| Chiave | Etichetta | Tipo | Default | Opzioni | Inerte quando |\n' +
    '|---|---|---|---|---|---|\n'
  const rows = fields.map(f => {
    const opts = f.options && f.options.length ? f.options.map(o => `\`${esc(o)}\``).join(', ') : '—'
    const def  = f.default !== '' ? `\`${esc(f.default)}\`` : '—'
    const inert = f.ignoredWhenSet ? `\`${esc(f.ignoredWhenSet)}\` valorizzato` : '—'
    return `| \`${esc(f.key)}\` | ${esc(f.label)} | ${f.type} | ${def} | ${opts} | ${inert} |`
  })
  return head + rows.join('\n') + '\n'
}

function portsList(ports: PortSpec[] | undefined): string {
  if (!ports || ports.length === 0) return '_Nessuna._'
  return ports.map(p => {
    const bits: string[] = [`\`${esc(p.id)}\``]
    if (p.label && p.label !== p.id) bits.push(`«${esc(p.label)}»`)
    bits.push(`ruolo ${esc(p.role)}`)
    if (p.maxEdges) bits.push(`archi: ${p.maxEdges}`)
    if (p.maxRows)  bits.push(`righe: ${p.maxRows}`)
    if (p.when)     bits.push('_condizionata_')
    return `- ${bits.join(' · ')}`
  }).join('\n')
}

function autoBlock(type: string): string {
  const def = NODE_DEFS[type]
  const sem = NODE_SEMANTICS[type]
  const L: string[] = []

  L.push(AUTO_BEGIN)
  L.push('')
  L.push(`# ${def.label}  \`${type}\``)
  L.push('')
  const cat = CATEGORY_LABEL[def.category] ?? def.category
  L.push(`**Categoria:** ${cat}  ·  **Icona:** \`${esc(def.icon)}\`  ·  **Colore:** \`${def.color}\``)
  L.push('')
  L.push(def.description || '_Nessuna descrizione nel registry._')
  L.push('')
  L.push('## Configurazione')
  L.push('')
  L.push(fieldsTable(def.fields))
  L.push('## Semantica')
  L.push('')
  if (!sem) {
    L.push('> ⚠️ Nessuna semantica dichiarata in `NODE_SEMANTICS` per questo nodo.')
    L.push('')
  } else {
    const ops = sem.operations && sem.operations.length ? sem.operations.map(o => `\`${o}\``).join(', ') : '—'
    const runtimes = sem.preferredRuntimes && sem.preferredRuntimes.length
      ? sem.preferredRuntimes.map(r => `\`${r}\``).join(' → ') : '—'
    const pushdown = sem.pushdownCapable && sem.pushdownCapable.length
      ? sem.pushdownCapable.map(p => `\`${p}\``).join(', ') : 'nessuno'
    L.push(`- **Operazioni logiche:** ${ops}`)
    L.push(`- **Esecuzione:** ${EXEC_LABEL[sem.executionSemantics] ?? sem.executionSemantics}`)
    L.push(`- **Più output con schema diverso:** ${sem.producesMultipleOutputs ? 'sì' : 'no'}`)
    L.push(`- **Più ingressi:** ${sem.acceptsMultipleInputs ? 'sì' : 'no'}` +
           `${sem.acceptsDynamicInputs ? ' · **ingressi dinamici** (handle `input_new`)' : ''}`)
    L.push(`- **Runtime preferiti:** ${runtimes}`)
    L.push(`- **Pushdown alla sorgente:** ${pushdown}`)
    L.push('')
    L.push('**Porte di ingresso (statiche):**')
    L.push('')
    L.push(portsList(sem.staticInputPorts))
    L.push('')
    L.push('**Porte di uscita (statiche):**')
    L.push('')
    L.push(portsList(sem.staticOutputPorts))
    L.push('')
    if (sem.producesMultipleOutputs || sem.acceptsDynamicInputs) {
      L.push('> Alcune porte di questo nodo sono **dinamiche** (calcolate dalla' +
             ' configurazione a run-time): l\'elenco statico qui sopra può essere parziale.')
      L.push('')
    }
  }
  L.push(AUTO_END)
  return L.join('\n')
}

/** Legge la coda "Approfondimento" da un file esistente; altrimenti il seed. */
function existingTail(path: string, label: string): string {
  if (!existsSync(path)) return seedTail(label)
  const prev = readFileSync(path, 'utf-8')
  const idx = prev.indexOf(AUTO_END)
  if (idx === -1) return seedTail(label)          // file legacy senza marcatore
  return prev.slice(idx + AUTO_END.length)         // tutto dopo il marcatore di fine
}

function paletteSectionOf(type: string): string | null {
  for (const sec of PALETTE_SECTIONS) if (sec.types.includes(type)) return sec.label
  return null
}

// ─── generazione ──────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true })

const types = Object.keys(NODE_DEFS).sort()
let preserved = 0, seeded = 0, missingSem = 0

for (const type of types) {
  const def = NODE_DEFS[type]
  const path = join(OUT_DIR, `${type}.md`)
  const hadFile = existsSync(path)
  const tail = existingTail(path, def.label)
  if (hadFile && readFileSync(path, 'utf-8').includes(AUTO_END)) preserved++; else seeded++
  if (!NODE_SEMANTICS[type]) missingSem++
  writeFileSync(path, autoBlock(type) + tail, 'utf-8')
}

// ─── indice ───────────────────────────────────────────────────────
const idx: string[] = []
idx.push(AUTO_BEGIN)
idx.push('')
idx.push('# Riferimento nodi FlowPilot')
idx.push('')
idx.push(`Schede generate automaticamente dal registry (\`NODE_DEFS\`) e dalla semantica ` +
         `(\`NODE_SEMANTICS\`). Rigenera con \`npm run docs:nodes\`. La sezione ` +
         `«Approfondimento» di ogni scheda è scritta a mano e viene preservata.`)
idx.push('')
idx.push(`**${types.length} nodi.**`)
idx.push('')

const seen = new Set<string>()
for (const sec of PALETTE_SECTIONS) {
  const inSec = sec.types.filter(t => NODE_DEFS[t])
  if (inSec.length === 0) continue
  idx.push(`## ${sec.label}`)
  idx.push('')
  for (const t of inSec) {
    seen.add(t)
    const d = NODE_DEFS[t]
    const desc = (d.description || '').split(/[.·]/)[0].trim()
    idx.push(`- [\`${t}\`](./${t}.md) — **${d.label}**${desc ? ` · ${esc(desc)}` : ''}`)
  }
  idx.push('')
}
const others = types.filter(t => !seen.has(t))
if (others.length) {
  idx.push('## Altri')
  idx.push('')
  for (const t of others) {
    const d = NODE_DEFS[t]
    const desc = (d.description || '').split(/[.·]/)[0].trim()
    idx.push(`- [\`${t}\`](./${t}.md) — **${d.label}**${desc ? ` · ${esc(desc)}` : ''}`)
  }
  idx.push('')
}
idx.push(AUTO_END)
idx.push('')
writeFileSync(join(OUT_DIR, 'README.md'), idx.join('\n'), 'utf-8')

// ─── resoconto ────────────────────────────────────────────────────
const orphanSem = Object.keys(NODE_SEMANTICS).filter(t => !NODE_DEFS[t])
console.log(`schede-nodo: ${types.length} scritte in docs/nodes/`)
console.log(`  · coda preservata: ${preserved}   · scheletro nuovo: ${seeded}`)
console.log(`  · senza semantica: ${missingSem}`)
if (orphanSem.length) console.log(`  · semantica senza registry (ignorata): ${orphanSem.join(', ')}`)
console.log('indice: docs/nodes/README.md')
