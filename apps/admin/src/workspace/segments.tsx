import { useEffect, useState } from 'react'
import { ModalDialog, appAlert, appConfirm } from '../components/dialogs'
import {
  createContactSegment,
  deleteContactSegment,
  listContactSegments,
  type SegmentRow,
} from '../api'
import { buildSegmentSavePayload } from './segments.logic'
import { navigate } from '../router'

/**
 * CRM-09: saved Speaker-roster segments. Two imperative panels, opened from
 * the Speakers tab toolbar exactly like the contact picker / duplicates
 * panels (contactMerge.tsx's doc comment has the reasoning — a toolbar
 * action is plain data inside `buildWorkspaceConfig` with nowhere to hang
 * React state, so the panel is opened by name and rendered once at the app
 * root via the Host component).
 *
 *  - `openSaveSegmentPanel` — "Save segment": names either the checked rows
 *    (curated) or the live filter set (dynamic).
 *  - `openSegmentsPanel` — lists saved segments; Open re-navigates the
 *    Speakers tab to that segment's filter (segment_id for curated, the
 *    frozen filters object for dynamic); Delete removes it.
 */

// ---------------------------------------------------------------------------
// Imperative open + host
// ---------------------------------------------------------------------------

export interface SaveSegmentPanelRequest {
  filters: Record<string, unknown>
  checkedIds: string[]
  onSaved?: () => void
}

export interface SegmentsPanelRequest {
  /** Fired once a segment's "Open" is clicked, after this panel has closed. */
  onOpen?: (segment: SegmentRow) => void
}

type PanelRequest =
  | { kind: 'save'; request: SaveSegmentPanelRequest }
  | { kind: 'list'; request: SegmentsPanelRequest }

let enqueue: ((entry: PanelRequest) => void) | null = null
const pending: PanelRequest[] = []

function submit(entry: PanelRequest): void {
  if (enqueue) enqueue(entry)
  else pending.push(entry)
}

/** Opens the "Save segment" dialog for the Speakers tab's current filters/checked rows. */
export function openSaveSegmentPanel(request: SaveSegmentPanelRequest): void {
  submit({ kind: 'save', request })
}

/** Opens the saved-segments list panel. */
export function openSegmentsPanel(request: SegmentsPanelRequest = {}): void {
  submit({ kind: 'list', request })
}

/** Renders once at the app root; services openSaveSegmentPanel/openSegmentsPanel requests. */
export function SegmentsHost() {
  const [queue, setQueue] = useState<PanelRequest[]>([])
  const current = queue[0] ?? null

  useEffect(() => {
    enqueue = (entry) => setQueue((q) => [...q, entry])
    if (pending.length > 0) setQueue((q) => [...q, ...pending.splice(0, pending.length)])
    return () => {
      enqueue = null
    }
  }, [])

  const close = () => setQueue((q) => q.slice(1))

  if (!current) return null
  if (current.kind === 'save') {
    return <SaveSegmentDialog key={queue.length} request={current.request} onClose={close} />
  }
  return <SegmentsListPanel key={queue.length} request={current.request} onClose={close} />
}

// ---------------------------------------------------------------------------
// Save dialog
// ---------------------------------------------------------------------------

function SaveSegmentDialog({ request, onClose }: { request: SaveSegmentPanelRequest; onClose: () => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const kind = request.checkedIds.length > 0 ? 'curated' : 'dynamic'
  const summary =
    kind === 'curated'
      ? `${request.checkedIds.length} checked ${request.checkedIds.length === 1 ? 'row' : 'rows'} — frozen as-is, membership won't change if the roster does.`
      : "the roster's current filters — reruns them each time the segment is opened."

  const save = async () => {
    if (!name.trim()) {
      setError('Name is required.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const payload = buildSegmentSavePayload(name, request.filters, request.checkedIds)
      await createContactSegment(payload)
      request.onSaved?.()
      onClose()
      void appAlert(`Segment “${payload.name}” saved.`, 'Segment saved')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The segment failed to save.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalDialog
      open
      width="sm"
      title="Save segment"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <label htmlFor="segment-name">Name</label>
      <input
        id="segment-name"
        type="text"
        value={name}
        maxLength={120}
        autoFocus
        onChange={(e) => setName((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
        }}
      />
      <p className="settings-hint">
        Saves {kind === 'curated' ? 'a curated list' : 'a dynamic filter'}: {summary}
      </p>
      {error && <div className="settings-error" role="alert">{error}</div>}
    </ModalDialog>
  )
}

// ---------------------------------------------------------------------------
// List panel
// ---------------------------------------------------------------------------

function parseFilters(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function memberCount(raw: string | null): number {
  if (!raw) return 0
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}

function summarize(segment: SegmentRow): string {
  if (segment.kind === 'curated') {
    const n = memberCount(segment.member_ids)
    return `${n} ${n === 1 ? 'member' : 'members'}`
  }
  const filters = parseFilters(segment.filters)
  const keys = Object.keys(filters)
  return keys.length === 0 ? 'no filters' : keys.map((k) => `${k}=${String(filters[k])}`).join(', ')
}

function SegmentsListPanel({ request, onClose }: { request: SegmentsPanelRequest; onClose: () => void }) {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; items: SegmentRow[] }
  >({ status: 'loading' })

  const load = () => {
    setState({ status: 'loading' })
    void listContactSegments().then(
      (res) => setState({ status: 'ready', items: res.items }),
      (err) => setState({ status: 'error', message: err instanceof Error ? err.message : 'Segments failed to load.' }),
    )
  }

  useEffect(load, [])

  const openSegment = (segment: SegmentRow) => {
    request.onOpen?.(segment)
    onClose()
    navigate({
      v: 'workspace',
      tab: 'speakers',
      flt: segment.kind === 'curated' ? { segment_id: segment.id } : parseFilters(segment.filters),
    })
  }

  const remove = async (segment: SegmentRow) => {
    const confirmed = await appConfirm(`Delete the segment “${segment.name}”? This does not touch the speakers themselves.`, {
      title: 'Delete segment',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!confirmed) return
    await deleteContactSegment(segment.id)
    load()
  }

  return (
    <ModalDialog open width="md" title="Saved segments" onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
      {state.status === 'loading' ? (
        <div className="settings-hint">Loading…</div>
      ) : state.status === 'error' ? (
        <div className="settings-error" role="alert">{state.message}</div>
      ) : state.items.length === 0 ? (
        <div className="settings-hint">No saved segments yet — check some rows or set filters, then “Save segment”.</div>
      ) : (
        <ul className="merge-pairs">
          {state.items.map((segment) => (
            <li key={segment.id}>
              <div className="merge-pair-row">
                <span className={`merge-tier merge-tier-${segment.kind === 'curated' ? 'strong' : 'weak'}`}>
                  {segment.kind === 'curated' ? 'Curated' : 'Dynamic'}
                </span>
                <span className="merge-pair-names">
                  <strong>{segment.name}</strong>
                  <span className="detail-sub"> · {summarize(segment)}</span>
                </span>
                <button type="button" onClick={() => openSegment(segment)}>Open</button>
                <button type="button" onClick={() => void remove(segment)}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </ModalDialog>
  )
}
