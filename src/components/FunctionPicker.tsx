/**
 * src/components/FunctionPicker.tsx
 *
 * SELETTORE UNICO di funzioni e trasformazioni.
 *
 * Prima ogni punto in cui si applica qualcosa aveva la sua tendina, e ognuna
 * mostrava un pezzo diverso: da una parte la descrizione, dall'altra il nome,
 * l'esempio da nessuna parte. Trovare `concat_ws` senza saperne il nome era
 * impossibile.
 *
 * Qui c'è un elenco solo, con SEMPRE gli stessi quattro dati — nome, tipo
 * restituito, forma d'uso, descrizione — ricercabile per nome E per
 * descrizione ("unisci" trova `concat_ws`). Le fonti sono quelle condivise:
 *   - `TRANSFORM_CATALOG` (via `getPresetsForType`) per le trasformazioni pronte,
 *     con i parametri già risolti coi valori predefiniti;
 *   - `FUNCTIONS` (le 84 funzioni FPEL) per tutto il resto.
 * Aggiungendo una voce a una delle due, compare qui e ovunque questo selettore
 * sia usato.
 *
 * Il codice restituito contiene il segnaposto `$sel`, che il chiamante
 * sostituisce con la selezione (o con l'intera espressione): così scegliere una
 * funzione AVVOLGE ciò che si sta guardando invece di inserire testo alla cieca.
 */
import { useMemo, useState } from 'react'
import { FUNCTIONS } from '../ir/functions'
import { getPresetsForType, type FieldType } from '../transforms/presets'
import { resolveTemplate } from '../transforms/templateCompiler'

export interface VoceApplicabile {
  id:        string
  nome:      string      // `concat_ws` oppure l'etichetta della trasformazione
  ritorna:   string      // tipo restituito
  uso:       string      // forma d'uso, come esempio
  desc:      string
  categoria: string
  /** Codice da inserire; `$sel` = ciò che si stava selezionando. */
  codice:    string
}

/** Costrutti del linguaggio: non stanno nel catalogo (non sono trasformazioni di
 *  campo) né fra le funzioni (non sono chiamate), ma servono di frequente. */
const COSTRUTTI: VoceApplicabile[] = [
  { id: 'c:isnull',   nome: 'è null',            ritorna: 'boolean', uso: 'valore is null',
    desc: 'Vero se il valore è vuoto',            categoria: 'costrutti', codice: '$sel is null' },
  { id: 'c:notnull',  nome: 'non è null',        ritorna: 'boolean', uso: 'valore is not null',
    desc: 'Vero se il valore è valorizzato',      categoria: 'costrutti', codice: '$sel is not null' },
  { id: 'c:iif',      nome: 'se… allora… altrimenti', ritorna: '—',  uso: 'iif(condizione, a, b)',
    desc: 'Sceglie fra due valori',               categoria: 'costrutti', codice: 'iif($sel is null, "vuoto", "pieno")' },
  { id: 'c:case',     nome: 'case when…',        ritorna: '—',       uso: 'case when … then … else … end',
    desc: 'Più condizioni in cascata',            categoria: 'costrutti', codice: 'case when $sel > 0 then "positivo" else "altro" end' },
  { id: 'c:var',      nome: 'variabile di lane', ritorna: '—',       uso: 'var("nome")',
    desc: 'Legge una variabile condivisa',        categoria: 'costrutti', codice: 'var("nome_variabile")' },
]

/** Le fonti condivise, unite in un elenco solo. */
export function vociApplicabili(tipo?: string): VoceApplicabile[] {
  const voci: VoceApplicabile[] = []

  // 1) trasformazioni pronte del catalogo (parametri già risolti)
  for (const t of getPresetsForType((tipo ?? 'string') as FieldType)) {
    if (t.id === 'passthrough' || t.id === 'custom') continue
    const valoriDefault = Object.fromEntries((t.params ?? []).map((p) => [p.key, p.default ?? '']))
    let codice: string
    try { codice = resolveTemplate(t, '$sel', valoriDefault) } catch { continue }
    voci.push({
      id: `t:${t.id}`, nome: t.label, ritorna: t.outputType ?? '—',
      uso: codice.replace(/\$sel/g, 'valore'), desc: t.description ?? '',
      categoria: 'trasformazioni pronte', codice,
    })
  }

  // 2) i COSTRUTTI del linguaggio: non sono funzioni né trasformazioni di campo,
  //    ma servono spesso e prima vivevano in una lista a parte dell'editor.
  for (const c of COSTRUTTI) voci.push(c)

  // 3) le funzioni del linguaggio
  for (const f of FUNCTIONS) {
    voci.push({
      id: `f:${f.name}`, nome: f.name, ritorna: f.returns ?? '—',
      uso: f.usage ?? `${f.name}(…)`, desc: f.desc ?? '',
      categoria: f.category ?? 'altre',
      // Sempre `nome($sel)`: avvolge ciò che si stava guardando. Per le funzioni
      // che vogliono più argomenti il testo inserito è incompleto — ma è meglio
      // che una virgola sospesa: il parser dice «richiede almeno N argomenti»,
      // mentre `nome($sel, )` darebbe l'oscuro «espressione attesa».
      // La forma d'uso completa è nella colonna accanto, sotto gli occhi.
      codice: `${f.name}($sel)`,
    })
  }
  return voci
}

