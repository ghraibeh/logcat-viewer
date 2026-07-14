import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/theme.css'
import './styles/about.css'
import './styles/monitor.css'
import './styles/inspector.css'
import './styles/mirror.css'
import './styles/controls.css'
import './styles/location.css'
import './styles/db.css'
import './styles/files.css'
import './styles/toolbox.css'
import './styles/shell.css'
import './styles/apps.css'
import './styles/network.css'
import { initTheme } from './theme'

// Apply the persisted (or OS-preferred) theme before the first paint so there's
// no dark→light flash, and so the canvas PALETTE + log colors start correct.
initTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
