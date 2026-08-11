import { useCallback, useEffect, useRef, useState } from 'react'
import { DesktopOnlyNotice } from '@kms/ui/desktop-only'
import { ModalDialog } from '../components/dialogs'
import {
  importCommit,
  importPreviewFile,
  importPreviewMapping,
  type ImportPlan,
  type ImportRowAction,
  type ImportTarget,
} from '../api'
import './import.css'

/**
 * The FR-REV-8 import wizard (docs/06 §6): file → column mapping → dry run →
 * commit, for sessions and for speakers off the same machinery.
 *
 * Opened imperatively (`openImportWizard`) rather than as a rendered child,
 * for the same reason `appConfirm` is: the entry points are buttons inside
 * `buildWorkspaceConfig`'s tab definitions, which are plain data — they have
 * nowhere to hang React state. `ImportWizardHost` renders once at the app root
 * (main.tsx, beside `DialogHost`) and services the request.
 *
 * The mapping and the dry run share one step on purpose. Auto-mapping is right
 * most of the time, so the useful thing to show first is the *consequence* —
 * "12 create, 3 merge, 1 error" with per-row reasons — with the mapping
 * selects sitting directly above it, each change re-running the dry run.
 */

export interface ImportRequest {
  target: ImportTarget
  eventId: string
  eventName: string
  /** Called after a commit that changed something, so the grid can refetch. */
  onImported?: () => void
}

const TARGET_LABEL: Record<ImportTarget, string> = {
  sessions: 'sessions',
  contacts: 'speakers',
}

const ACTION_LABEL: Record<ImportRowAction, string> = {
  create: 'Create',
  update: 'Update',
  merge: 'Merge',
  // Already in the organisation from another event: no contact is created, the
  // person joins this event's roster (0015).
  attach: 'Add to event',
  skip: 'Skip',
  error: 'Error',
}

/** Rows rendered in the preview; the rest are summarised by the counts. */
const PREVIEW_LIMIT = 100

let enqueue: ((request: ImportRequest) => void) | null = null
const pending: ImportRequest[] = []

/** Opens the wizard; resolves when it closes (`true` if anything was written). */
export function openImportWizard(request: ImportRequest): void {
  if (enqueue) enqueue(request)
  else pending.push(request)
}

function summaryLine(plan: ImportPlan): string {
  const parts: string[] = []
  for (const action of ['create', 'update', 'merge', 'attach', 'skip', 'error'] as const) {
    const n = plan.summary[action] ?? 0
    if (n > 0) parts.push(`${n} ${action === 'error' ? (n === 1 ? 'error' : 'errors') : action}`)
  }
  return parts.length > 0 ? parts.join(' · ') : 'nothing to import'
}

