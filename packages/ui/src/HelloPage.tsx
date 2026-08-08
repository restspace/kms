import { SubmissionCounter } from './SubmissionCounter'

export interface HelloPageData {
  event: { name: string; slug: string; timezone: string; starts_on: string } | null
  renderedAt: string
}

/**
 * Page content, rendered on the Worker and hydrated by the public bundle from
 * the same source. The shell (<Page>) stays server-only so the island's
 * hydration root matches exactly what it replaces.
 */
export function HelloPage({ data }: { data: HelloPageData }) {
  const { event } = data
  return (
    <main>
      <p className="muted">Call for Speakers</p>
      <h1>{event ? event.name : 'No event seeded yet'}</h1>
      {event ? (
        <p className="muted">
          {event.starts_on} · {event.timezone} · <code>/submit/{event.slug}</code>
        </p>
      ) : (
        <p className="muted">
          Run <code>npm run db:migrate:local</code> then <code>npm run seed:local</code> to seed the
          demo event.
        </p>
      )}

      <div className="card">
        <p>
          <strong>Hello world.</strong> Server-rendered on a Cloudflare Worker from a shared{' '}
          <code>@kms/ui</code> React component, with the event read from D1.
        </p>
        <SubmissionCounter initial={0} />
        <p className="muted" style={{ marginTop: '1rem', marginBottom: 0 }}>
          If the button counts, the island hydrated.
        </p>
      </div>

      <p className="muted">Rendered at {data.renderedAt}</p>
    </main>
  )
}
