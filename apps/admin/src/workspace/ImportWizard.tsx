import { useCallback, useEffect, useRef, useState } from 'react'
import { DesktopOnlyNotice } from '@kms/ui/desktop-only'
import { ModalDialog, appConfirm } from '../components/dialogs'
import {
  ApiError,
  importBatchReportUrl,
  importCommit,
  importPreviewFile,
  importPreviewMapping,
  undoImportBatch,
  type ImportPlan,
  type ImportRowAction,
  type ImportSource,
  type ImportTarget,
} from '../api'
import { openDuplicatesPanel } from './contactMerge'
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

/** Workplan 11 §5.1/6: the wizard's first choice, shown before a file is picked. */
const SOURCE_GUIDANCE =
  'Export from Sessionboard via Options → Export in each module. Import People first, then Sessions, ' +
  'so speaker links resolve. Files without a Session ID column can be imported once, but re-running ' +
  'them will duplicate sessions.'

/** Exact text required at the undo confirm (§5.5): what undo does and does not revert. */
const UNDO_CONFIRM_TEXT =
  'Created records will be deleted; records that were updated or merged are not reverted.'

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

/**
 * Eval defect #13: dedupe on import is strictly by email, so re-importing the
 * same person under a different address used to silently create a second
 * contact with no signal at all. `plan.possibleDuplicates` (importer.ts) is
 * advisory only — it never blocks or changes what the import does — so this
 * just names the pairs and opens the org's existing Duplicates/merge panel
 * (the same "Merge instead?" entry point the speaker form's duplicate-name
 * warning already uses), rather than inventing a second review surface.
 */
