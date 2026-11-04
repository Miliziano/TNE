/**
 * src/components/ScriptEditor/monacoLocale.ts
 *
 * Monaco dal pacchetto LOCALE (`monaco-editor` nelle dipendenze), non dalla
 * CDN. `@monaco-editor/react`, senza configurazione, scarica l'editor da
 * cdn.jsdelivr.net: nell'app installata la CSP (`script-src 'self'`) lo
 * blocca, e senza rete non c'è comunque. Così l'editor viaggia con l'app.
 *
 * Serve un solo worker, quello base dell'editor: i linguaggi usati (FPEL,
 * con la grammatica in flowpilotLanguage.ts, e SQL) sono solo evidenziazione,
 * senza servizi di linguaggio che chiedano worker propri.
 */
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

loader.config({ monaco })
