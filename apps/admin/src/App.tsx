import { useEffect, useMemo, useState } from 'react'
import { DataTabManager, TabConfig } from './components/DataTabManager'
import {
  createContact,
  deleteContact,
  getMe,
  queryResource,
  switchEvent,
  updateContact,
  type ContactRow,
  type Me,
  type SubmissionRow,
} from './api'
import './shell.css'

/**
 * Admin SPA shell (docs/12 M0.5): slim sidebar + event switcher around the tab
 * workspace. Only Workspace is live; the other sections arrive with their
 * milestones (Forms M1, Evaluation M3, Agenda M4, Dashboard M5, Settings M6).
 */

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', soon: 'M5' },
  { key: 'workspace', label: 'Workspace', soon: null },
  { key: 'forms', label: 'Forms', soon: 'M1' },
  { key: 'evaluation', label: 'Evaluation', soon: 'M3' },
  { key: 'agenda', label: 'Agenda', soon: 'M4' },
  { key: 'settings', label: 'Settings', soon: 'M6' },
] as const

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
function buildWorkspaceConfig(): Record<string, TabConfig> {
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
    // Anchor a speaker → other tabs receive contact_id; anchor a submission →
    // this tab narrows to its participants (docs/12 §0).
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

  const submissions: TabConfig<SubmissionRow> = {
    displayTitle: 'Submissions',
    dataSource: queryResource<SubmissionRow>('submissions'),
    getItemId: (item) => item.id,
    titleField: 'title',
    initialSort: { field: 'created_at', direction: 'desc' },
    columns: [
      { field: 'code', header: 'Code', width: '84px', mobileHidden: true },
      { field: 'title', header: 'Title', width: '2.5fr', sortable: true },
      {
        field: 'status',
        header: 'Status',
        width: '110px',
        sortable: true,
        render: (value: string) => <StatusChip status={value} />,
      },
      { field: 'format', header: 'Format', width: '100px', sortable: true, mobileHidden: true },
      { field: 'track_name', header: 'Track', sortable: true, mobileRow: 2 },
      { field: 'submitter_name', header: 'Submitter', sortable: true, mobileRow: 2 },
      {
        field: 'created_at',
        header: 'Submitted',
        width: '100px',
        sortable: true,
        mobileHidden: true,
        render: (value: string) => fmtDate(value),
      },
    ],
    detailComponent: ({ item }) => (
      <div className="detail-panel">
        <h2>{item.title}</h2>
        <div className="detail-sub">
          {item.code} · <StatusChip status={item.status} />
        </div>
        <dl>
          {item.format && <><dt>Format</dt><dd>{item.format}</dd></>}
          {item.track_name && <><dt>Track</dt><dd>{item.track_name}</dd></>}
          {item.level && <><dt>Level</dt><dd>{item.level}</dd></>}
          {item.language && <><dt>Language</dt><dd>{item.language}</dd></>}
          {item.submitter_name && <><dt>Submitter</dt><dd>{item.submitter_name}</dd></>}
          <dt>Submitted</dt><dd>{fmtDate(item.created_at)}</dd>
        </dl>
        {item.description && <div className="detail-body">{stripHtml(item.description)}</div>}
      </div>
    ),
    // Anchor a submission → Speakers shows its participants; anchor a speaker
    // → this tab narrows to submissions they submitted or speak on.
    globalFilterSets: { id: 'submission_id' },
    globalFilterReceives: { contact_id: 'contact_id' },
  }

  return {
    speakers: speakers as TabConfig,
    submissions: submissions as TabConfig,
  }
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [view, setView] = useState<(typeof NAV_ITEMS)[number]['key']>('workspace')
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    getMe()
      .then(setMe)
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Failed to load'))
  }, [])

  const workspaceConfig = useMemo(buildWorkspaceConfig, [])

  const handleSwitchEvent = async (eventId: string) => {
    if (!me || eventId === me.event.id) return
    setSwitching(true)
    try {
      await switchEvent(eventId)
      window.location.reload()
    } catch {
      setSwitching(false)
    }
  }

  if (loadError) {
    return <div className="shell"><div className="shell-error">{loadError}</div></div>
  }
  if (!me) {
    return <div className="shell"><div className="shell-loading">Loading…</div></div>
  }

  return (
    <div className="shell">
      <aside className="shell-sidebar">
        <div className="shell-brand">
          KMS <span className="shell-brand-sub">admin</span>
        </div>
        <div className="shell-event">
          <select
            aria-label="Event"
            value={me.event.id}
            disabled={switching || me.events.length < 2}
            onChange={(e) => void handleSwitchEvent(e.target.value)}
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
          {NAV_ITEMS.map((item) => (
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
      <main className="shell-main">
        {view === 'workspace' ? (
          <DataTabManager config={workspaceConfig} defaultTabs={['speakers', 'submissions']} />
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
