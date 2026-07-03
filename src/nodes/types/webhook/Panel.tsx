/**
 * src/nodes/types/webhook/Panel.tsx
 *
 * Panel condiviso per tre nodi distinti:
 *   webhook_receiver  — riceve webhook, gestisce buffer e dedup
 *   webhook_responder — espone header sintetici su HEAD/GET (modalità flow o monitor)
 *   watchdog          — monitora servizi esterni via HEAD
 */
import { useState, useCallback } from 'react'
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

function Field({ label, children, hint }: {
  label: string; children: React.ReactNode; hint?: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}

function Row2({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

function SectionTitle({ label, color }: { label: string; color: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}

function SchemaRow({ name, type, desc, color }: { name: string; type: string; desc: string; color: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 3 }}>
      <code style={{ fontSize: 10, color, minWidth: 130, flexShrink: 0 }}>{name}</code>
      <span style={{ fontSize: 9, color: '#4a5a7a', minWidth: 50 }}>{type}</span>
      <span style={{ fontSize: 9, color: '#2a3349' }}>{desc}</span>
    </div>
  )
}

function InfoBox({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <div style={{ padding: '7px 10px', background: `color-mix(in srgb, ${color} 6%, #0f1117)`, borderRadius: 4, border: `0.5px solid ${color}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
      {children}
    </div>
  )
}

// ─── Webhook Receiver ─────────────────────────────────────────────

const ACCENT_RECV = '#3ddc84'

function ReceiverPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore(s => s.nodes.find(n => n.id === nodeId))
  const updateProp = useFlowStore(s => s.updateNodeProp)
  if (!node) return null

  const p = (key: string, def = '') => String(node.data.props?.[key] ?? def)
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: `color-mix(in srgb, ${ACCENT_RECV} 8%, #161b27)`, borderRadius: 6, border: `1px solid ${ACCENT_RECV}30` }}>
        <i className="ti ti-webhook" style={{ fontSize: 16, color: ACCENT_RECV }} />
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: ACCENT_RECV }}>Webhook Receiver</div>
          <div style={{ fontSize: 9, color: '#4a5a7a' }}>Riceve eventi in ingresso, risponde 200 OK immediatamente, propaga row by row</div>
        </div>
      </div>

      {/* Endpoint */}
      <SectionTitle label="Endpoint HTTP" color={ACCENT_RECV} />
      <Row2>
        <Field label="Porta">
          <input type="number" style={inputStyle} value={p('port', '9110')} onChange={u('port')} min="1024" max="65535" />
        </Field>
        <Field label="Path">
          <input style={inputStyle} value={p('path', '/webhook')} onChange={u('path')} placeholder="/webhook" />
        </Field>
      </Row2>
      <Field label="Tempo di ascolto (sec)" hint="0 = finché il runner non viene fermato">
        <input type="number" style={inputStyle} value={p('listenSec', '0')} onChange={u('listenSec')} min="0" />
      </Field>

      {/* HMAC */}
      <SectionTitle label="Firma HMAC (standard webhook)" color={ACCENT_RECV} />
      <InfoBox color={ACCENT_RECV}>
        GitHub, Stripe, Shopify e la maggior parte dei servizi firmano il payload con HMAC-SHA256.
        Se il secret è vuoto, la firma non viene verificata (accetta tutto).
        Se presente, gli eventi con firma non valida vengono comunque accodati ma con <code style={{ color: '#ffb347' }}>signature_valid: false</code>.
      </InfoBox>
      <Field label="HMAC Secret" hint="Lascia vuoto per disabilitare la verifica">
        <input type="password" style={inputStyle} value={p('hmacSecret', '')} onChange={u('hmacSecret')} placeholder="whsec_..." />
      </Field>
      <Row2>
        <Field label="Header firma">
          <input style={inputStyle} value={p('sigHeader', 'X-Hub-Signature-256')} onChange={u('sigHeader')} />
        </Field>
        <Field label="Algoritmo">
          <CustomSelect style={inputStyle} value={p('sigAlgo', 'sha256')} onChange={u('sigAlgo')}>
            <option value="sha256">HMAC-SHA256 (standard)</option>
            <option value="sha1">HMAC-SHA1 (legacy)</option>
          </CustomSelect>
        </Field>
      </Row2>

      {/* Buffer e deduplicazione */}
      <SectionTitle label="Buffer & Deduplicazione" color={ACCENT_RECV} />
      <InfoBox color={ACCENT_RECV}>
        Il buffer accumula eventi mentre il flusso elabora quelli precedenti.
        La deduplicazione usa l'<code style={{ color: '#4a9eff' }}>event_id</code> (header <code style={{ color: '#4a9eff' }}>X-Webhook-Delivery</code>
        o hash del payload) e scarta duplicati entro la finestra TTL.
      </InfoBox>
      <Row2>
        <Field label="TTL dedup (sec)" hint="0 = dedup disabilitato">
          <input type="number" style={inputStyle} value={p('dedupTtlSec', '3600')} onChange={u('dedupTtlSec')} min="0" />
        </Field>
        <Field label="Max eventi in buffer">
          <input type="number" style={inputStyle} value={p('maxBuffer', '1000')} onChange={u('maxBuffer')} min="1" />
        </Field>
      </Row2>
      <Field label="Politica overflow buffer">
        <CustomSelect style={inputStyle} value={p('overflow', 'drop_oldest')} onChange={u('overflow')}>
          <option value="drop_oldest">Scarta il più vecchio (FIFO)</option>
          <option value="drop_newest">Scarta il nuovo in arrivo</option>
          <option value="error">Errore — blocca il server</option>
        </CustomSelect>
      </Field>
      <Row2>
        <Field label="Poll interval (ms)" hint="Con quale frequenza estrarre dal buffer">
          <input type="number" style={inputStyle} value={p('pollIntervalMs', '200')} onChange={u('pollIntervalMs')} min="50" />
        </Field>
        <Field label="Debounce (ms)" hint="0 = disabilitato. Scarta eventi troppo ravvicinati">
          <input type="number" style={inputStyle} value={p('debounceMs', '0')} onChange={u('debounceMs')} min="0" />
        </Field>
      </Row2>

      {/* Schema output */}
      <SectionTitle label="Schema output — per ogni evento" color={ACCENT_RECV} />
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
        {[
          { name: 'event_id',        type: 'string',  desc: 'ID univoco (X-Webhook-Delivery o hash payload)' },
          { name: 'event_type',      type: 'string',  desc: 'Tipo evento (X-Webhook-Event)' },
          { name: 'source_ip',       type: 'string',  desc: 'IP del chiamante' },
          { name: 'payload',         type: 'object',  desc: 'Body JSON completo' },
          { name: 'headers',         type: 'object',  desc: 'Tutti gli header HTTP ricevuti' },
          { name: 'received_at',     type: 'date',    desc: 'Timestamp ricezione' },
          { name: 'signature_valid', type: 'boolean', desc: 'null se HMAC non configurato' },
          { name: '…payload.*',      type: 'any',     desc: 'Campi JSON del payload espansi in root' },
        ].map(f => <SchemaRow key={f.name} color={ACCENT_RECV} {...f} />)}
      </div>
    </div>
  )
}

// ─── HeaderTemplateEditor ────────────────────────────────────────
// Editor interattivo per il template degli header del Responder.
// Mostra le righe header come coppie chiave/valore editabili.
// In modalità monitor mostra un selettore per inserire le variabili di lane.


interface HeaderRow { key: string; value: string }

function parseTemplate(json: string): HeaderRow[] {
  try {
    const obj = JSON.parse(json)
    return Object.entries(obj).map(([key, value]) => ({ key, value: String(value) }))
  } catch {
    return [{ key: 'X-Data-Ready', value: 'true' }]
  }
}

function serializeTemplate(rows: HeaderRow[]): string {
  const obj: Record<string, string> = {}
  for (const r of rows) {
    if (r.key.trim()) obj[r.key.trim()] = r.value
  }
  return JSON.stringify(obj, null, 0)
}

function HeaderTemplateEditor({ value, onChange, varNames, mode, color }: {
  value:     string
  onChange:  (v: string) => void
  varNames:  string[]
  mode:      string
  color:     string
}) {
  const [rows, setRows] = useState<HeaderRow[]>(() => parseTemplate(value))
  const [insertTarget, setInsertTarget] = useState<number | null>(null)  // indice riga su cui inserire

  const update = useCallback((newRows: HeaderRow[]) => {
    setRows(newRows)
    onChange(serializeTemplate(newRows))
  }, [onChange])

  const setKey   = (i: number, v: string) => { const r = [...rows]; r[i] = { ...r[i], key: v };   update(r) }
  const setValue = (i: number, v: string) => { const r = [...rows]; r[i] = { ...r[i], value: v }; update(r) }
  const addRow   = () => update([...rows, { key: '', value: '' }])
  const removeRow = (i: number) => update(rows.filter((_, idx) => idx !== i))

  const insertVar = (varName: string, rowIdx: number) => {
    const r = [...rows]
    r[rowIdx] = { ...r[rowIdx], value: r[rowIdx].value + '$' + varName }
    update(r)
    setInsertTarget(null)
  }

  const sourceLabel = mode === 'monitor' ? 'variabile di lane' : 'campo della riga'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>

      {/* Info contestuale */}
      <div style={{ padding: '6px 10px', background: `color-mix(in srgb, ${color} 6%, #0f1117)`, borderRadius: 4, border: `0.5px solid ${color}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
        {mode === 'monitor'
          ? <>Scrivi il <strong>nome dell'header</strong> a sinistra. Nel valore usa <code style={{ color }}>$nomeVariabile</code> per inserire una {sourceLabel}.</>
          : <>Scrivi il <strong>nome dell'header</strong> a sinistra. Nel valore usa <code style={{ color }}>$nomeCampo</code> per inserire il valore di un {sourceLabel}.</>
        }
        {mode === 'monitor' && varNames.length === 0 && (
          <div style={{ marginTop: 4, color: '#4a5a7a', fontStyle: 'italic' }}>
            Nessuna variabile definita nella lane. Aggiungine una dalla sidebar delle variabili.
          </div>
        )}
      </div>

      {/* Righe header */}
      {rows.map((row, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {/* Chiave header */}
            <input
              style={{ ...inputStyle, flex: '0 0 140px', fontFamily: 'monospace', fontSize: 10 }}
              value={row.key}
              onChange={(e) => setKey(i, e.target.value)}
              placeholder="X-Header-Name"
            />
            <span style={{ color: '#4a5a7a', fontSize: 11, flexShrink: 0 }}>:</span>
            {/* Valore */}
            <input
              style={{ ...inputStyle, flex: 1, fontFamily: 'monospace', fontSize: 10 }}
              value={row.value}
              onChange={(e) => setValue(i, e.target.value)}
              placeholder={mode === 'monitor' ? '$nomeVariabile o valore fisso' : '$nomeCampo o valore fisso'}
            />
            {/* Bottone inserisci variabile — solo se ci sono variabili */}
            {mode === 'monitor' && varNames.length > 0 && (
              <button
                onClick={() => setInsertTarget(insertTarget === i ? null : i)}
                title="Inserisci variabile"
                style={{ padding: '4px 7px', background: insertTarget === i ? color : '#1a2030', border: `0.5px solid ${insertTarget === i ? color : '#3a4a6a'}`, borderRadius: 4, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                <i className="ti ti-variable" style={{ fontSize: 11, color: insertTarget === i ? '#0f1117' : color }} />
              </button>
            )}
            {/* Rimuovi riga */}
            <button
              onClick={() => removeRow(i)}
              title="Rimuovi header"
              style={{ padding: '4px 7px', background: 'transparent', border: '0.5px solid #2a3349', borderRadius: 4, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
              <i className="ti ti-x" style={{ fontSize: 10, color: '#ff5f57' }} />
            </button>
          </div>

          {/* Dropdown variabili — appare solo per la riga selezionata */}
          {insertTarget === i && varNames.length > 0 && (
            <div style={{ marginLeft: 146, display: 'flex', flexWrap: 'wrap', gap: 4, padding: '6px 8px', background: '#0f1117', borderRadius: 4, border: `0.5px solid ${color}40` }}>
              <span style={{ fontSize: 9, color: '#4a5a7a', width: '100%', marginBottom: 2 }}>
                Clicca per inserire nel valore:
              </span>
              {varNames.map(varName => (
                <button
                  key={varName}
                  onClick={() => insertVar(varName, i)}
                  style={{ padding: '2px 8px', background: `color-mix(in srgb, ${color} 15%, #0f1117)`, border: `0.5px solid ${color}50`, borderRadius: 3, cursor: 'pointer', color, fontSize: 10, fontFamily: 'monospace' }}>
                  ${varName}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Aggiungi riga */}
      <button
        onClick={addRow}
        style={{ padding: '5px 10px', background: '#1a2030', border: `0.5px solid #2a3349`, borderRadius: 4, cursor: 'pointer', color: '#4a5a7a', fontSize: 10, display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#c8d4f0'; (e.currentTarget as HTMLElement).style.borderColor = color }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a'; (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
        <i className="ti ti-plus" style={{ fontSize: 10 }} />
        Aggiungi header
      </button>

      {/* Preview JSON — collassato */}
      <details style={{ marginTop: 2 }}>
        <summary style={{ fontSize: 9, color: '#4a5a7a', cursor: 'pointer', userSelect: 'none' }}>
          JSON template (avanzato)
        </summary>
        <textarea
          style={{ ...inputStyle, resize: 'vertical', minHeight: 60, fontFamily: 'monospace', fontSize: 10, marginTop: 4 }}
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            try { setRows(parseTemplate(e.target.value)) } catch {}
          }}
        />
      </details>
    </div>
  )
}

// ─── Webhook Responder ────────────────────────────────────────────

const ACCENT_RESP = '#4a9eff'

function ResponderPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore(s => s.nodes.find(n => n.id === nodeId))
  const updateProp = useFlowStore(s => s.updateNodeProp)

  // Legge le variabili della lane per il selettore in modalità monitor
  const laneVariables = useFlowStore(s => {
    const laneId = node?.data.laneId as string | undefined
    if (!laneId) return ''
    const lane = s.pool.lanes.find(l => l.id === laneId)
    return (lane?.variables ?? []).map(v => v.name).join(';')
  })

  if (!node) return null

  const p = (key: string, def = '') => String(node.data.props?.[key] ?? def)
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const mode = p('mode', 'flow')
  const varNames = laneVariables ? laneVariables.split(';').filter(Boolean) : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: `color-mix(in srgb, ${ACCENT_RESP} 8%, #161b27)`, borderRadius: 6, border: `1px solid ${ACCENT_RESP}30` }}>
        <i className="ti ti-antenna" style={{ fontSize: 16, color: ACCENT_RESP }} />
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: ACCENT_RESP }}>Webhook Responder</div>
          <div style={{ fontSize: 9, color: '#4a5a7a' }}>Espone un endpoint HEAD/GET con header costruiti dallo stato corrente</div>
        </div>
      </div>

      {/* Modalità */}
      <SectionTitle label="Modalità operativa" color={ACCENT_RESP} />
      <Field label="Modalità">
        <CustomSelect style={inputStyle} value={mode} onChange={u('mode')}>
          <option value="flow">Flow — riceve righe dal flusso, costruisce header dai campi</option>
          <option value="monitor">Monitor — legge variabili di lane, sempre attivo</option>
        </CustomSelect>
      </Field>

      {mode === 'flow' && (
        <InfoBox color={ACCENT_RESP}>
          Il Responder è un nodo <strong>pass-through</strong> nel flusso ETL. Riceve righe in ingresso,
          costruisce gli header dai campi della riga corrente e aggiorna il server in tempo reale.
          Si spegne quando il flusso termina. Ideale per esporre lo stato di un'elaborazione in corso.
        </InfoBox>
      )}
      {mode === 'monitor' && (
        <InfoBox color={ACCENT_RESP}>
          Il Responder è un nodo <strong>autonomo sempre attivo</strong>, senza input di righe.
          Legge periodicamente le variabili di lane configurate e aggiorna gli header esposti.
          Le variabili vengono aggiornate da altri flussi in esecuzione nella stessa lane.
          Ideale per status endpoint di monitoring continuo.
        </InfoBox>
      )}

      {/* Endpoint */}
      <SectionTitle label="Endpoint HTTP" color={ACCENT_RESP} />
      <Row2>
        <Field label="Porta">
          <input type="number" style={inputStyle} value={p('port', '9111')} onChange={u('port')} min="1024" max="65535" />
        </Field>
        <Field label="Path">
          <input style={inputStyle} value={p('path', '/status')} onChange={u('path')} placeholder="/status" />
        </Field>
      </Row2>
      <Field label="Metodi accettati">
        <CustomSelect style={inputStyle} value={p('methods', 'HEAD,GET')} onChange={u('methods')}>
          <option value="HEAD">Solo HEAD</option>
          <option value="HEAD,GET">HEAD e GET</option>
          <option value="GET">Solo GET</option>
        </CustomSelect>
      </Field>
      <Field label="Tempo di esposizione (sec)" hint="0 = finché il runner non viene fermato">
        <input type="number" style={inputStyle} value={p('listenSec', '0')} onChange={u('listenSec')} min="0" />
      </Field>

      {/* Header template — editor interattivo con inserimento variabili */}
      <SectionTitle label="Header da esporre" color={ACCENT_RESP} />
      <HeaderTemplateEditor
        value={p('headerTemplate', '{"X-Data-Ready":"true","X-Status":"ok"}')}
        onChange={(v) => updateProp(nodeId, 'headerTemplate', v)}
        varNames={varNames}
        mode={mode}
        color={ACCENT_RESP}
      />

      {/* Solo modalità monitor: frequenza di aggiornamento */}
      {mode === 'monitor' && (
        <>
          <SectionTitle label="Aggiornamento variabili" color={ACCENT_RESP} />
          <Field label="Intervallo di polling (ms)" hint="Con quale frequenza rileggere le variabili di lane">
            <input type="number" style={inputStyle} value={p('varPollMs', '1000')} onChange={u('varPollMs')} min="100" />
          </Field>
          <InfoBox color={ACCENT_RESP}>
            Il Responder legge le variabili di lane ogni <strong>{p('varPollMs', '1000')} ms</strong> e
            aggiorna gli header esposti. Non è necessario riavviare il server — l'aggiornamento è in tempo reale.
          </InfoBox>
        </>
      )}

      {/* Solo modalità flow: info pass-through */}
      {mode === 'flow' && (
        <InfoBox color={ACCENT_RESP}>
          Le righe in ingresso passano invariate a valle. Il Responder aggiorna gli header
          ad ogni riga ricevuta — l'ultimo valore è sempre quello esposto.
        </InfoBox>
      )}
    </div>
  )
}

