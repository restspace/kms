import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './theme.css'
import App from './App'
import { DialogHost } from './components/dialogs'
import { ImportWizardHost } from './workspace/ImportWizard'
import { ContactPickerHost } from './workspace/contactOrg'
import { DuplicatesHost } from './workspace/contactMerge'
import { SegmentsHost } from './workspace/segments'
import { MessageSelectedHost } from './workspace/messageSelected'

// DataTabManager uses React Query for tab-count caching, so the provider must
// wrap any screen that renders it.
const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <DialogHost />
      <ImportWizardHost />
      <ContactPickerHost />
      <DuplicatesHost />
      <SegmentsHost />
      <MessageSelectedHost />
    </QueryClientProvider>
  </StrictMode>,
)
