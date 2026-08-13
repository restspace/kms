import { Suspense, lazy, useEffect, useState } from 'react'
import type { ImportRequest } from './ImportWizard'
import type { DuplicatesPanelRequest } from './contactMerge'
import type { MessageSelectedRequest } from './messageSelected'
import type { SaveSegmentPanelRequest, SegmentsPanelRequest } from './segments'

type PanelKind = 'import' | 'duplicates' | 'segments' | 'message-selected'

const OPEN_EVENT = 'kms:open-lazy-workspace-panel'

const ImportWizardHost = lazy(() =>
  import('./ImportWizard').then((m) => ({ default: m.ImportWizardHost })),
)
const DuplicatesHost = lazy(() =>
  import('./contactMerge').then((m) => ({ default: m.DuplicatesHost })),
)
const SegmentsHost = lazy(() =>
  import('./segments').then((m) => ({ default: m.SegmentsHost })),
)
const MessageSelectedHost = lazy(() =>
  import('./messageSelected').then((m) => ({ default: m.MessageSelectedHost })),
)

function requestHost(kind: PanelKind): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<PanelKind>(OPEN_EVENT, { detail: kind }))
  }
}

/** Small eager entry points; the panel implementation and its host load together on first use. */
export function openImportWizard(request: ImportRequest): void {
  requestHost('import')
  void import('./ImportWizard').then((m) => m.openImportWizard(request))
}

export function openDuplicatesPanel(request: DuplicatesPanelRequest = {}): void {
  requestHost('duplicates')
  void import('./contactMerge').then((m) => m.openDuplicatesPanel(request))
}

export function openSaveSegmentPanel(request: SaveSegmentPanelRequest): void {
  requestHost('segments')
  void import('./segments').then((m) => m.openSaveSegmentPanel(request))
}

export function openSegmentsPanel(request: SegmentsPanelRequest = {}): void {
  requestHost('segments')
  void import('./segments').then((m) => m.openSegmentsPanel(request))
}

export function openMessageSelectedDialog(request: MessageSelectedRequest): void {
  requestHost('message-selected')
  void import('./messageSelected').then((m) => m.openMessageSelectedDialog(request))
}

/** Mounts no heavyweight panel code until one of the imperative entry points is used. */
export function LazyWorkspacePanels() {
  const [loaded, setLoaded] = useState<Set<PanelKind>>(() => new Set())

  useEffect(() => {
    const onOpen = (event: Event) => {
      const kind = (event as CustomEvent<PanelKind>).detail
      setLoaded((prev) => {
        if (prev.has(kind)) return prev
        const next = new Set(prev)
        next.add(kind)
        // The import preview can open duplicate review through the original
        // contactMerge entry point, so its host must be present too.
        if (kind === 'import') next.add('duplicates')
        return next
      })
    }
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])

  return (
    <Suspense fallback={null}>
      {loaded.has('import') && <ImportWizardHost />}
      {loaded.has('duplicates') && <DuplicatesHost />}
      {loaded.has('segments') && <SegmentsHost />}
      {loaded.has('message-selected') && <MessageSelectedHost />}
    </Suspense>
  )
}
