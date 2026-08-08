// JSON API for the admin SPA workspace (docs/12 M0.5). Generic list endpoint
// pattern: POST /:resource/query with { from, size, filters, sort } in and
// { items, total } out. Relation filters translate to EXISTS subqueries against
// join tables — the tabs never see junction rows (docs/12 §0). Every filter and
// sort field is whitelisted here; all values travel as bound parameters.

import { Hono } from 'hono';
import { can } from '@kms/core';
import type { Actor, Role } from '@kms/core';
import type { AppEnv, Env } from '../env';
import { createSessionToken, getSession, setSessionCookie, type SessionPayload } from '../session';

type ApiEnv = { Bindings: Env; Variables: { session: SessionPayload } };

export const adminApiRoutes = new Hono<ApiEnv>();

// Guard every /app/api route with JSON errors (the /app HTML gate is separate).
adminApiRoutes.use('*', async (c, next) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'unauthenticated' }, 401);
  const actor: Actor = { contactId: session.contactId, email: session.email, role: session.role };
  if (!can(actor, 'admin.view')) return c.json({ error: 'forbidden' }, 403);
  c.set('session', session);
  await next();
});

// ---------------------------------------------------------------------------
// Query endpoint machinery
// ---------------------------------------------------------------------------

interface QueryBody {
  from: number;
  size: number;
  filters: Record<string, unknown>;
  sort?: { field: string; direction: 'asc' | 'desc' };
}

/** A filter contributes a WHERE fragment plus its bound params. */
type FilterBuilder = (value: unknown) => { sql: string; params: unknown[] } | null;

interface ResourceDef {
  /** FROM clause including joins; `?1` is always the event id. */
  fromSql: string;
  selectSql: string;
  /** sort field name → SQL expression (whitelist doubles as injection guard) */
  sortable: Record<string, string>;
  defaultSort: string;
  filters: Record<string, FilterBuilder>;
}

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/** Simple `expr = ?` filter on a text value. */
const eq = (expr: string): FilterBuilder => (value) => {
  const v = asText(value);
  return v === null ? null : { sql: `${expr} = ?`, params: [v] };
};

const SUBMISSION_STATUSES = new Set([
  'draft', 'pending', 'accept_queue', 'accepted', 'decline_queue', 'declined', 'withdrawn',
]);

const RESOURCES: Record<string, ResourceDef> = {
  contacts: {
    fromSql: 'FROM contacts c WHERE c.event_id = ?',
    selectSql: 'SELECT c.*',
    sortable: {
      first_name: 'c.first_name',
      last_name: 'c.last_name',
      email: 'c.email',
      company: 'c.company',
      job_title: 'c.job_title',
      created_at: 'c.created_at',
    },
    defaultSort: 'c.last_name ASC, c.first_name ASC',
    filters: {
      q: (value) => {
        const v = asText(value);
        if (v === null) return null;
        const like = `%${v}%`;
        return {
          sql: '(c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR c.company LIKE ?)',
          params: [like, like, like, like],
        };
      },
      // Anchor: a submission narrows Speakers to its participants (junction
      // resolved server-side) — plus the submitter, who predates M1's
      // participant rows on manually created records.
      submission_id: (value) => {
        const v = asText(value);
        if (v === null) return null;
        return {
          sql: `(EXISTS (SELECT 1 FROM submission_participants sp
                         WHERE sp.contact_id = c.id AND sp.submission_id = ?)
                 OR EXISTS (SELECT 1 FROM submissions s
                            WHERE s.id = ? AND s.submitter_contact_id = c.id))`,
          params: [v, v],
        };
      },
    },
  },

  submissions: {
    fromSql: `FROM submissions s
              LEFT JOIN tracks t ON t.id = s.track_id
              LEFT JOIN contacts sc ON sc.id = s.submitter_contact_id
              WHERE s.event_id = ?`,
    selectSql: `SELECT s.*, t.name AS track_name,
                NULLIF(TRIM(COALESCE(sc.first_name, '') || ' ' || COALESCE(sc.last_name, '')), '') AS submitter_name`,
    sortable: {
      code: 's.code',
      title: 's.title',
      status: 's.status',
      format: 's.format',
      track_name: 't.name',
      submitter_name: 'sc.last_name',
      created_at: 's.created_at',
    },
    defaultSort: 's.created_at DESC',
    filters: {
      q: (value) => {
        const v = asText(value);
        if (v === null) return null;
        const like = `%${v}%`;
        return { sql: '(s.title LIKE ? OR s.code LIKE ?)', params: [like, like] };
      },
      status: (value) => {
        const v = asText(value);
        return v !== null && SUBMISSION_STATUSES.has(v)
          ? { sql: 's.status = ?', params: [v] }
          : null;
      },
      track_id: eq('s.track_id'),
      tag_id: (value) => {
        const v = asText(value);
        if (v === null) return null;
        return {
          sql: `EXISTS (SELECT 1 FROM submission_tags st
                        WHERE st.submission_id = s.id AND st.tag_id = ?)`,
          params: [v],
        };
      },
      // The two relation paths to a contact stay separately nameable
      // ("Submitted" vs "Speaking on", docs/12 §0)…
      submitter_contact_id: eq('s.submitter_contact_id'),
      participant_contact_id: (value) => {
        const v = asText(value);
        if (v === null) return null;
        return {
          sql: `EXISTS (SELECT 1 FROM submission_participants sp
                        WHERE sp.submission_id = s.id AND sp.contact_id = ?)`,
          params: [v],
        };
      },
      // …while the anchor's contact_id means "theirs" in the broad sense.
      contact_id: (value) => {
        const v = asText(value);
        if (v === null) return null;
        return {
          sql: `(s.submitter_contact_id = ?
                 OR EXISTS (SELECT 1 FROM submission_participants sp
                            WHERE sp.submission_id = s.id AND sp.contact_id = ?))`,
          params: [v, v],
        };
      },
    },
  },
};

