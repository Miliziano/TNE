/**
 * src/nodes/types/source_ftp/Panel.tsx
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
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}
function SectionTitle({ label, color = '#4a9eff' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

const ACCENT = '#4a9eff'

export function SourceFtpPanel({ nodeId }: { nodeId: string }) {
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
  const resources  = (lane?.resources ?? []).filter((r) => r.kind === 'ftp')
  const resource   = resources.find((r) => r.id === resourceId)

  const protocol    = resource?.config?.protocol ?? p('protocol', 'sftp')
  const fetchMode   = p('fetchMode', 'list')
  const outputMode  = p('outputMode', 'content')   // 'content' | 'list_files'
  const fileFormat  = p('fileFormat', 'csv')
  const afterFetch  = p('afterFetch', 'leave')

  const isListMode  = outputMode === 'list_files'
  const isRaw       = fileFormat === 'raw'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Info risorsa */}
      {resource ? (
        <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', display: 'flex', gap: 8, alignItems: 'center' }}>
          <i className="ti ti-server" style={{ fontSize: 14, color: ACCENT }} />
          <div>
            <div style={{ fontWeight: 600, color: ACCENT }}>{resource.label}</div>
            <div style={{ fontSize: 9, color: '#4a5a7a' }}>
              {protocol.toUpperCase()} · {resource.config?.host ?? '—'}:{resource.config?.port ?? (protocol === 'sftp' ? '22' : '21')}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ padding: '10px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-server-off" style={{ fontSize: 20, display: 'block', marginBottom: 6 }} />
          Aggiungi una risorsa FTP/SFTP dalla resource strip, poi selezionala nel tab Connessione.
        </div>
      )}

      {/* Path remoto */}
      <SectionTitle label="Sorgente remota" />
      <Field label="Path remoto" hint="Percorso directory o file sul server">
        <input style={inputStyle} value={p('remotePath')} onChange={u('remotePath')} placeholder="/data/input/" />
      </Field>
      <Field label="Pattern file" hint="Filtro nome file — lascia vuoto per tutti. Es: *.csv, report_*.json">
        <input style={inputStyle} value={p('filePattern')} onChange={u('filePattern')} placeholder="*.csv" />
      </Field>
      <Field label="Ricerca nelle sottocartelle">
        <CustomSelect style={inputStyle} value={p('recursive', 'false')} onChange={u('recursive')}>
          <option value="false">No — solo la directory specificata</option>
          <option value="true">Sì — includi sottocartelle</option>
        </CustomSelect>
      </Field>

      {/* Modalità output */}
      <SectionTitle label="Modalità output" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {[
          { value: 'content',    label: '⇩ Scarica e legge',  desc: 'Scarica i file e ne emette il contenuto parsato come righe' },
          { value: 'list_files', label: '▤ Elenca file',       desc: 'Non scarica — emette una riga per ogni file trovato con nome, path, dimensione, data' },
        ].map((m) => (
          <button key={m.value} onClick={() => {
              updateProp(nodeId, 'outputMode', 'list_files')
              updateProp(nodeId, 'outputSchema', JSON.stringify([
                { id: 'ftp_name',        name: 'name',         type: 'string',  physicalName: 'name'        },
                { id: 'ftp_path',        name: 'path',         type: 'string',  physicalName: 'path'        },
                { id: 'ftp_is_dir',      name: 'is_dir',       type: 'boolean', physicalName: 'is_dir'      },
                { id: 'ftp_size',        name: 'size',         type: 'integer', physicalName: 'size'        },
                { id: 'ftp_modified_at', name: 'modified_at',  type: 'date',    physicalName: 'modified_at' },
              ]))
            }}
            style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3, background: outputMode === m.value ? `color-mix(in srgb, ${ACCENT} 12%, #1a2030)` : '#1a2030', border: outputMode === m.value ? `1px solid ${ACCENT}60` : '1px solid #2a3349' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: outputMode === m.value ? ACCENT : '#c8d4f0' }}>{m.label}</div>
            <div style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.4 }}>{m.desc}</div>
          </button>
        ))}
      </div>

      {/* Schema lista file */}
      {isListMode && (
        <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}20`, fontSize: 9, color: '#4a5a7a' }}>
          <div style={{ color: ACCENT, fontWeight: 600, marginBottom: 6, fontSize: 10 }}>Schema output — lista file</div>
          {[
            { name: 'name',        type: 'string',  desc: 'Nome del file' },
            { name: 'path',        type: 'string',  desc: 'Path completo sul server' },
            { name: 'is_dir',      type: 'boolean', desc: 'true se è una directory' },
            { name: 'size',        type: 'integer', desc: 'Dimensione in byte' },
            { name: 'modified_at', type: 'date',    desc: 'Data ultima modifica (se disponibile)' },
          ].map((f) => (
            <div key={f.name} style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
              <code style={{ color: ACCENT, minWidth: 90 }}>{f.name}</code>
              <span style={{ color: '#4a5a7a', minWidth: 55 }}>{f.type}</span>
              <span style={{ color: '#2a3349' }}>{f.desc}</span>
            </div>
          ))}
        </div>
      )}

      {/* Modalità acquisizione — solo se scarica */}
      {!isListMode && (
        <>
          <SectionTitle label="Modalità acquisizione" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {[
              { value: 'list',  label: '▤ Lista file',  desc: 'Scarica ed elabora tutti i file in un\'unica esecuzione' },
              { value: 'watch', label: '◎ Watch',        desc: 'Monitora la directory in polling — elabora i nuovi file man mano che arrivano' },
            ].map((m) => (
              <button key={m.value} onClick={() => updateProp(nodeId, 'fetchMode', m.value)}
                style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3, background: fetchMode === m.value ? `color-mix(in srgb, ${ACCENT} 12%, #1a2030)` : '#1a2030', border: fetchMode === m.value ? `1px solid ${ACCENT}60` : '1px solid #2a3349' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: fetchMode === m.value ? ACCENT : '#c8d4f0' }}>{m.label}</div>
                <div style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.4 }}>{m.desc}</div>
              </button>
            ))}
          </div>
          {fetchMode === 'watch' && (
            <Field label="Intervallo polling (secondi)">
              <input type="number" style={inputStyle} value={p('pollInterval', '30')} onChange={u('pollInterval')} min="5" />
            </Field>
          )}

          {/* Formato file */}
          <SectionTitle label="Formato file" />
          <Row>
            <Field label="Formato" hint={isRaw ? 'Il file viene scaricato intero nel campo content (stringa)' : undefined}>
              <CustomSelect style={inputStyle} value={fileFormat} onChange={(e) => {
                  const fmt = e.target.value
                  updateProp(nodeId, 'fileFormat', fmt)
                  // Aggiorna outputSchema in base al formato
                  if (fmt === 'raw') {
                    updateProp(nodeId, 'outputSchema', JSON.stringify([
                      { id: 'ftp_content',     name: 'content',     type: 'string',  physicalName: 'content'     },
                      { id: 'ftp_filename',    name: '_filename',    type: 'string',  physicalName: '_filename'   },
                      { id: 'ftp_filepath',    name: '_filepath',    type: 'string',  physicalName: '_filepath'   },
                      { id: 'ftp_filesize',    name: '_filesize',    type: 'integer', physicalName: '_filesize'   },
                      { id: 'ftp_modified_at', name: '_modified_at', type: 'date',    physicalName: '_modified_at'},
                    ]))
                  } else if (fmt === 'text') {
                    updateProp(nodeId, 'outputSchema', JSON.stringify([
                      { id: 'ftp_line',        name: 'line',         type: 'string',  physicalName: 'line'        },
                      { id: 'ftp_linenum',     name: 'lineNumber',   type: 'integer', physicalName: 'lineNumber'  },
                      { id: 'ftp_filename',    name: '_filename',    type: 'string',  physicalName: '_filename'   },
                      { id: 'ftp_filepath',    name: '_filepath',    type: 'string',  physicalName: '_filepath'   },
                      { id: 'ftp_modified_at', name: '_modified_at', type: 'date',    physicalName: '_modified_at'},
                    ]))
                  } else if (fmt === 'list_files') {
                    updateProp(nodeId, 'outputSchema', JSON.stringify([
                      { id: 'ftp_name',        name: 'name',         type: 'string',  physicalName: 'name'        },
                      { id: 'ftp_path',        name: 'path',         type: 'string',  physicalName: 'path'        },
                      { id: 'ftp_is_dir',      name: 'is_dir',       type: 'boolean', physicalName: 'is_dir'      },
                      { id: 'ftp_size',        name: 'size',         type: 'integer', physicalName: 'size'        },
                      { id: 'ftp_modified_at', name: 'modified_at',  type: 'date',    physicalName: 'modified_at' },
                    ]))
                  } else {
                    // Per CSV/JSON/ecc. azzera — l'utente configura i campi manualmente
                    updateProp(nodeId, 'outputSchema', '')
                  }
                }}>
                <optgroup label="Grezzo — nessun parsing">
                  <option value="raw">Raw — testo grezzo in campo content</option>
                  
                </optgroup>
                <optgroup label="Testo strutturato">
                  <option value="text">Testo — una riga per linea</option>   {/* ← aggiungi */}
                  <option value="csv">CSV</option>
                  <option value="tsv">TSV</option>
                  <option value="excel">Excel (.xlsx)</option>
                </optgroup>
                <optgroup label="Semi-strutturato">
                  <option value="json">JSON</option>
                  <option value="jsonl">JSON Lines</option>
                  <option value="xml">XML</option>
                </optgroup>
                <optgroup label="Binario">
                  <option value="binary">Binary (Base64)</option>
                </optgroup>
              </CustomSelect>
            </Field>
            {!isRaw && fileFormat !== 'binary' && (
              <Field label="Encoding">
                <CustomSelect style={inputStyle} value={p('encoding', 'utf-8')} onChange={u('encoding')}>
                  <option value="utf-8">UTF-8</option>
                  <option value="utf-16">UTF-16</option>
                  <option value="iso-8859-1">ISO-8859-1</option>
                  <option value="windows-1252">Windows-1252</option>
                </CustomSelect>
              </Field>
            )}
          </Row>

          {/* Info raw */}
          {isRaw && (
            <div style={{ padding: '6px 10px', background: '#0f1117', borderRadius: 4, border: `0.5px solid ${ACCENT}20`, fontSize: 9, color: '#4a5a7a' }}>
              Emette <strong style={{ color: ACCENT }}>1 riga per file</strong> con campo <code style={{ color: ACCENT }}>content</code> (stringa intera del file).
              Collegalo a un <strong style={{ color: '#22d3ee' }}>JSON Parser</strong> o <strong style={{ color: '#22d3ee' }}>XML Parser</strong> per estrarne i dati.
            </div>
          )}

          {/* Opzioni CSV */}
          {(fileFormat === 'csv' || fileFormat === 'tsv') && (
            <Row>
              <Field label="Separatore">
                <input style={inputStyle} value={p('delimiter', fileFormat === 'tsv' ? '\t' : ',')} onChange={u('delimiter')} placeholder="," />
              </Field>
              <Field label="Ha intestazione">
                <CustomSelect style={inputStyle} value={p('hasHeader', 'true')} onChange={u('hasHeader')}>
                  <option value="true">Sì — prima riga è intestazione</option>
                  <option value="false">No</option>
                </CustomSelect>
              </Field>
            </Row>
          )}

          {/* Compressione */}
          <Field label="Compressione">
            <CustomSelect style={inputStyle} value={p('compression', 'none')} onChange={u('compression')}>
              <option value="none">Nessuna</option>
              <option value="gzip">GZIP (.gz)</option>
              <option value="zip">ZIP (.zip)</option>
              <option value="bzip2">BZIP2 (.bz2)</option>
            </CustomSelect>
          </Field>

          {/* Dopo l'elaborazione */}
          <SectionTitle label="Dopo l'elaborazione" color="#ffb347" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[
              { value: 'leave',  label: '○ Lascia',  desc: 'Il file rimane nella posizione originale' },
              { value: 'move',   label: '→ Sposta',  desc: 'Sposta in una directory di archivio' },
              { value: 'delete', label: '✕ Elimina', desc: 'Elimina il file dal server — irreversibile' },
            ].map((a) => (
              <button key={a.value} onClick={() => updateProp(nodeId, 'afterFetch', a.value)}
                style={{ padding: '7px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10, background: afterFetch === a.value ? 'color-mix(in srgb, #ffb347 8%, #1a2030)' : '#1a2030', border: afterFetch === a.value ? '1px solid #ffb34740' : '1px solid #2a3349' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: afterFetch === a.value ? '#ffb347' : 'transparent', border: `1.5px solid ${afterFetch === a.value ? '#ffb347' : '#2a3349'}` }} />
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: afterFetch === a.value ? '#ffb347' : '#c8d4f0' }}>{a.label}</div>
                  <div style={{ fontSize: 9, color: '#4a5a7a' }}>{a.desc}</div>
                </div>
              </button>
            ))}
          </div>
          {afterFetch === 'move' && (
            <Field label="Directory archivio">
              <input style={inputStyle} value={p('archivePath')} onChange={u('archivePath')} placeholder="/data/processed/" />
            </Field>
          )}
        </>
      )}

      {/* Opzioni avanzate */}
      <SectionTitle label="Opzioni avanzate" color="#4a5a7a" />
      <Row>
        <Field label="Timeout connessione (sec)">
          <input type="number" style={inputStyle} value={p('connectTimeout', '30')} onChange={u('connectTimeout')} min="5" />
        </Field>
        <Field label="Max file per run" hint="0 = nessun limite">
          <input type="number" style={inputStyle} value={p('maxFiles', '0')} onChange={u('maxFiles')} min="0" />
        </Field>
      </Row>
      <Field label="Ordine elaborazione file">
        <CustomSelect style={inputStyle} value={p('fileOrder', 'name_asc')} onChange={u('fileOrder')}>
          <option value="name_asc">Nome crescente (A → Z)</option>
          <option value="name_desc">Nome decrescente (Z → A)</option>
          <option value="date_asc">Data modifica crescente (più vecchi prima)</option>
          <option value="date_desc">Data modifica decrescente (più recenti prima)</option>
          <option value="size_asc">Dimensione crescente (più piccoli prima)</option>
        </CustomSelect>
      </Field>
      {!isListMode && (
        <Field label="Su errore file singolo">
          <CustomSelect style={inputStyle} value={p('onFileError', 'skip')} onChange={u('onFileError')}>
            <option value="skip">Salta e continua con il file successivo</option>
            <option value="stop">Interrompi la pipeline</option>
            <option value="move_error">Sposta in directory errori e continua</option>
          </CustomSelect>
        </Field>
      )}
    </div>
  )
}