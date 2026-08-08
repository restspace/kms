// Public REST API /api/v1 (docs/10, docs/12 M6). The agent surface: bearer
// tokens are organisation-scoped and the event travels in the path, so every
// request carries its own scope — no session-held event state. List endpoints,
// their filter vocabulary and the exports are all generated from the same
// RESOURCES registry the admin SPA queries (adminApi.ts), so the three
// surfaces cannot drift apart. OpenAPI (openapi.ts) is derived from it too.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import type { Env } from '../env';
import { getSession } from '../session';
import { RESOURCES, queryResource } from './adminApi';
import { toCsv, toXlsx } from '../export';
import { sha256Hex } from '../hashing';

interface RestAuth {
  via: 'token' | 'session';
  /** organisation the bearer token can reach (token auth only) */
  orgId?: string;
  /** the one event a first-party session can reach (session auth only) */
  eventId?: string;
}

type RestEnv = {
  Bindings: Env;
  Variables: { auth: RestAuth; event: EventRow };
};

interface EventRow {
  id: string;
  org_id: string;
  name: string;
  slug: string;
  type: string;
  location: string | null;
  timezone: string;
  starts_at: string;
  ends_at: string;
  created_at: string;
  updated_at: string;
}

const EVENT_COLUMNS =
  'id, org_id, name, slug, type, location, timezone, starts_at, ends_at, created_at, updated_at';

export const restApiRoutes = new Hono<RestEnv>();

// Browser consumers welcome: tokens are sent explicitly, no cookies to leak,
// so a permissive CORS policy is safe here.
restApiRoutes.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }));

const apiError = (c: Context<RestEnv>, status: 400 | 401 | 403 | 404 | 422, code: string, message: string) =>
  c.json({ error: { code, message } }, status);

// ---------------------------------------------------------------------------
// Auth: Bearer token (server-to-server) or the admin session cookie (first-party)
// ---------------------------------------------------------------------------

restApiRoutes.use('*', async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(kms_[A-Za-z0-9_-]+)$/.exec(header);
  if (match) {
    const hash = await sha256Hex(match[1]!);
    const token = await c.env.DB.prepare(
      'SELECT id, org_id FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL',
    )
      .bind(hash)
      .first<{ id: string; org_id: string }>();
    if (!token) return apiError(c, 401, 'invalid_token', 'Unknown or revoked API token.');
    c.set('auth', { via: 'token', orgId: token.org_id });
    c.executionCtx.waitUntil(
      c.env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), token.id)
        .run(),
    );
    return next();
  }

  const session = await getSession(c);
  if (session && (session.role === 'owner' || session.role === 'admin')) {
    c.set('auth', { via: 'session', eventId: session.eventId });
    return next();
  }

  return apiError(
    c,
    401,
    'unauthenticated',
    'Pass an API token as `Authorization: Bearer kms_…` (create one under Settings → API tokens).',
  );
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// GET /events — the events this credential can reach.
restApiRoutes.get('/events', async (c) => {
  const auth = c.get('auth');
  const { results } =
    auth.via === 'token'
      ? await c.env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE org_id = ? ORDER BY starts_at`)
          .bind(auth.orgId)
          .all<EventRow>()
      : await c.env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`)
          .bind(auth.eventId)
          .all<EventRow>();
  return c.json({ data: results });
});