function parseQueryBody(raw: unknown): QueryBody {
  const body = (raw ?? {}) as Record<string, unknown>;
  const from = Number.isInteger(body.from) && (body.from as number) >= 0 ? (body.from as number) : 0;
  const sizeRaw = Number.isInteger(body.size) ? (body.size as number) : 50;
  const size = Math.min(Math.max(sizeRaw, 1), 200);
  const filters =
    body.filters && typeof body.filters === 'object' ? (body.filters as Record<string, unknown>) : {};
  let sort: QueryBody['sort'];
  const s = body.sort as Record<string, unknown> | undefined;
  if (s && typeof s.field === 'string' && (s.direction === 'asc' || s.direction === 'desc')) {
    sort = { field: s.field, direction: s.direction };
  }
  return { from, size, filters, sort };
}

// POST /app/api/:resource/query → { items, total }
adminApiRoutes.post('/:resource/query', async (c) => {
  const def = RESOURCES[c.req.param('resource')];
  if (!def) return c.json({ error: 'unknown_resource' }, 404);

  const session = c.get('session');
  const { from, size, filters, sort } = parseQueryBody(await c.req.json().catch(() => ({})));

  const where: string[] = [];
  const params: unknown[] = [session.eventId];
  for (const [key, value] of Object.entries(filters)) {
    const builder = def.filters[key];
    if (!builder) continue; // unknown filter names are ignored, never interpolated
    const built = builder(value);
    if (!built) continue;
    where.push(built.sql);
    params.push(...built.params);
  }
  const whereSql = where.length > 0 ? ` AND ${where.join(' AND ')}` : '';

  const orderSql =
    sort && def.sortable[sort.field]
      ? `${def.sortable[sort.field]} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}`
      : def.defaultSort;

  const listSql = `${def.selectSql} ${def.fromSql}${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) AS n ${def.fromSql}${whereSql}`;

  const [list, count] = await Promise.all([
    c.env.DB.prepare(listSql).bind(...params, size, from).all(),
    c.env.DB.prepare(countSql).bind(...params).first<{ n: number }>(),
  ]);

  return c.json({ items: list.results, total: count?.n ?? 0 });
});

// ---------------------------------------------------------------------------
// Contact CRUD (Speakers tab create/edit/delete — docs/12 M0.5)
// ---------------------------------------------------------------------------

const CONTACT_FIELDS = [
  'email', 'first_name', 'last_name', 'company', 'job_title',
  'mobile_phone', 'biography', 'pronouns',
] as const;