export function FunctionPicker({ tipo, soloTrasformazioni, onScegli, onChiudi }: {
  tipo?:    string
  /** Solo le trasformazioni del catalogo: serve dove la scelta viene SALVATA
   *  nel modello (funzione di campo, ultimo passo), che sa rappresentare solo
   *  quelle. Altrove si offrono anche le 84 funzioni del linguaggio. */
  soloTrasformazioni?: boolean
  /** Riceve la voce intera: chi inserisce testo usa `codice`, chi salva una
   *  scelta nel modello usa `id` (`t:<idTemplate>`). */
  onScegli: (voce: VoceApplicabile) => void
  onChiudi: () => void
}) {
  const [cerca, setCerca] = useState('')
  const voci = useMemo(() => {
    const tutte = vociApplicabili(tipo)
    return soloTrasformazioni ? tutte.filter((v) => v.id.startsWith('t:')) : tutte
  }, [tipo, soloTrasformazioni])

  const filtrate = useMemo(() => {
    const q = cerca.trim().toLowerCase()
    if (!q) return voci
    // Ricerca su nome E descrizione: chi cerca "unisci" deve trovare concat_ws.
    return voci.filter((v) =>
      v.nome.toLowerCase().includes(q) ||
      v.desc.toLowerCase().includes(q) ||
      v.uso.toLowerCase().includes(q))
  }, [voci, cerca])

  const perCategoria = useMemo(() => {
    const m = new Map<string, VoceApplicabile[]>()
    for (const v of filtrate) m.set(v.categoria, [...(m.get(v.categoria) ?? []), v])
    return [...m.entries()]
  }, [filtrate])

  return (
    <div
      onClick={onChiudi}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 9000,
        // leggermente più in basso del centro: sopra resta visibile il campo su
        // cui si sta lavorando, così si vede cosa si sta per trasformare
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '14vh' }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 620, maxHeight: '72vh', display: 'flex', flexDirection: 'column',
          background: '#12151c', border: '1px solid #2a3349', borderRadius: 8,
          boxShadow: '0 10px 40px rgba(0,0,0,.5)' }}>

        <div style={{ padding: '10px 12px', borderBottom: '1px solid #2a3349',
          display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#dce6ff' }}>Applica una funzione</span>
          <input
            autoFocus
            value={cerca}
            onChange={(e) => setCerca(e.target.value)}
            placeholder="cerca per nome o descrizione — es: unisci, data, maiuscolo"
            style={{ flex: 1, background: '#0f1117', color: '#dce6ff', fontSize: 11,
              border: '1px solid #2a3349', borderRadius: 5, padding: '4px 8px' }} />
          <button onClick={onChiudi}
            style={{ background: 'none', border: 'none', color: '#5a6a8a', cursor: 'pointer', fontSize: 14 }}>✕</button>
        </div>

        <div style={{ overflowY: 'auto', padding: '6px 0' }}>
          {perCategoria.length === 0 && (
            <div style={{ padding: 16, fontSize: 11, color: '#5a6a8a' }}>
              Nessuna funzione corrisponde a «{cerca}».
            </div>
          )}
          {perCategoria.map(([cat, elenco]) => (
            <div key={cat}>
              <div style={{ padding: '5px 12px', fontSize: 9, color: '#5a6a8a',
                textTransform: 'uppercase', letterSpacing: '.06em' }}>{cat}</div>
              {elenco.map((v) => (
                <div key={v.id}
                  onClick={() => { onScegli(v); onChiudi() }}
                  style={{ padding: '5px 12px', cursor: 'pointer', display: 'grid',
                    gridTemplateColumns: '150px 74px 1fr', gap: 8, alignItems: 'baseline' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#1a2233' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
                  <span style={{ fontSize: 11, color: '#dce6ff', fontFamily: "'JetBrains Mono', monospace",
                    overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.nome}</span>
                  <span style={{ fontSize: 9, color: '#8aa4d0' }}>{v.ritorna}</span>
                  <span style={{ fontSize: 10, color: '#8aa4d0' }}>
                    <code style={{ color: '#7ea8e0' }}>{v.uso}</code>
                    {v.desc && <span style={{ color: '#5a6a8a' }}> — {v.desc}</span>}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div style={{ padding: '6px 12px', borderTop: '1px solid #2a3349', fontSize: 9, color: '#5a6a8a' }}>
          La funzione scelta <b>avvolge</b> il testo selezionato; senza selezione, l'intera espressione.
        </div>
      </div>
    </div>
  )
}