// Scope gate for everything nested under an event: the token's organisation
// must own the event (or the session must be for exactly this event).
restApiRoutes.use('/events/:event_id/*', async (c, next) => {
  const auth = c.get('auth');
  const event = await c.env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`)
    .bind(c.req.param('event_id'))
    .first<EventRow>();
  if (!event) return apiError(c, 404, 'event_not_found', 'No event with this id.');
  const allowed = auth.via === 'token' ? event.org_id === auth.orgId : event.id === auth.eventId;
  if (!allowed) return apiError(c, 403, 'forbidden', 'This credential cannot access this event.');
  c.set('event', event);
  await next();
});

restApiRoutes.get('/events/:event_id', (c) => c.json(c.get('event')));

// ---------------------------------------------------------------------------
// Registry-driven list + export endpoints
// ---------------------------------------------------------------------------

/** Translate ?filter=&sort=-field&limit=&offset= into a registry QueryBody. */
function queryFromParams(
  c: Context<RestEnv>,
  resource: string,
  { maxSize, defaultSize }: { maxSize: number; defaultSize: number },
) {
  const def = RESOURCES[resource];
  if (!def) return null;

  const filters: Record<string, unknown> = {};
  for (const name of Object.keys(def.filters)) {
    const value = c.req.query(name);
    if (value !== undefined && value !== '') filters[name] = value;
  }

  let sort: { field: string; direction: 'asc' | 'desc' } | undefined;
  const sortRaw = c.req.query('sort');
  if (sortRaw) {
    const desc = sortRaw.startsWith('-');
    const field = desc ? sortRaw.slice(1) : sortRaw;
    if (def.sortable[field]) sort = { field, direction: desc ? 'desc' : 'asc' };
  }

  const limitRaw = Number(c.req.query('limit'));
  const offsetRaw = Number(c.req.query('offset'));
  const size = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), maxSize) : defaultSize;
  const from = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

  return { def, body: { from, size, filters, sort } };
}

const EXPORT_MAX_ROWS = 10000;

/** GET /events/:event_id/:resource/export?format=csv|xlsx — honours the same filters. */
async function handleExport(c: Context<RestEnv>, resource: string) {
  const parsed = queryFromParams(c, resource, { maxSize: EXPORT_MAX_ROWS, defaultSize: EXPORT_MAX_ROWS });
  if (!parsed) return apiError(c, 404, 'unknown_resource', `No resource named "${resource}".`);
  const format = c.req.query('format') === 'xlsx' ? 'xlsx' : 'csv';
  const { items } = await queryResource(c.env.DB, parsed.def, c.get('event').id, parsed.body);

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${c.get('event').slug}-${resource}-${stamp}.${format}`;
  if (format === 'xlsx') {
    return c.body(toXlsx(items, resource) as unknown as ArrayBuffer, 200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
  }
  return c.body(toCsv(items), 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
}

// Export registers before the detail routes so /submissions/export never binds
// as a detail id (the detail handlers also guard, belt and braces).
restApiRoutes.get('/events/:event_id/:resource/export', (c) =>
  handleExport(c, c.req.param('resource')),
);

// ---------------------------------------------------------------------------
// Detail endpoints
// ---------------------------------------------------------------------------

// GET /events/:event_id/submissions/:id — full record: answers, participants,
// tags, review summary. The shape mirrors the workspace detail tab.
restApiRoutes.get('/events/:event_id/submissions/:id', async (c) => {
  const id = c.req.param('id');
  if (id === 'export') return handleExport(c, 'submissions');
  const db = c.env.DB;
  const submission = await db
    .prepare(
      `SELECT s.*, t.name AS track_name, ep.name AS plan_name, f.internal_name AS form_name
       FROM submissions s
       LEFT JOIN tracks t ON t.id = s.track_id
       LEFT JOIN evaluation_plans ep ON ep.id = s.evaluation_plan_id
       LEFT JOIN submission_forms f ON f.id = s.form_id
       WHERE s.id = ? AND s.event_id = ?`,
    )
    .bind(id, c.get('event').id)
    .first<Record<string, unknown>>();
  if (!submission) return apiError(c, 404, 'not_found', 'No submission with this id in this event.');

  const [answers, participants, tags, rating] = await Promise.all([
    db.prepare(
      `SELECT COALESCE(q.label, fd.label) AS label, a.value_json
       FROM submission_answers a
       JOIN form_questions q ON q.id = a.question_id
       JOIN field_definitions fd ON fd.id = q.field_id
       WHERE a.submission_id = ? ORDER BY q.position`,
    ).bind(id).all(),
    db.prepare(
      `SELECT sp.role, sp.is_primary_contact, c.id AS contact_id, c.first_name, c.last_name, c.email
       FROM submission_participants sp JOIN contacts c ON c.id = sp.contact_id
       WHERE sp.submission_id = ? ORDER BY sp.position`,
    ).bind(id).all(),
    db.prepare(
      'SELECT tg.name FROM submission_tags st JOIN tags tg ON tg.id = st.tag_id WHERE st.submission_id = ?',
    ).bind(id).all(),
    db.prepare(
      `SELECT ROUND(AVG(r.weighted_total), 2) AS avg, COUNT(*) AS reviews FROM reviews r
       WHERE r.submission_id = ?1
         AND r.plan_id = (SELECT evaluation_plan_id FROM submissions WHERE id = ?1)`,
    ).bind(id).first<{ avg: number | null; reviews: number }>(),
  ]);

  return c.json({
    ...submission,
    answers: answers.results.map((a) => {
      const row = a as { label: string; value_json: string | null };
      let value: unknown = row.value_json;
      try {
        value = row.value_json === null ? null : JSON.parse(row.value_json);
      } catch { /* keep raw */ }
      return { label: row.label, value };
    }),
    participants: participants.results,
    tags: tags.results.map((t) => (t as { name: string }).name),
    rating: rating?.avg ?? null,
    review_count: rating?.reviews ?? 0,
  });
});

// GET /events/:event_id/contacts/:id
restApiRoutes.get('/events/:event_id/contacts/:id', async (c) => {
  const id = c.req.param('id');
  if (id === 'export') return handleExport(c, 'contacts');
  const contact = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ? AND event_id = ?')
    .bind(id, c.get('event').id)
    .first();
  if (!contact) return apiError(c, 404, 'not_found', 'No contact with this id in this event.');
  return c.json(contact);
});

// POST /events/:event_id/submissions/:id/status { status } — the one write the
// v1 surface exposes for now. Decision *emails* stay in the app's
// send-decisions flow, so an API status change never sends mail by surprise.
const SUBMISSION_STATUSES = new Set([
  'draft', 'pending', 'accept_queue', 'accepted', 'decline_queue', 'declined', 'withdrawn',
]);

restApiRoutes.post('/events/:event_id/submissions/:id/status', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const status = typeof body.status === 'string' ? body.status : '';
  if (!SUBMISSION_STATUSES.has(status)) {
    return apiError(c, 422, 'invalid_status', `status must be one of: ${[...SUBMISSION_STATUSES].join(', ')}.`);
  }
  const result = await c.env.DB.prepare(
    'UPDATE submissions SET status = ?, updated_at = ? WHERE id = ? AND event_id = ?',
  )
    .bind(status, new Date().toISOString(), c.req.param('id'), c.get('event').id)
    .run();
  if (result.meta.changes === 0) return apiError(c, 404, 'not_found', 'No submission with this id in this event.');
  return c.json({ ok: true, status });
});

// ---------------------------------------------------------------------------
// Generic list endpoint (must register after the specific routes above)
// ---------------------------------------------------------------------------

// GET /events/:event_id/:resource → { data, total, limit, offset, has_more }
restApiRoutes.get('/events/:event_id/:resource', async (c) => {
  const resource = c.req.param('resource');
  const parsed = queryFromParams(c, resource, { maxSize: 200, defaultSize: 25 });
  if (!parsed) {
    return apiError(
      c,
      404,
      'unknown_resource',
      `No resource named "${resource}". Available: ${Object.keys(RESOURCES).join(', ')}.`,
    );
  }
  const { items, total } = await queryResource(c.env.DB, parsed.def, c.get('event').id, parsed.body);
  return c.json({
    data: items,
    total,
    limit: parsed.body.size,
    offset: parsed.body.from,
    has_more: parsed.body.from + items.length < total,
  });
});