function pickContactFields(raw: unknown): Record<string, string | null> {
  const body = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, string | null> = {};
  for (const field of CONTACT_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null || value === '') out[field] = null;
    else if (typeof value === 'string') out[field] = value.trim();
  }
  if (typeof out.email === 'string') out.email = out.email.toLowerCase();
  return out;
}

adminApiRoutes.post('/contacts', async (c) => {
  const session = c.get('session');
  const fields = pickContactFields(await c.req.json().catch(() => ({})));
  if (!fields.email) return c.json({ error: 'email_required' }, 400);

  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  const cols = Object.keys(fields);
  try {
    await c.env.DB.prepare(
      `INSERT INTO contacts (id, event_id, created_at, updated_at, ${cols.join(', ')})
       VALUES (?, ?, ?, ?${', ?'.repeat(cols.length)})`,
    )
      .bind(id, session.eventId, ts, ts, ...cols.map((k) => fields[k]))
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('UNIQUE')) return c.json({ error: 'email_exists' }, 409);
    throw err;
  }
  const row = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

adminApiRoutes.put('/contacts/:id', async (c) => {
  const session = c.get('session');
  const id = c.req.param('id');
  const fields = pickContactFields(await c.req.json().catch(() => ({})));
  if ('email' in fields && !fields.email) return c.json({ error: 'email_required' }, 400);

  const cols = Object.keys(fields);
  if (cols.length > 0) {
    try {
      const result = await c.env.DB.prepare(
        `UPDATE contacts SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ?
         WHERE id = ? AND event_id = ?`,
      )
        .bind(...cols.map((k) => fields[k]), new Date().toISOString(), id, session.eventId)
        .run();
      if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('UNIQUE')) return c.json({ error: 'email_exists' }, 409);
      throw err;
    }
  }
  const row = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ? AND event_id = ?')
    .bind(id, session.eventId)
    .first();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
});

adminApiRoutes.delete('/contacts/:id', async (c) => {
  const session = c.get('session');
  const result = await c.env.DB.prepare('DELETE FROM contacts WHERE id = ? AND event_id = ?')
    .bind(c.req.param('id'), session.eventId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Session / shell endpoints
// ---------------------------------------------------------------------------

interface AdminEventRow {
  id: string;
  name: string;
  slug: string;
  starts_at: string;
  ends_at: string;
  role: Role;
  contact_id: string;
}

/** Events where this email holds an owner/admin seat (contacts are per-event). */
async function listAdminEvents(db: D1Database, email: string): Promise<AdminEventRow[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.name, e.slug, e.starts_at, e.ends_at, eu.role, c.id AS contact_id
       FROM events e
       JOIN contacts c ON c.event_id = e.id AND c.email = ?
       JOIN event_users eu ON eu.event_id = e.id AND eu.contact_id = c.id
       WHERE eu.role IN ('owner', 'admin')
       ORDER BY e.starts_at`,
    )
    .bind(email)
    .all<AdminEventRow>();
  return results;
}

// GET /app/api/me — who am I, which event am I in, which events can I switch to.
adminApiRoutes.get('/me', async (c) => {
  const session = c.get('session');
  const [event, events] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, slug, starts_at, ends_at, timezone FROM events WHERE id = ?')
      .bind(session.eventId)
      .first(),
    listAdminEvents(c.env.DB, session.email),
  ]);
  return c.json({
    email: session.email,
    role: session.role,
    event,
    events: events.map(({ id, name, slug, starts_at, ends_at }) => ({ id, name, slug, starts_at, ends_at })),
  });
});

// POST /app/api/switch-event { event_id } — re-mint the session for another
// event this email administers (the switcher never crosses a permission line).
adminApiRoutes.post('/switch-event', async (c) => {
  const session = c.get('session');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const eventId = typeof body.event_id === 'string' ? body.event_id : '';
  const target = (await listAdminEvents(c.env.DB, session.email)).find((e) => e.id === eventId);
  if (!target) return c.json({ error: 'not_an_admin_of_event' }, 403);

  const token = await createSessionToken(
    {
      contactId: target.contact_id,
      eventId: target.id,
      eventSlug: target.slug,
      email: session.email,
      role: target.role,
    },
    c.env.SESSION_SECRET,
  );
  setSessionCookie(c, token);
  return c.json({ ok: true });
});
