import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme.css'
import App from './App'
import { DialogHost } from './components/dialogs'
import { ContactPickerHost } from './workspace/contactOrg'
import { LazyWorkspacePanels } from './workspace/lazyPanels'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <DialogHost />
    <ContactPickerHost />
    <LazyWorkspacePanels />
  </StrictMode>,
)