function ImportWizard({ request, onClose }: { request: ImportRequest; onClose: () => void }) {
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Record<string, number> | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const label = TARGET_LABEL[request.target]

  const run = useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true)
      setError(null)
      try {
        await work()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The import failed.')
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const onFile = (file: File | null) => {
    if (!file) return
    void run(async () => {
      setPlan(await importPreviewFile(request.target, request.eventId, file))
    })
  }

  const remap = (columnIndex: number, fieldKey: string) => {
    if (!plan) return
    const mapping = plan.mapping.map((key, i) => {
      if (i === columnIndex) return fieldKey
      // A field maps to at most one column: picking it here releases it there.
      return fieldKey && key === fieldKey ? '' : key
    })
    void run(async () => {
      setPlan(
        await importPreviewMapping(request.target, request.eventId, plan.headers, plan.rows_raw, mapping),
      )
    })
  }

  const commit = () => {
    if (!plan) return
    void run(async () => {
      const res = await importCommit(
        request.target,
        request.eventId,
        plan.headers,
        plan.rows_raw,
        plan.mapping,
      )
      setResult(res.applied)
      if ((res.applied.total ?? 0) - (res.applied.error ?? 0) - (res.applied.skip ?? 0) > 0) {
        request.onImported?.()
      }
    })
  }

  const writable = plan ? (plan.summary.create ?? 0) + (plan.summary.update ?? 0) + (plan.summary.merge ?? 0) : 0

  return (
    <ModalDialog
      open
      width="lg"
      title={`Import ${label}`}
      onClose={onClose}
      dismissable={!busy}
      footer={
        result ? (
          <button className="primary" onClick={onClose}>Done</button>
        ) : (
          <>
            <button onClick={onClose} disabled={busy}>Cancel</button>
            {plan && (
              <>
                {/* Below compact the mapping and its dry run are refused, so
                    committing would be committing blind — Cancel is the only
                    action the panel offers and the only one left here. */}
                <button className="kms-wide-only" onClick={() => setPlan(null)} disabled={busy}>Choose another file</button>
                <button className="primary kms-wide-only" onClick={commit} disabled={busy || writable === 0}>
                  {writable === 0 ? 'Nothing to import' : `Import ${writable} row${writable === 1 ? '' : 's'}`}
                </button>
              </>
            )}
          </>
        )
      }
    >
      {error && <div className="import-error" role="alert">{error}</div>}

      {result ? (
        <div className="import-done" role="status">
          <p>
            Imported into <strong>{request.eventName}</strong>: {result.create ?? 0} created,{' '}
            {result.update ?? 0} updated, {result.merge ?? 0} merged, {result.skip ?? 0} skipped,{' '}
            {result.error ?? 0} with errors.
          </p>
        </div>
      ) : !plan ? (
        <div className="import-file-step">
          <p>
            Upload a CSV or XLSX of {label}. The first row must be the header row. Columns are
            matched to fields automatically on the next step, where you can correct any of them
            before anything is written.
          </p>
          <p className="import-scope">
            Target event: <strong>{request.eventName}</strong>
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={busy}
            aria-label={`${label} file`}
            onChange={(e) => onFile(e.currentTarget.files?.[0] ?? null)}
          />
          {busy && <p className="import-busy">Reading the file…</p>}
        </div>
      ) : (
        <>
        {/*
          * Tier C refusal (docs/16 item 7): matching a spreadsheet's columns
          * to fields is a two-column mapping over the whole file — the
          * "arrange many records" side of the line. The file-pick and done
          * steps are left alone. CSS-only gate.
          */}
        <div className="kms-compact-only">
          <DesktopOnlyNotice
            title="Column mapping needs a wider window."
            message="Matching every column in your file to a field needs two columns side by side. Pick the file up again on a laptop."
            summary={
              <dl className="import-compact-summary">
                <dt>Rows</dt>
                <dd>{plan.rows.length === 1 ? '1 row' : `${plan.rows.length} rows`}</dd>
                <dt>Columns detected</dt>
                <dd>{plan.headers.join(', ')}</dd>
              </dl>
            }
            action={{ label: 'Cancel import', onClick: onClose }}
          />
        </div>
        <div className="import-map-step kms-wide-only">
          <h4>Columns</h4>
          <div className="import-mapping">
            {plan.headers.map((header, i) => (
              <label key={`${header}-${i}`} className="import-mapping-row">
                <span className="import-column-name" title={header}>{header}</span>
                <select
                  value={plan.mapping[i] ?? ''}
                  disabled={busy}
                  onChange={(e) => remap(i, e.currentTarget.value)}
                  aria-label={`Field for column ${header}`}
                >
                  <option value="">— ignore —</option>
                  {plan.fields.map((field) => (
                    <option key={field.key} value={field.key}>
                      {field.label}{field.required ? ' *' : ''}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <h4>
            Dry run <span className="import-summary">{summaryLine(plan)}</span>
          </h4>
          {(plan.newTracks.length > 0 || plan.newRooms.length > 0) && (
            <p className="import-note">
              Names not already in this event will be created:{' '}
              {[...plan.newTracks.map((t) => `track “${t}”`), ...plan.newRooms.map((r) => `room “${r}”`)].join(', ')}.
            </p>
          )}
          <div className="import-preview" role="region" aria-label="Dry-run preview">
            <table>
              <thead>
                <tr><th scope="col">Row</th><th scope="col">Action</th><th scope="col">Record</th><th scope="col">Detail</th></tr>
              </thead>
              <tbody>
                {plan.rows.slice(0, PREVIEW_LIMIT).map((row) => (
                  <tr key={row.row} className={`import-row-${row.action}`}>
                    <td>{row.row}</td>
                    <td><span className={`import-badge import-badge-${row.action}`}>{ACTION_LABEL[row.action]}</span></td>
                    <td>{row.label}</td>
                    <td>{row.errors.length > 0 ? row.errors.join('; ') : row.message ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {plan.rows.length > PREVIEW_LIMIT && (
              <p className="import-note">…and {plan.rows.length - PREVIEW_LIMIT} more rows.</p>
            )}
          </div>
        </div>
        </>
      )}
    </ModalDialog>
  )
}

/** Renders once at the app root; services `openImportWizard` requests. */
export function ImportWizardHost() {
  const [queue, setQueue] = useState<ImportRequest[]>([])
  const current = queue[0] ?? null

  useEffect(() => {
    enqueue = (request) => setQueue((q) => [...q, request])
    if (pending.length > 0) {
      setQueue((q) => [...q, ...pending.splice(0, pending.length)])
    }
    return () => {
      enqueue = null
    }
  }, [])

  if (!current) return null
  return (
    <ImportWizard
      key={`${current.target}:${current.eventId}:${queue.length}`}
      request={current}
      onClose={() => setQueue((q) => q.slice(1))}
    />
  )
}
