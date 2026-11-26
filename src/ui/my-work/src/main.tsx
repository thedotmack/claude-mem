import { installLocalApiToken } from '../../local-api-token-client'
import { installSharedViewerSession } from './lib/install-shared-viewer-session'
import { sharedViewerOwner } from './live/shared-viewer-session'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const owner = sharedViewerOwner()
if (owner) installSharedViewerSession(owner, window, document)
else installLocalApiToken()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
