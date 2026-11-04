import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Monaco senza i servizi di linguaggio di TypeScript, JSON, CSS e HTML.
 * L'editor dello studio usa solo FPEL (grammatica propria) e SQL, che sono
 * evidenziazione pura: quei servizi porterebbero con sé i loro worker
 * (~9 MB, il solo ts.worker ne pesa 7) per non essere mai usati. Si
 * sostituiscono con un modulo vuoto; tutto il resto dell'editor resta.
 */
function monacoSenzaServiziDiLinguaggio(): Plugin {
  const VUOTO = '\0monaco-servizio-vuoto'
  return {
    name: 'monaco-senza-servizi-di-linguaggio',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer?.includes('monaco-editor') &&
          /languages\/features\/(typescript|json|css|html)\/register(\.js)?$/.test(source)) {
        return VUOTO
      }
      return null
    },
    load(id) {
      return id === VUOTO ? 'export {}' : null
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [monacoSenzaServiziDiLinguaggio(), react()],
})
