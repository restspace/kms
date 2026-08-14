import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme.css'
import App from './App'
import { DialogHost } from './components/dialogs'
import { ContactPickerHost } from './workspace/contactOrg'
import { LazyWorkspacePanels } from './workspace/lazyPanels'
import { clearDeploymentRecoveryMarker, recoverFromStaleDeployment } from './deploymentRecovery'

// A tab left open across a deployment can still run the previous entry bundle,
// whose lazy-chunk filenames no longer exist. Vite reports that situation before
// React's error boundary sees it; reload once to pick up the current HTML shell.
window.addEventListener('vite:preloadError', (event) => {
  recoverFromStaleDeployment(event, window.sessionStorage, () => window.location.reload())
})
window.setTimeout(() => clearDeploymentRecoveryMarker(window.sessionStorage), 10_000)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <DialogHost />
    <ContactPickerHost />
    <LazyWorkspacePanels />
  </StrictMode>,
)
