import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Icone e font BUNDLATI in locale (niente CDN → CSP default-src 'self', offline-ok)
import '@tabler/icons-webfont/dist/tabler-icons.min.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
