import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // ── Rumore escluso, con motivo (P376) ───────────────────────────────
      // I blob di configurazione dei nodi (node.data.config, spec.config) sono
      // JSON dinamico tipizzato ai bordi: `any` lì è una scelta, non una svista.
      '@typescript-eslint/no-explicit-any': 'off',
      // `catch {}` vuoto è usato di proposito per "valore illeggibile → default".
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Il prefisso `_` marca un parametro o un elemento ignorato di proposito.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_',
      }],
      // Regole pensate per il React Compiler, che lo studio non usa: restano
      // come avvisi da smaltire a poco a poco. Le violazioni che erano bug
      // veri (hook condizionali, componenti creati nel render, JSX nel try)
      // sono state corrette; rules-of-hooks resta un errore.
      'react-hooks/use-memo': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/refs': 'warn',
      // Solo hot-reload in sviluppo: un file che esporta anche helper ricarica
      // la pagina invece del componente. Nessun effetto sul prodotto.
      'react-refresh/only-export-components': 'warn',

      // ── Guardrail sicurezza (anti-XSS) ──────────────────────────────────
      // Oggi lo studio NON usa nessuno di questi pattern: il contenuto non
      // fidato (label nodi, FPEL, .ffplan importati) è reso come TESTO via JSX
      // e React lo scappa da sé. Queste regole impediscono che un domani
      // qualcuno riapra il vettore XSS (che la CSP poi non basterebbe a coprire
      // in ogni caso). Vedi HANDOFF-firma-artifact / hardening studio.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            'dangerouslySetInnerHTML è vietato: renderizza il contenuto come testo. Se servisse davvero HTML da dati non fidati, va sanificato con una libreria dedicata e discusso prima.',
        },
        {
          selector: "MemberExpression[property.name='innerHTML']",
          message: 'innerHTML è vietato (vettore XSS): usa il rendering di React o textContent.',
        },
        {
          selector: "MemberExpression[property.name='outerHTML']",
          message: 'outerHTML è vietato (vettore XSS).',
        },
        {
          selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
          message: 'insertAdjacentHTML è vietato (vettore XSS).',
        },
        {
          selector: "CallExpression[callee.object.name='document'][callee.property.name='write']",
          message: 'document.write è vietato.',
        },
      ],
    },
  },
])
