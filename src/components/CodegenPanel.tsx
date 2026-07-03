/**
 * PATCH A — src/nodes/FlowNode.tsx
 * ─────────────────────────────────
 * Aggiunge il badge errori/warning leggendo node.data.uiState.
 *
 * ISTRUZIONI:
 * Dentro il render del FlowNode, subito dopo l'header del nodo,
 * aggiungere il componente <IRBadge />:
 *
 *   {nodeData.uiState?.hasErrors || nodeData.uiState?.hasWarnings
 *     ? <IRBadge uiState={nodeData.uiState} />
 *     : null
 *   }
 */

import React from 'react'
import { CustomSelect } from '../components/CustomSelect'

interface UIState {
  hasErrors?:    boolean
  errorCount?:   number
  hasWarnings?:  boolean
  warningCount?: number
  issues?:       Array<{ severity: string; message: string; code: string }>
}

/**
 * Badge compatto che mostra errori e warning IR su un nodo canvas.
 * Appare nell'angolo in alto a destra del nodo.
 */
export function IRBadge({ uiState }: { uiState: UIState }) {
  const [showTooltip, setShowTooltip] = React.useState(false)

  if (!uiState.hasErrors && !uiState.hasWarnings) return null

  const color = uiState.hasErrors ? '#ff5f57' : '#ffb347'
  const count = uiState.hasErrors
    ? uiState.errorCount
    : uiState.warningCount
  const icon  = uiState.hasErrors ? 'ti-alert-circle' : 'ti-alert-triangle'

  return (
    <div
      style={{ position: 'absolute', top: -8, right: -8, zIndex: 10 }}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {/* Badge circolare */}
      <div style={{
        width:          20,
        height:         20,
        borderRadius:  '50%',
        background:     color,
        border:         '2px solid #0f1117',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
        cursor:         'pointer',
        boxShadow:      `0 0 6px ${color}60`,
      }}>
        <i className={`ti ${icon}`} style={{ fontSize: 10, color: '#0f1117' }} />
        {(count ?? 0) > 1 && (
          <span style={{
            position:   'absolute',
            top:        -4,
            right:      -4,
            background: color,
            color:      '#0f1117',
            fontSize:   8,
            fontWeight: 700,
            borderRadius: 8,
            padding:    '0 3px',
            minWidth:   12,
            textAlign:  'center',
          }}>
            {count}
          </span>
        )}
      </div>

      {/* Tooltip con lista issue */}
      {showTooltip && uiState.issues && uiState.issues.length > 0 && (
        <div style={{
          position:   'absolute',
          top:        24,
          right:      0,
          minWidth:   220,
          maxWidth:   300,
          background: '#1a2030',
          border:     `1px solid ${color}60`,
          borderRadius: 6,
          padding:    '6px 0',
          boxShadow:  '0 8px 24px rgba(0,0,0,.6)',
          zIndex:     1000,
        }}>
          {uiState.issues.map((issue, i) => (
            <div key={i} style={{
              padding:     '4px 10px',
              fontSize:    10,
              color:       issue.severity === 'error' ? '#ff5f57' : '#ffb347',
              borderBottom: i < uiState.issues!.length - 1
                ? '0.5px solid #2a3349'
                : 'none',
              display:     'flex',
              gap:         6,
              alignItems:  'flex-start',
            }}>
              <i className={`ti ${issue.severity === 'error' ? 'ti-alert-circle' : 'ti-alert-triangle'}`}
                 style={{ fontSize: 10, flexShrink: 0, marginTop: 1 }} />
              <span style={{ lineHeight: 1.4 }}>{issue.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────

/**
 * src/components/CodegenPanel.tsx
 * ────────────────────────────────
 * Pannello laterale per la compilazione e code generation.
 * Mostra lo stato del compilatore, gli errori, e permette
 * di scaricare il codice generato.
 *
 * Da montare nella UI principale accanto al canvas.
 */

import { useState } from 'react'
import { useFlowStore } from '../store/flowStore'
import { runCodegen }   from '../ir/pipeline'

export function CodegenPanel() {
  const nodes = useFlowStore((s) => s.nodes)
  const edges = useFlowStore((s) => s.edges)
  const pool  = useFlowStore((s) => s.pool)

  const [compiling,  setCompiling]  = useState(false)
  const [output,     setOutput]     = useState<Map<string, string> | null>(null)
  const [errors,     setErrors]     = useState<string[]>([])
  const [warnings,   setWarnings]   = useState<string[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)

  const handleGenerate = async () => {
    setCompiling(true)
    setErrors([])
    setWarnings([])
    setOutput(null)

    // Esegui in un microtask per non bloccare la UI
    await new Promise((r) => setTimeout(r, 0))

    try {
      const result = runCodegen(nodes, edges, pool)

      if (!result.valid) {
        setErrors(
          result.schemaIssues
            .filter((i) => i.severity === 'error')
            .map((i) => i.message)
        )
      } else {
        setOutput(result.output.files)
        setWarnings(result.output.warnings)
        // Seleziona index.ts come file attivo di default
        if (result.output.files.has('index.ts')) {
          setActiveFile('index.ts')
        }
      }
    } catch (e) {
      setErrors([`Errore interno: ${e}`])
    }

    setCompiling(false)
  }

  const handleDownload = () => {
    if (!output) return
    // Crea un file ZIP in memoria e scaricalo
    // Per ora: scarica solo index.ts come preview
    const content = output.get(activeFile ?? 'index.ts') ?? ''
    const blob    = new Blob([content], { type: 'text/plain' })
    const url     = URL.createObjectURL(blob)
    const a       = document.createElement('a')
    a.href        = url
    a.download    = activeFile ?? 'index.ts'
    a.click()
    URL.revokeObjectURL(url)
  }

  const fileList = output ? Array.from(output.keys()).sort() : []

  return (
    <div style={{
      display:        'flex',
      flexDirection:  'column',
      height:         '100%',
      background:     '#161b27',
      border:         '0.5px solid #2a3349',
      borderRadius:   8,
      overflow:       'hidden',
    }}>

      {/* Header */}
      <div style={{
        padding:        '10px 14px',
        background:     '#1a2030',
        borderBottom:   '1px solid #2a3349',
        display:        'flex',
        alignItems:     'center',
        gap:            8,
        flexShrink:     0,
      }}>
        <i className="ti ti-code" style={{ fontSize: 14, color: '#22d3ee' }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: '#c8d4f0', flex: 1 }}>
          Code Generator
        </span>
        <button
          onClick={handleGenerate}
          disabled={compiling}
          style={{
            padding:    '4px 14px',
            fontSize:   11,
            borderRadius: 4,
            cursor:     compiling ? 'wait' : 'pointer',
            background: compiling ? '#1e2535' : '#0d3a4a',
            color:      compiling ? '#4a5a7a' : '#22d3ee',
            border:     `1px solid ${compiling ? '#2a3349' : '#1a5a6a'}`,
            fontWeight: 600,
            display:    'flex',
            alignItems: 'center',
            gap:        5,
          }}
        >
          <i className={`ti ${compiling ? 'ti-loader' : 'ti-player-play'}`}
             style={{ fontSize: 11 }} />
          {compiling ? 'Compilazione...' : 'Genera TypeScript'}
        </button>
        {output && (
          <button
            onClick={handleDownload}
            title="Scarica file selezionato"
            style={{
              background:   'none',
              border:       '1px solid #2a3349',
              borderRadius: 4,
              padding:      '4px 8px',
              cursor:       'pointer',
              color:        '#9a9aaa',
            }}
          >
            <i className="ti ti-download" style={{ fontSize: 13 }} />
          </button>
        )}
      </div>

      {/* Errori */}
      {errors.length > 0 && (
        <div style={{ padding: '8px 12px', background: '#1a0000', borderBottom: '1px solid #3a1a1a', flexShrink: 0 }}>
          {errors.map((e, i) => (
            <div key={i} style={{ fontSize: 10, color: '#ff5f57', display: 'flex', gap: 5, marginBottom: 2 }}>
              <i className="ti ti-alert-circle" style={{ fontSize: 10, flexShrink: 0, marginTop: 1 }} />
              {e}
            </div>
          ))}
        </div>
      )}

      {/* Warning */}
      {warnings.length > 0 && (
        <div style={{ padding: '6px 12px', background: '#1a1000', borderBottom: '1px solid #3a2a0a', flexShrink: 0 }}>
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 10, color: '#ffb347', display: 'flex', gap: 5 }}>
              <i className="ti ti-alert-triangle" style={{ fontSize: 10, flexShrink: 0, marginTop: 1 }} />
              {w}
            </div>
          ))}
        </div>
      )}

      {/* Layout file tree + preview */}
      {output && (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '160px 1fr', overflow: 'hidden' }}>

          {/* File tree */}
          <div style={{ borderRight: '1px solid #2a3349', overflowY: 'auto', background: '#0f1117' }}>
            <div style={{ padding: '6px 10px', fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', borderBottom: '0.5px solid #2a3349' }}>
              File generati — {fileList.length}
            </div>
            {fileList.map((file) => (
              <div
                key={file}
                onClick={() => setActiveFile(file)}
                style={{
                  padding:    '5px 10px',
                  fontSize:   10,
                  cursor:     'pointer',
                  color:      activeFile === file ? '#22d3ee' : '#9a9aaa',
                  background: activeFile === file ? '#0d2535' : 'transparent',
                  borderBottom: '0.5px solid #1a2030',
                  fontFamily: 'monospace',
                  whiteSpace: 'nowrap',
                  overflow:   'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={file}
              >
                <i className="ti ti-file-code" style={{ fontSize: 9, marginRight: 5 }} />
                {file}
              </div>
            ))}
          </div>

          {/* Preview codice */}
          <div style={{ overflowY: 'auto', overflowX: 'auto' }}>
            {activeFile && (
              <pre style={{
                margin:     0,
                padding:    12,
                fontSize:   10,
                fontFamily: "'JetBrains Mono', monospace",
                color:      '#c8d4f0',
                background: 'transparent',
                lineHeight: 1.6,
                tabSize:    2,
                whiteSpace: 'pre',
              }}>
                {output.get(activeFile) ?? ''}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* Stato vuoto */}
      {!output && !compiling && errors.length === 0 && (
        <div style={{
          flex:           1,
          display:        'flex',
          flexDirection:  'column',
          alignItems:     'center',
          justifyContent: 'center',
          color:          '#2a3349',
          gap:            8,
        }}>
          <i className="ti ti-code" style={{ fontSize: 32, color: '#22d3ee20' }} />
          <span style={{ fontSize: 11 }}>Clicca "Genera TypeScript" per compilare la pipeline</span>
        </div>
      )}
    </div>
  )
}
