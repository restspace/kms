import type { CSSProperties } from 'react'
import { DataTabManager, TabConfig } from './components/DataTabManager'
import type { DataSourceParams, DataSourceResult } from './components/DataList'

/**
 * Demo wiring for the pulled-in tab infrastructure (DataTabManager/DataList),
 * using in-memory KMS-shaped data. The real admin SPA (M1+) replaces the data
 * sources with fetches against the Worker API and drives filters server-side.
 *
 * Try: click rows to select; shift+click a speaker to make it the global
 * filter (submissions narrow to theirs); double-click to edit; right-click for
 * the context menu; "+" to create.
 */

interface Contact {
  id: string
  first_name: string
  last_name: string
  email: string
  company: string
}

interface Submission {
  id: string
  code: string
  title: string
  status: string
  submitter_contact_id: string
}

const contacts: Contact[] = [
  { id: 'c1', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', company: 'Analytical Engines' },
  { id: 'c2', first_name: 'Grace', last_name: 'Hopper', email: 'grace@example.com', company: 'US Navy' },
  { id: 'c3', first_name: 'Edsger', last_name: 'Dijkstra', email: 'edsger@example.com', company: 'THE' },
]

const submissions: Submission[] = [
  { id: 's1', code: 'SUB-001', title: 'Notes on the Analytical Engine', status: 'accepted', submitter_contact_id: 'c1' },
  { id: 's2', code: 'SUB-002', title: 'Compilers for Humans', status: 'pending', submitter_contact_id: 'c2' },
  { id: 's3', code: 'SUB-003', title: 'Nanoseconds, Visualised', status: 'accepted', submitter_contact_id: 'c2' },
  { id: 's4', code: 'SUB-004', title: 'Goto Considered Harmful', status: 'declined', submitter_contact_id: 'c3' },
  { id: 's5', code: 'SUB-005', title: 'Structured Programming', status: 'draft', submitter_contact_id: 'c3' },
]

/** In-memory data source applying simple field-equality filters. */
const memorySource = <T extends Record<string, unknown>>(rows: T[]) =>
  async ({ from, size, filters, sort }: DataSourceParams): Promise<DataSourceResult<T>> => {
    let result = rows.filter((row) =>
      Object.entries(filters).every(([field, value]) =>
        value === undefined || value === null || value === '' || row[field] === value
      )
    )
    if (sort) {
      const dir = sort.direction === 'asc' ? 1 : -1
      result = [...result].sort((a, b) =>
        String(a[sort.field] ?? '').localeCompare(String(b[sort.field] ?? '')) * dir
      )
    }
    return { items: result.slice(from, from + size), total: result.length }
  }

const config: Record<string, TabConfig> = {
  speakers: {
    dataSource: memorySource(contacts as unknown as Record<string, unknown>[]),
    getItemId: (item: Contact) => item.id,
    getItemTitle: (item: Contact) => `${item.first_name} ${item.last_name}`,
    columns: [
      { field: 'first_name', header: 'First name', sortable: true },
      { field: 'last_name', header: 'Last name', sortable: true },
      { field: 'email', header: 'Email', width: '1.5fr' },
      { field: 'company', header: 'Company' },
    ],
    detailComponent: ({ item, onEdit }) => (
      <div style={{ padding: 24 }}>
        <h2>{item.first_name} {item.last_name}</h2>
        <p>{item.email} — {item.company}</p>
        {onEdit && <button onClick={onEdit}>Edit</button>}
      </div>
    ),
    // Selecting a speaker contributes contact_id to the global filter.
    globalFilterSets: { id: 'contact_id' },
    globalFilterReceives: { contact_id: 'id' },
    schema: {
      type: 'object',
      required: ['first_name', 'last_name', 'email'],
      properties: {
        first_name: { type: 'string', title: 'First name' },
        last_name: { type: 'string', title: 'Last name' },
        email: { type: 'string', format: 'email' },
        company: { type: 'string' },
      },
    },
    onUpsert: async (data, existing?: Contact) => {
      if (existing) {
        const index = contacts.findIndex((c) => c.id === existing.id)
        contacts[index] = { ...existing, ...data }
        return contacts[index]
      }
      const created = { id: `c${Date.now()}`, ...data } as Contact
      contacts.push(created)
      return created
    },
  },
  submissions: {
    dataSource: memorySource(submissions as unknown as Record<string, unknown>[]),
    getItemId: (item: Submission) => item.id,
    titleField: 'title',
    columns: [
      { field: 'code', header: 'Code', width: '90px' },
      { field: 'title', header: 'Title', width: '2fr', sortable: true },
      {
        field: 'status',
        header: 'Status',
        sortable: true,
        render: (value: string) => (
          <span className={`status-chip status-${value}`}>{value.replace('_', ' ')}</span>
        ),
      },
    ],
    detailComponent: ({ item, onEdit }) => (
      <div style={{ padding: 24 }}>
        <h2>{item.code}: {item.title}</h2>
        <p>Status: {item.status}</p>
        {onEdit && <button onClick={onEdit}>Edit</button>}
      </div>
    ),
    // Selecting a submission contributes its speaker to the global filter.
    globalFilterSets: { submitter_contact_id: 'contact_id' },
    globalFilterReceives: { contact_id: 'submitter_contact_id' },
    schema: {
      type: 'object',
      required: ['title'],
      properties: {
        code: { type: 'string' },
        title: { type: 'string' },
        status: {
          type: 'string',
          enum: ['draft', 'pending', 'accepted', 'declined'],
        },
      },
    },
    onUpsert: async (data, existing?: Submission) => {
      if (existing) {
        const index = submissions.findIndex((s) => s.id === existing.id)
        submissions[index] = { ...existing, ...data }
        return submissions[index]
      }
      const created = {
        id: `s${Date.now()}`,
        submitter_contact_id: (data.submitter_contact_id as string) ?? '',
        ...data,
      } as Submission
      submissions.push(created)
      return created
    },
  },
}

const hintStyle: CSSProperties = {
  flex: '0 0 auto',
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: '4px 14px',
  padding: '7px 14px',
  background: 'var(--chrome)',
  color: 'var(--text-secondary)',
  borderBottom: '1px solid var(--border)',
  fontSize: 'var(--text-label)',
  lineHeight: 1.4,
}

export default function App() {
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={hintStyle}>
        <strong style={{ color: 'var(--text)' }}>KMS tab-workspace demo</strong>
        <span><b>Shift+click</b> a speaker → other tabs narrow to them (the blue dot clears it)</span>
        <span><b>Double-click</b> edits</span>
        <span><b>Right-click</b> for menu</span>
        <span><b>+</b> creates</span>
        <span style={{ color: 'var(--text-muted)' }}>In-memory demo data</span>
      </div>
      <DataTabManager config={config} defaultTabs={['speakers', 'submissions']} />
    </div>
  )
}