// ─── Watchdog ─────────────────────────────────────────────────────

const ACCENT_WD = '#ffb347'

function WatchdogPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore(s => s.nodes.find(n => n.id === nodeId))
  const updateProp = useFlowStore(s => s.updateNodeProp)
  if (!node) return null

  const p = (key: string, def = '') => String(node.data.props?.[key] ?? def)
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const authType   = p('authType', 'none')
  const watchMode  = p('watchMode', 'gate')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: `color-mix(in srgb, ${ACCENT_WD} 8%, #161b27)`, borderRadius: 6, border: `1px solid ${ACCENT_WD}30` }}>
        <i className="ti ti-eye" style={{ fontSize: 16, color: ACCENT_WD }} />
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: ACCENT_WD }}>Watchdog</div>
          <div style={{ fontSize: 9, color: '#4a5a7a' }}>
            {watchMode === 'gate'   && 'Blocca il flusso finché la condizione non è soddisfatta, poi sblocca e termina'}
            {watchMode === 'stream' && 'Emette una riga ad ogni rilevazione positiva — rimane sempre attivo'}
            {watchMode === 'edge'   && 'Emette una riga solo quando lo stato cambia (falso→vero o vero→falso)'}
          </div>
        </div>
      </div>

      {/* Modalità */}
      <SectionTitle label="Modalità operativa" color={ACCENT_WD} />
      <Field label="Modalità">
        <CustomSelect style={inputStyle} value={watchMode} onChange={u('watchMode')}>
          <option value="gate">Gate — blocca finché vero, sblocca una volta e termina</option>
          <option value="stream">Stream — emette ad ogni rilevazione positiva, rimane attivo</option>
          <option value="edge">Edge — emette solo al cambio di stato (transizione)</option>
        </CustomSelect>
      </Field>

      {watchMode === 'gate' && (
        <InfoBox color={ACCENT_WD}>
          Modalità classica. Il Watchdog <strong>blocca il flusso</strong> finché la condizione non è vera,
          poi propaga le righe in ingresso una volta sola e termina.
          Ideale per sincronizzare pipeline dipendenti: "aspetta che Pipeline A sia pronta, poi parti".
        </InfoBox>
      )}
      {watchMode === 'stream' && (
        <InfoBox color={ACCENT_WD}>
          Il Watchdog <strong>rimane attivo</strong> e genera una riga ad ogni polling in cui la condizione è vera.
          Non ha input di righe — è una source autonoma. Utile per raccogliere misurazioni periodiche
          di uno stato, loggare ogni volta che un servizio è disponibile, o triggerare azioni ripetute.
        </InfoBox>
      )}
      {watchMode === 'edge' && (
        <InfoBox color={ACCENT_WD}>
          Il Watchdog <strong>rimane attivo</strong> ma emette una riga <strong>solo quando lo stato cambia</strong>:
          da falso a vero (<code style={{ color: ACCENT_WD }}>rising</code>) o da vero a falso
          (<code style={{ color: ACCENT_WD }}>falling</code>). Ideale per alerting:
          "notificami quando il servizio va down, e quando torna su".
        </InfoBox>
      )}

      {/* Endpoint */}
      <SectionTitle label="Endpoint da controllare" color={ACCENT_WD} />
      <Field label="URL" hint="L'endpoint da interrogare periodicamente">
        <input style={inputStyle} value={p('url', '')} onChange={u('url')} placeholder="http://altro-servizio:9111/status" />
      </Field>
      <Row2>
        <Field label="Metodo">
          <CustomSelect style={inputStyle} value={p('method', 'HEAD')} onChange={u('method')}>
            <option value="HEAD">HEAD — solo header (raccomandato)</option>
            <option value="GET">GET — header + body (ignorato)</option>
          </CustomSelect>
        </Field>
        <Field label="Timeout richiesta (sec)">
          <input type="number" style={inputStyle} value={p('timeoutSec', '10')} onChange={u('timeoutSec')} min="1" />
        </Field>
      </Row2>

      {/* Autenticazione */}
      <SectionTitle label="Autenticazione" color={ACCENT_WD} />
      <Field label="Tipo">
        <CustomSelect style={inputStyle} value={authType} onChange={u('authType')}>
          <option value="none">Nessuna</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic auth (user:password)</option>
          <option value="api_key">API key in header</option>
        </CustomSelect>
      </Field>
      {authType !== 'none' && (
        <Field label={authType === 'api_key' ? 'API Key (header: valore)' : 'Credenziali'}>
          <input type="password" style={inputStyle} value={p('authValue', '')} onChange={u('authValue')}
            placeholder={authType === 'basic' ? 'user:password' : authType === 'api_key' ? 'X-API-Key:token' : 'token'} />
        </Field>
      )}

      {/* Condizione */}
      <SectionTitle label="Condizione (solo header)" color={ACCENT_WD} />
      <Field label="Nome header da controllare">
        <input style={inputStyle} value={p('headerName', 'X-Data-Ready')} onChange={u('headerName')} placeholder="X-Data-Ready" />
      </Field>
      <Row2>
        <Field label="Valore atteso">
          <input style={inputStyle} value={p('headerValue', 'true')} onChange={u('headerValue')} placeholder="true" />
        </Field>
        <Field label="Confronto">
          <CustomSelect style={inputStyle} value={p('matchMode', 'exact')} onChange={u('matchMode')}>
            <option value="exact">Esatto</option>
            <option value="contains">Contiene</option>
            <option value="present">Solo presente (qualsiasi valore)</option>
          </CustomSelect>
        </Field>
      </Row2>

      {/* Frequenza */}
      <SectionTitle label="Frequenza & Limiti" color={ACCENT_WD} />
      <Row2>
        <Field label="Intervallo (sec)" hint="Pausa tra un controllo e il successivo">
          <input type="number" style={inputStyle} value={p('intervalSec', '30')} onChange={u('intervalSec')} min="1" />
        </Field>
        <Field label="Timeout richiesta (sec)">
          <input type="number" style={inputStyle} value={p('timeoutSec', '10')} onChange={u('timeoutSec')} min="1" />
        </Field>
      </Row2>

      {/* Limiti — solo gate */}
      {watchMode === 'gate' && (
        <>
          <Row2>
            <Field label="Max tentativi" hint="0 = illimitato">
              <input type="number" style={inputStyle} value={p('maxAttempts', '0')} onChange={u('maxAttempts')} min="0" />
            </Field>
            <Field label="Timeout globale (min)" hint="0 = nessun limite">
              <input type="number" style={inputStyle} value={p('globalTtlMin', '0')} onChange={u('globalTtlMin')} min="0" />
            </Field>
          </Row2>
          <Field label="Se timeout scaduto">
            <CustomSelect style={inputStyle} value={p('onTimeout', 'error')} onChange={u('onTimeout')}>
              <option value="error">Errore — interrompe la pipeline</option>
              <option value="proceed">Procedi comunque (watchdog_matched: false)</option>
            </CustomSelect>
          </Field>
        </>
      )}

      {/* Durata — stream e edge */}
      {(watchMode === 'stream' || watchMode === 'edge') && (
        <Field label="Durata (min)" hint="0 = rimane attivo finché il runner non viene fermato">
          <input type="number" style={inputStyle} value={p('globalTtlMin', '0')} onChange={u('globalTtlMin')} min="0" />
        </Field>
      )}

      {/* Edge: filtro transizione */}
      {watchMode === 'edge' && (
        <Field label="Transizione da emettere">
          <CustomSelect style={inputStyle} value={p('edgeTrigger', 'both')} onChange={u('edgeTrigger')}>
            <option value="rising">Solo rising — quando diventa vero (servizio torna su)</option>
            <option value="falling">Solo falling — quando diventa falso (servizio va down)</option>
            <option value="both">Entrambe le transizioni</option>
          </CustomSelect>
        </Field>
      )}

      {/* Schema output */}
      <SectionTitle label="Campi della riga emessa" color={ACCENT_WD} />
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
        {[
          { name: 'watchdog_matched',     type: 'boolean', desc: 'true se condizione soddisfatta' },
          { name: 'watchdog_attempts',    type: 'integer', desc: 'Contatore controlli effettuati' },
          { name: 'watchdog_value_found', type: 'string',  desc: "Valore effettivo dell'header" },
          { name: 'watchdog_elapsed_ms',  type: 'integer', desc: 'Durata ultima richiesta' },
          { name: 'matched_at',           type: 'date',    desc: 'Timestamp del rilevamento' },
          ...(watchMode === 'edge' ? [
            { name: 'watchdog_edge',      type: 'string',  desc: '"rising" o "falling"' },
            { name: 'watchdog_prev',      type: 'boolean', desc: 'Stato precedente alla transizione' },
          ] : []),
        ].map(f => <SchemaRow key={f.name} color={ACCENT_WD} {...f} />)}
      </div>

    </div>
  )
}

// ─── Export unificato ─────────────────────────────────────────────

export function WebhookReceiverPanel({ nodeId }: { nodeId: string }) {
  return <ReceiverPanel nodeId={nodeId} />
}

export function WebhookResponderPanel({ nodeId }: { nodeId: string }) {
  return <ResponderPanel nodeId={nodeId} />
}

export function WatchdogPanel_({ nodeId }: { nodeId: string }) {
  return <WatchdogPanel nodeId={nodeId} />
}