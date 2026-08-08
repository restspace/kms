import { Hono } from 'hono'
import { renderToString } from 'preact-render-to-string'
import { eventsRepo } from '@kms/db'
import { HelloPage, Page, type HelloPageData } from '@kms/ui'

export interface Env {
  DB: D1Database
  KV: KVNamespace
  ASSETS: Fetcher
  APP_URL: string
  EVENT_DEFAULT_TZ: string
}

const app = new Hono<{ Bindings: Env }>()

app.get('/', async (c) => {
  const event = await eventsRepo.first(c.env.DB, { org_id: 'org_demo' })

  const data: HelloPageData = {
    event: event && {
      name: event.name,
      slug: event.slug,
      timezone: event.timezone,
      starts_on: event.starts_on,
    },
    renderedAt: new Date().toISOString(),
  }

  const html =
    '<!doctype html>' +
    renderToString(
      <Page
        title={event ? `${event.name} — Call for Speakers` : 'KMS'}
        clientEntry="/static/hello.js"
        bootstrap={data}
      >
        <HelloPage data={data} />
      </Page>,
    )
  return c.html(html, 200, {
    // Public pages are edge-cacheable; the portal and admin are not (docs/03 §4).
    'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  })
})

app.get('/healthz', async (c) => {
  const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
  return c.json({ ok: row?.ok === 1 })
})

export default app
