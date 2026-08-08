import { useCallback, useEffect, useMemo, useState } from 'react'
import { DataTabManager, TabConfig } from './components/DataTabManager'
import {
  bulkStatus,
  createContact,
  deleteContact,
  getMe,
  queryResource,
  sendDecisions,
  switchEvent,
  updateContact,
  updateSubmissionStatus,
  type ContactRow,
  type Me,
  type MessageRow,
  type SubmissionRow,
  type TaskAssignmentRow,
} from './api'
import { FormsSection } from './forms/FormsSection'
import { EvaluationSection } from './evaluation/EvaluationSection'
import { AgendaSection } from './agenda/AgendaSection'
import { ReviewerWorkspace } from './review/ReviewerWorkspace'
import {
  BulkBar,
  StatusChipsFilter,
  SubmissionDetailPanel,
  SUBMISSION_STATUSES,
  statusLabel,
} from './workspace/extras'
import './shell.css'

/**
 * Admin SPA shell (docs/12 M0.5→M3): slim sidebar + event switcher around the
 * tab workspace, Forms, Evaluation and the reviewer workspace. Reviewers see
 * only Review; everything else needs the admin role (enforced server-side too).
 */

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', soon: 'M5' },
  { key: 'workspace', label: 'Workspace', soon: null },
  { key: 'forms', label: 'Forms', soon: null },
  { key: 'evaluation', label: 'Evaluation', soon: null },
  { key: 'review', label: 'Review', soon: null },
  { key: 'agenda', label: 'Agenda', soon: null },
  { key: 'settings', label: 'Settings', soon: 'M6' },
] as const

