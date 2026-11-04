/**
 * src/components/ScriptEditor/index.tsx
 *
 * L'editor di codice (Monaco) caricato SU RICHIESTA: è il pezzo più grande
 * dello studio e serve solo quando si apre un pannello con un editor. Il
 * componente vero è in Editor.tsx; qui l'involucro lazy e i tipi pubblici.
 */
import { lazy, Suspense } from 'react'
import type { ScriptEditorProps } from './types'

export type { SchemaField, ContextVar, ScriptEditorProps } from './types'

const EditorVero = lazy(() => import('./Editor'))

export function ScriptEditor(props: ScriptEditorProps) {
  const h = props.height ?? 300
  return (
    <Suspense fallback={
      <div style={{ height: h, background: '#0f1117', border: '1px solid #2a3349', borderRadius: 6,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6a7690', fontSize: 11 }}>
        loading editor…
      </div>
    }>
      <EditorVero {...props} />
    </Suspense>
  )
}