export function ImportDuplicatesNotice({ plan, onMerged }: { plan: ImportPlan; onMerged: () => void }) {
  const dupes = plan.possibleDuplicates
  if (!dupes || dupes.length === 0) return null
  return (
    <div className="import-duplicates-notice" role="status">
      <p>
        <strong>
          {dupes.length} possible duplicate{dupes.length === 1 ? '' : 's'} by name
        </strong>{' '}
        — same name as {dupes.some((d) => d.matchContactId === null) ? 'another row in this file or ' : ''}an
        existing contact, but a different email. The import proceeds and creates them separately; review before
        merging, since legitimate namesakes exist too.
      </p>
      <ul className="import-duplicate-pairs">
        {dupes.slice(0, PREVIEW_LIMIT).map((d, i) => (
          <li key={`${d.row}-${i}`}>
            Row {d.row}: <strong>{d.label}</strong> <span className="detail-sub">({d.email})</span>
            {' ↔ '}
            <strong>{d.matchLabel}</strong> <span className="detail-sub">({d.matchEmail})</span>
            {d.matchContactId === null && <span className="detail-sub"> · also in this file</span>}
          </li>
        ))}
      </ul>
      <button type="button" className="settings-ghost" onClick={() => openDuplicatesPanel({ onMerged })}>
        Review in the Duplicates panel
      </button>
    </div>
  )
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
  /** Workplan 11: source profile, chosen before the file step and carried on
   *  every subsequent preview/commit call. */
  const [source, setSource] = useState<ImportSource>('generic')
  /** Workplan 11 (G8): the commit's batch id, once known — drives the report
   *  link and undo affordance shown alongside `result`. */
  const [batchId, setBatchId] = useState<string | null>(null)
  const [undoBusy, setUndoBusy] = useState(false)
  const [undoError, setUndoError] = useState<string | null>(null)
  const [undone, setUndone] = useState<{ submissions: number; event_contacts: number; submission_participants: number } | null>(null)
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
      setPlan(await importPreviewFile(request.target, request.eventId, file, source))
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
        await importPreviewMapping(request.target, request.eventId, plan.headers, plan.rows_raw, mapping, source),
      )
    })
  }

  const commit = () => {
    if (!plan) return
    void run(async () => {
      try {
        const res = await importCommit(
          request.target,
          request.eventId,
          plan.headers,
          plan.rows_raw,
          plan.mapping,
          source,
          // The dry run the user just confirmed: the server re-plans and
          // refuses (409 plan_changed) if the data moved underneath it, so a
          // commit can never silently do something other than the preview.
          plan.rows.map((row) => row.action),
        )
        setResult(res.applied)
        setBatchId(res.batchId)
        if ((res.applied.total ?? 0) - (res.applied.error ?? 0) - (res.applied.skip ?? 0) > 0) {
          request.onImported?.()
        }
      } catch (err) {
        if (err instanceof ApiError && err.details?.error === 'plan_changed') {
          // Refresh the dry run against the current data and keep the wizard
          // on the mapping step so the user confirms the NEW plan.
          setPlan(
            await importPreviewMapping(request.target, request.eventId, plan.headers, plan.rows_raw, plan.mapping, source),
          )
          throw new Error(
            'The data changed since the dry run, so nothing was imported. The preview below has been refreshed — check it and import again.',
          )
        }
        throw err
      }
    })
  }

  const undo = () => {
    if (!batchId) return
    void (async () => {
      const confirmed = await appConfirm(UNDO_CONFIRM_TEXT, { title: 'Undo import', confirmLabel: 'Undo', danger: true })
      if (!confirmed) return
      setUndoBusy(true)
      setUndoError(null)
      try {
        const res = await undoImportBatch(batchId, request.eventId)
        setUndone(res.undone)
        request.onImported?.()
      } catch (err) {
        setUndoError(err instanceof Error ? err.message : 'The undo failed.')
      } finally {
        setUndoBusy(false)
      }
    })()
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
          {batchId && (
            <div className="import-batch-outcome">
              <a
                href={importBatchReportUrl(batchId, request.eventId)}
                target="_blank"
                rel="noopener"
                className="import-report-link"
              >
                Download report (CSV)
              </a>
              {undone ? (
                <p className="import-note">
                  Undone: {undone.submissions} submission{undone.submissions === 1 ? '' : 's'},{' '}
                  {undone.event_contacts} contact{undone.event_contacts === 1 ? '' : 's'},{' '}
                  {undone.submission_participants} participant link{undone.submission_participants === 1 ? '' : 's'} removed.
                </p>
              ) : (
                <button type="button" onClick={undo} disabled={undoBusy}>
                  {undoBusy ? 'Undoing…' : 'Undo this import'}
                </button>
              )}
              {undoError && <div className="import-error" role="alert">{undoError}</div>}
            </div>
          )}
          {/* The dry run's flags still apply post-commit — the rows really
            * were created separately, not merged automatically. */}
          {plan && <ImportDuplicatesNotice plan={plan} onMerged={() => {}} />}
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
          <fieldset className="import-source-choice" disabled={busy}>
            <legend>Source</legend>
            <label>
              <input
                type="radio"
                name="import-source"
                value="generic"
                checked={source === 'generic'}
                onChange={() => setSource('generic')}
              />
              Spreadsheet (generic)
            </label>
            <label>
              <input
                type="radio"
                name="import-source"
                value="sessionboard"
                checked={source === 'sessionboard'}
                onChange={() => setSource('sessionboard')}
              />
              Import from Sessionboard
            </label>
          </fieldset>
          {source === 'sessionboard' && <p className="import-note">{SOURCE_GUIDANCE}</p>}
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
          {/* The possible-duplicates line also rides along in `plan.warnings`
            * (importer.ts) for callers/tests that only read that generic
            * list; filtered back out here so it isn't said twice — the richer
            * pairs-plus-Duplicates-panel notice below replaces it. */}
          {plan.warnings && plan.warnings.filter((w) => !w.includes('possible duplicate')).length > 0 && (
            <ul className="import-warnings" role="alert">
              {plan.warnings.filter((w) => !w.includes('possible duplicate')).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <ImportDuplicatesNotice
            plan={plan}
            onMerged={() =>
              // A merge from the Duplicates panel can turn what the dry run
              // called `create` into `merge`/`attach` (the row's email now
              // resolves to the surviving contact) — re-plan against the same
              // uploaded data/mapping rather than leaving a stale preview.
              void run(async () => {
                setPlan(
                  await importPreviewMapping(request.target, request.eventId, plan.headers, plan.rows_raw, plan.mapping, source),
                )
              })
            }
          />
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