type ViewKey = (typeof NAV_ITEMS)[number]['key']

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const contactName = (c: ContactRow): string =>
  [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email

const stripHtml = (html: string): string => {
  const el = document.createElement('div')
  el.innerHTML = html
  return el.textContent ?? ''
}

const StatusChip = ({ status }: { status: string }) => (
  <span className={`status-chip status-${status}`}>{status.replace(/_/g, ' ')}</span>
)

const speakerSchema = {
  type: 'object',
  required: ['email'],
  properties: {
    first_name: { type: 'string', title: 'First name' },
    last_name: { type: 'string', title: 'Last name' },
    email: { type: 'string', format: 'email', title: 'Email' },
    company: { type: 'string', title: 'Company' },
    job_title: { type: 'string', title: 'Job title' },
    mobile_phone: { type: 'string', title: 'Mobile phone' },
    pronouns: { type: 'string', title: 'Pronouns' },
    biography: { type: 'string', format: 'textarea', title: 'Biography' },
  },
}

/** Workspace tab configs against the Worker's generic query endpoints. */
function buildWorkspaceConfig(
  onChecklist: (ids: string[]) => void,
  checklistResetKey: number,
): Record<string, TabConfig> {
  const speakers: TabConfig<ContactRow> = {
    displayTitle: 'Speakers',
    dataSource: queryResource<ContactRow>('contacts'),
    getItemId: (item) => item.id,
    getItemTitle: contactName,
    columns: [
      { field: 'first_name', header: 'First name', sortable: true },
      { field: 'last_name', header: 'Last name', sortable: true },
      { field: 'email', header: 'Email', width: '1.5fr', sortable: true, mobileRow: 2 },
      { field: 'company', header: 'Company', sortable: true },
      { field: 'job_title', header: 'Job title', mobileHidden: true },
    ],
    detailComponent: ({ item, onEdit }) => (
      <div className="detail-panel">
        <h2>{contactName(item)}</h2>
        <div className="detail-sub">{item.job_title ? `${item.job_title} · ` : ''}{item.company ?? ''}</div>
        <dl>
          <dt>Email</dt><dd>{item.email}</dd>
          {item.mobile_phone && <><dt>Mobile</dt><dd>{item.mobile_phone}</dd></>}
          {item.pronouns && <><dt>Pronouns</dt><dd>{item.pronouns}</dd></>}
          <dt>Created</dt><dd>{fmtDate(item.created_at)}</dd>
        </dl>
        {item.biography && <div className="detail-body">{stripHtml(item.biography)}</div>}
        {onEdit && (
          <div className="detail-actions">
            <button onClick={onEdit}>Edit</button>
          </div>
        )}
      </div>
    ),
    globalFilterSets: { id: 'contact_id' },
    globalFilterReceives: { submission_id: 'submission_id' },
    schema: speakerSchema,
    onUpsert: async (data, existing?: ContactRow) =>
      existing ? updateContact(existing.id, data) : createContact(data),
    onDelete: async (item) => {
      if (!window.confirm(`Delete ${contactName(item)}? Their submissions remain, unattributed.`)) {
        return false
      }
      await deleteContact(item.id)
      return true
    },
  }

  const submissions: TabConfig<SubmissionRow & { rating: number | null; notified_at: string | null; review_count: number }> = {
    displayTitle: 'Submissions',
    dataSource: queryResource('submissions'),
    getItemId: (item) => item.id,
    titleField: 'title',
    initialSort: { field: 'created_at', direction: 'desc' },
    filterConfig: {
      initialFilters: { status: '' },
      FilterComponent: StatusChipsFilter,
    },
    onChecklist,
    checklistResetKey,
    columns: [
      { field: 'code', header: 'Code', width: '84px', mobileHidden: true },
      { field: 'title', header: 'Title', width: '2.5fr', sortable: true },
      {
        field: 'status',
        header: 'Status',
        width: '128px',
        sortable: true,
        editable: true,
        editRenderer: ({ value, onChange }) => (
          <select
            className={`status-edit status-chip status-${String(value)}`}
            value={String(value)}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onChange(e.target.value)}
            aria-label="Status"
          >
            {SUBMISSION_STATUSES.map((s) => (
              <option key={s} value={s}>{statusLabel(s)}</option>
            ))}
          </select>
        ),
        onChange: (change) => {
          void updateSubmissionStatus((change.item as { id: string }).id, String(change.value))
        },
      },
      {
        field: 'rating',
        header: 'Rating',
        width: '80px',
        sortable: true,
        render: (value: number | null, item) =>
          value === null ? (
            <span style={{ color: 'var(--text-faint)' }}>—</span>
          ) : (
            <span title={`${item.review_count} review${item.review_count === 1 ? '' : 's'}`}>★ {value}</span>
          ),
      },
      {
        field: 'notified_at',
        header: 'Notified',
        width: '76px',
        sortable: true,
        mobileHidden: true,
        render: (value: string | null) => (value ? '✓' : ''),
      },
      { field: 'format', header: 'Format', width: '100px', sortable: true, mobileHidden: true },
      { field: 'track_name', header: 'Track', sortable: true, mobileRow: 2 },
      { field: 'submitter_name', header: 'Submitter', sortable: true, mobileRow: 2 },
    ],
    detailComponent: ({ item }) => <SubmissionDetailPanel id={item.id} />,
    globalFilterSets: { id: 'submission_id' },
    globalFilterReceives: { contact_id: 'contact_id' },
  }

  const tasks: TabConfig<TaskAssignmentRow> = {
    displayTitle: 'Tasks',
    dataSource: queryResource<TaskAssignmentRow>('tasks'),
    getItemId: (item) => item.id,
    getItemTitle: (item) => item.task_title,
    columns: [
      { field: 'task_title', header: 'Task', width: '1.6fr', sortable: true },
      { field: 'assignee_name', header: 'Assignee', sortable: true },
      { field: 'submission_code', header: 'For', width: '80px', mobileHidden: true },
      {
        field: 'status',
        header: 'Status',
        width: '110px',
        sortable: true,
        render: (value: string) => <StatusChip status={value} />,
      },
      {
        field: 'due_at',
        header: 'Due',
        width: '100px',
        sortable: true,
        render: (value: string | null, item) => {
          if (!value) return ''
          const overdue = item.status !== 'complete' && new Date(value).getTime() < Date.now()
          return <span style={overdue ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>{fmtDate(value)}</span>
        },
      },
      {
        field: 'completed_at',
        header: 'Completed',
        width: '100px',
        sortable: true,
        mobileHidden: true,
        render: (value: string | null) => fmtDate(value),
      },
    ],
    detailComponent: ({ item }) => (
      <div className="detail-panel">
        <h2>
          {item.task_title} <StatusChip status={item.status} />
        </h2>
        <div className="detail-sub">{item.action_type}{item.required === 1 ? ' · required' : ''}</div>
        <dl>
          <dt>Assignee</dt><dd>{item.assignee_name ?? item.assignee_email}</dd>
          {item.submission_code && <><dt>Submission</dt><dd>{item.submission_code} — {item.submission_title}</dd></>}
          {item.due_at && <><dt>Due</dt><dd>{fmtDate(item.due_at)}</dd></>}
          {item.completed_at && <><dt>Completed</dt><dd>{fmtDate(item.completed_at)}</dd></>}
        </dl>
      </div>
    ),
    // Receive both anchors (docs/12 M3); anchoring a task narrows other tabs
    // to its assignee.
    globalFilterSets: { contact_id: 'contact_id' },
    globalFilterReceives: { contact_id: 'contact_id', submission_id: 'submission_id' },
  }

  const messages: TabConfig<MessageRow> = {
    displayTitle: 'Messages',
    dataSource: queryResource<MessageRow>('messages'),
    getItemId: (item) => item.id,
    getItemTitle: (item) => item.subject ?? item.template_key ?? item.id,
    initialSort: { field: 'created_at', direction: 'desc' },
    columns: [
      {
        field: 'created_at',
        header: 'Queued',
        width: '130px',
        sortable: true,
        render: (value: string) => {
          const d = new Date(value)
          return Number.isNaN(d.getTime())
            ? value
            : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        },
      },
      { field: 'template_key', header: 'Template', width: '150px', sortable: true },
      { field: 'to_email', header: 'To', width: '1.2fr', sortable: true, mobileRow: 2 },
      { field: 'subject', header: 'Subject', width: '2fr' },
      {
        field: 'status',
        header: 'Status',
        width: '90px',
        sortable: true,
        render: (value: string) => <span className={`status-chip status-${value}`}>{value}</span>,
      },
    ],
    detailComponent: ({ item }) => (
      <div className="detail-panel">
        <h2>{item.subject ?? '(no subject)'}</h2>
        <div className="detail-sub">
          {item.template_key} · <span className={`status-chip status-${item.status}`}>{item.status}</span>
        </div>
        <dl>
          <dt>To</dt><dd>{item.contact_name ? `${item.contact_name} <${item.to_email}>` : item.to_email}</dd>
          <dt>Queued</dt><dd>{new Date(item.created_at).toLocaleString()}</dd>
          {item.sent_at && <><dt>Sent</dt><dd>{new Date(item.sent_at).toLocaleString()}</dd></>}
          {item.error && <><dt>Error</dt><dd>{item.error}</dd></>}
        </dl>
      </div>
    ),
    globalFilterReceives: { contact_id: 'contact_id' },
  }

  return {
    speakers: speakers as TabConfig,
    submissions: submissions as TabConfig,
    tasks: tasks as TabConfig,
    messages: messages as TabConfig,
  }
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [view, setView] = useState<ViewKey>('workspace')
  const [switching, setSwitching] = useState(false)

  // Bulk-action state (docs/06 §5): checks come up from the Submissions tab.
  const [checkedIds, setCheckedIds] = useState<string[]>([])
  const [checklistResetKey, setChecklistResetKey] = useState(0)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkNote, setBulkNote] = useState<string | null>(null)

  useEffect(() => {
    getMe()
      .then((m) => {
        setMe(m)
        if (m.role === 'reviewer') setView('review')
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Failed to load'))
  }, [])

  const handleChecklist = useCallback((ids: string[]) => {
    setCheckedIds(ids)
    setBulkNote(null)
  }, [])

  // Rebuilding on checklistResetKey both clears checks and refetches lists —
  // exactly what a bulk action needs.
  const workspaceConfig = useMemo(
    () => buildWorkspaceConfig(handleChecklist, checklistResetKey),
    [handleChecklist, checklistResetKey],
  )

  const runBulk = useCallback(
    async (action: 'accept_queue' | 'decline_queue' | 'pending' | 'send_decisions') => {
      if (checkedIds.length === 0) return
      setBulkBusy(true)
      try {
        if (action === 'send_decisions') {
          const r = await sendDecisions(checkedIds)
          setBulkNote(
            `${r.accepted} accepted, ${r.declined} declined, ${r.tasks_assigned} tasks assigned` +
              (r.skipped > 0 ? `, ${r.skipped} skipped (not in a queue)` : ''),
          )
        } else {
          const r = await bulkStatus(checkedIds, action)
          setBulkNote(`${r.changed} moved to ${statusLabel(action)}`)
        }
        setCheckedIds([])
        setChecklistResetKey((k) => k + 1)
      } catch (e) {
        setBulkNote(e instanceof Error ? e.message : 'Action failed')
      } finally {
        setBulkBusy(false)
      }
    },
    [checkedIds],
  )

  if (loadError) {
    return <div className="shell"><div className="shell-error">{loadError}</div></div>
  }
  if (!me) {
    return <div className="shell"><div className="shell-loading">Loading…</div></div>
  }

  const isReviewer = me.role === 'reviewer'
  const navItems = isReviewer ? NAV_ITEMS.filter((i) => i.key === 'review') : NAV_ITEMS

  return (
    <div className="shell">
      <aside className="shell-sidebar">
        <div className="shell-brand">
          KMS <span className="shell-brand-sub">{isReviewer ? 'review' : 'admin'}</span>
        </div>
        <div className="shell-event">
          <select
            aria-label="Event"
            value={me.event.id}
            disabled={switching || me.events.length < 2}
            onChange={(e) => {
              if (!me || e.target.value === me.event.id) return
              setSwitching(true)
              switchEvent(e.target.value)
                .then(() => window.location.reload())
                .catch(() => setSwitching(false))
            }}
          >
            {(me.events.length > 0 ? me.events : [me.event]).map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
          <div className="shell-event-dates">
            {fmtDate(me.event.starts_at)} – {fmtDate(me.event.ends_at)}
          </div>
        </div>
        <nav className="shell-nav" aria-label="Sections">
          {navItems.map((item) => (
            <button
              key={item.key}
              className={view === item.key ? 'active' : ''}
              disabled={item.soon !== null}
              title={item.soon ? `Arrives with ${item.soon}` : undefined}
              onClick={() => setView(item.key)}
            >
              {item.label}
              {item.soon && <span className="shell-nav-soon">{item.soon}</span>}
            </button>
          ))}
        </nav>
        <div className="shell-footer">
          <div className="shell-user" title={me.email}>{me.email}</div>
          <a href={`/portal/${me.event.slug}`}>Portal</a>
          <a href="/auth/logout">Log out</a>
        </div>
      </aside>
      <main className="shell-main" style={{ position: 'relative' }}>
        {view === 'workspace' && !isReviewer ? (
          <>
            <DataTabManager
              config={workspaceConfig}
              defaultTabs={['speakers', 'submissions', 'tasks', 'messages']}
            />
            {(checkedIds.length > 0 || bulkNote !== null) && (
              <BulkBar
                count={checkedIds.length}
                busy={bulkBusy}
                note={bulkNote}
                onAction={(a) => void runBulk(a)}
                onClear={() => {
                  setCheckedIds([])
                  setBulkNote(null)
                  setChecklistResetKey((k) => k + 1)
                }}
              />
            )}
          </>
        ) : view === 'forms' && !isReviewer ? (
          <FormsSection eventSlug={me.event.slug} />
        ) : view === 'evaluation' && !isReviewer ? (
          <EvaluationSection />
        ) : view === 'agenda' && !isReviewer ? (
          <AgendaSection />
        ) : view === 'review' ? (
          <ReviewerWorkspace />
        ) : (
          <div className="shell-placeholder">
            <h2>{NAV_ITEMS.find((i) => i.key === view)?.label}</h2>
            <p>This section arrives with a later milestone.</p>
          </div>
        )}
      </main>
    </div>
  )
}
