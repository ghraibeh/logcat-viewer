import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/theme.css'
import './styles/about.css'
import './styles/monitor.css'
import './styles/inspector.css'
import './styles/controls.css'
import './styles/db.css'
import './styles/files.css'
import './styles/toolbox.css'
import './styles/apps.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
