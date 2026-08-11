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
import { getRevalidatedPrivilegedSession } from '../session';
import { RESOURCES, queryResource, type ResourceDef } from './adminApi';
import { toCsv, toXlsx } from '../export';
import { sha256Hex } from '../hashing';
import { decodeCursor, encodeCursor, keysetWhere, type CursorPayload } from '../cursor';
import { bumpEventRevision } from '../revision';
import { stageAirtableDeletes } from '../airtableStage';
import { isValidEmailShape } from '@kms/core';
import { createDb } from '@kms/db';

interface RestAuth {
  via: 'token' | 'session';
  /** organisation the bearer token can reach (token auth only) */
  orgId?: string;
  /** the api_tokens row id (token auth only) — the idempotency key namespace */
  tokenId?: string;
  /** the one event a first-party session can reach (session auth only) */
  eventId?: string;
}

type RestEnv = {
  Bindings: Env;
  Variables: { auth: RestAuth; event: EventRow; idemBody?: unknown };
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

const apiError = (c: Context<RestEnv>, status: 400 | 401 | 403 | 404 | 409 | 422, code: string, message: string) =>
  c.json({ error: { code, message } }, status);

interface FieldError {
  field: string;
  message: string;
}

/** Uniform 400 for whitelist-field validation failures (work item 2). */
const validationError = (c: Context<RestEnv>, errors: FieldError[]) =>
  c.json(
    { error: { code: 'validation', message: errors[0]?.message ?? 'Validation failed.', details: errors } },
    400,
  );

/** Read the parsed JSON body. When the idempotency middleware already
 * consumed the request stream (Idempotency-Key present), read its stash
 * instead of re-reading — the underlying body can only be read once. */
async function readBody(c: Context<RestEnv>): Promise<Record<string, unknown>> {
  const stashed = c.get('idemBody');
  if (stashed !== undefined) return stashed as Record<string, unknown>;
  return (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
}

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
    c.set('auth', { via: 'token', orgId: token.org_id, tokenId: token.id });
    c.executionCtx.waitUntil(
      c.env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), token.id)
        .run(),
    );
    return next();
  }

  const session = await getRevalidatedPrivilegedSession(c);
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
// Idempotency-Key (work item 3): every POST in this file may carry one. A
// replay (same actor + key) returns the stored response verbatim; the same
// key with a different body is a client bug, surfaced as 422 rather than
// silently executing twice or silently replaying the wrong thing.
// ---------------------------------------------------------------------------

interface IdempotencyRecord {
  status: number;
  body: unknown;
  bodyHash: string;
}

restApiRoutes.use('*', async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const idemKey = c.req.header('Idempotency-Key');
  if (!idemKey) return next();

  const auth = c.get('auth');
  const actor = auth.via === 'token' ? `token:${auth.tokenId ?? ''}` : `session:${auth.eventId ?? ''}`;
  const kvKey = `apiidem:${await sha256Hex(`${actor}:${idemKey}`)}`;

  // The request body can only be read once; stash the parsed JSON for
  // handlers (readBody) and hash the raw text for the mismatch check.
  const bodyText = await c.req.text();
  const bodyHash = await sha256Hex(bodyText);
  let parsedBody: unknown = {};
  try {
    parsedBody = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    parsedBody = {};
  }
  c.set('idemBody', parsedBody);

  const stored = await c.env.KV.get(kvKey);
  if (stored) {
    let record: IdempotencyRecord;
    try {
      record = JSON.parse(stored) as IdempotencyRecord;
    } catch {
      record = { status: 500, body: {}, bodyHash: '' };
    }
    if (record.bodyHash !== bodyHash) {
      return apiError(
        c,
        422,
        'idempotency_mismatch',
        'This Idempotency-Key was already used with a different request body.',
      );
    }
    const replay = c.json(record.body as object, record.status as 200);
    replay.headers.set('Idempotency-Replayed', 'true');
    return replay;
  }

  await next();

  const res = c.res;
  if (res && res.status >= 200 && res.status < 500) {
    try {
      const body: unknown = await res.clone().json();
      const record: IdempotencyRecord = { status: res.status, body, bodyHash };
      c.executionCtx.waitUntil(c.env.KV.put(kvKey, JSON.stringify(record), { expirationTtl: 86400 }));
    } catch {
      // Non-JSON response (shouldn't happen for POSTs in this file) — skip caching.
    }
  }
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
       JOIN evaluation_plans p ON p.id = r.plan_id
       WHERE r.submission_id = ?1
         AND p.event_id = (SELECT event_id FROM submissions WHERE id = ?1)`,
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

// Every contact read in this file goes through this: since 0015 the join to
// event_contacts is BOTH the tenancy guard and the source of the profile
// columns, so a query that drops it loses the columns it came for rather than
// silently widening from event to org. Columns are listed explicitly because
// the two tables read alike at a glance. Binds (event_id, contact_id).
//
// `event_id` stays on the response — it now comes from event_contacts — so the
// public shape is unchanged.
const CONTACT_SELECT = `SELECT c.id, ec.event_id, c.email, c.first_name, c.last_name,
          c.salutation, c.honorific, c.pronouns, c.gender, c.mobile_phone, c.links,
          ec.biography, ec.headshot_asset_id, ec.company, ec.job_title, ec.notes,
          ec.added_at, ec.source, c.created_at, c.updated_at
     FROM contacts c
     JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
    WHERE c.id = ?`;

// GET /events/:event_id/contacts/:id
restApiRoutes.get('/events/:event_id/contacts/:id', async (c) => {
  const id = c.req.param('id');
  if (id === 'export') return handleExport(c, 'contacts');
  const contact = await c.env.DB.prepare(CONTACT_SELECT).bind(c.get('event').id, id).first();
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
  const body = await readBody(c);
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
  await bumpEventRevision(c.env, c.get('event').id);
  return c.json({ ok: true, status });
});

// ---------------------------------------------------------------------------
// Contacts CRUD (work item 2). Field whitelist kept local — do not import
// adminApi.ts's CONTACT_FIELDS, which is under concurrent edit elsewhere.
// ---------------------------------------------------------------------------

// 0015 split these over two tables: identity on the org-level `contacts` row,
// profile on the per-event `event_contacts` row. The request body keeps one
// flat shape — the split is a write-side concern only.
const CONTACT_IDENTITY_FIELDS = ['email', 'first_name', 'last_name', 'mobile_phone', 'pronouns'] as const;
const CONTACT_PROFILE_FIELDS = ['company', 'job_title', 'biography'] as const;
const CONTACT_FIELDS = [...CONTACT_IDENTITY_FIELDS, ...CONTACT_PROFILE_FIELDS] as const;

/** The provided fields belonging to one of the two tables, in whitelist order. */
const columnsFor = (
  fields: Record<string, string | null>,
  whitelist: readonly string[],
): string[] => whitelist.filter((f) => f in fields);

function pickContactFields(raw: unknown): { fields: Record<string, string | null>; errors: FieldError[] } {
  const body = (raw ?? {}) as Record<string, unknown>;
  const fields: Record<string, string | null> = {};
  const errors: FieldError[] = [];
  for (const field of CONTACT_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null || value === '') fields[field] = null;
    else if (typeof value === 'string') fields[field] = value.trim();
    else errors.push({ field, message: `${field} must be a string.` });
  }
  if (typeof fields.email === 'string') {
    fields.email = fields.email.toLowerCase();
    if (!isValidEmailShape(fields.email)) errors.push({ field: 'email', message: 'email is not a valid address.' });
  }
  return { fields, errors };
}

// POST /events/:event_id/contacts
restApiRoutes.post('/events/:event_id/contacts', async (c) => {
  const event = c.get('event');
  const eventId = event.id;
  const { fields, errors } = pickContactFields(await readBody(c));
  if (!fields.email) errors.unshift({ field: 'email', message: 'email is required.' });
  if (errors.length > 0) return validationError(c, errors);

  const ts = new Date().toISOString();
  const db = createDb(c.env.DB);
  try {
    // Dedupe scope moved from UNIQUE (event_id, email) to (org_id, lower(email))
    // in 0015, so the person may already exist through a sibling event. The
    // upsert is a no-op in that case, and 409 stays reserved for exactly what it
    // meant before — this email is already on THIS event's roster. An org
    // sibling is attached here rather than rejected.
    const contact = await db.contacts.upsertByEmail(event.org_id, fields.email!);
    const onRoster = await c.env.DB.prepare(
      'SELECT 1 FROM event_contacts WHERE event_id = ? AND contact_id = ?',
    )
      .bind(eventId, contact.id)
      .first();
    if (onRoster) {
      return apiError(c, 409, 'email_exists', 'A contact with this email already exists in this event.');
    }

    // Identity is org-level and shared across the org's events; the supplied
    // values are still written so the response echoes what the client sent.
    const identityCols = columnsFor(fields, CONTACT_IDENTITY_FIELDS);
    if (identityCols.length > 0) {
      await c.env.DB.prepare(
        `UPDATE contacts SET ${identityCols.map((k) => `${k} = ?`).join(', ')}, updated_at = ?
         WHERE id = ?`,
      )
        .bind(...identityCols.map((k) => fields[k]), ts, contact.id)
        .run();
    }

    // Create and attach are one operation: a contact with no event_contacts row
    // is a person who exists but appears on no roster. attachToEvent seeds the
    // profile from their most recent event in this org; the explicit fields
    // below overwrite that seed wherever the request supplied them.
    await db.contacts.attachToEvent(eventId, contact.id, 'admin');
    const profileCols = columnsFor(fields, CONTACT_PROFILE_FIELDS);
    if (profileCols.length > 0) {
      await c.env.DB.prepare(
        `UPDATE event_contacts SET ${profileCols.map((k) => `${k} = ?`).join(', ')}
         WHERE event_id = ? AND contact_id = ?`,
      )
        .bind(...profileCols.map((k) => fields[k]), eventId, contact.id)
        .run();
    }

    await bumpEventRevision(c.env, eventId);
    const row = await c.env.DB.prepare(CONTACT_SELECT).bind(eventId, contact.id).first();
    return c.json(row, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('UNIQUE')) return apiError(c, 409, 'email_exists', 'A contact with this email already exists in this event.');
    throw err;
  }
});

// PUT /events/:event_id/contacts/:cid
restApiRoutes.put('/events/:event_id/contacts/:cid', async (c) => {
  const eventId = c.get('event').id;
  const id = c.req.param('cid');
  const { fields, errors } = pickContactFields(await readBody(c));
  if ('email' in fields && !fields.email) errors.push({ field: 'email', message: 'email cannot be cleared.' });
  if (errors.length > 0) return validationError(c, errors);

  // The membership row is the tenancy guard: without one for this event the
  // contact is an org sibling and not ours to edit through this route.
  const onRoster = await c.env.DB.prepare(
    'SELECT 1 FROM event_contacts WHERE event_id = ? AND contact_id = ?',
  )
    .bind(eventId, id)
    .first();
  if (!onRoster) return apiError(c, 404, 'not_found', 'No contact with this id in this event.');

  const identityCols = columnsFor(fields, CONTACT_IDENTITY_FIELDS);
  const profileCols = columnsFor(fields, CONTACT_PROFILE_FIELDS);
  try {
    // Identity columns go to the org-level row (authorised by the membership
    // check above), profile columns to this event's row only.
    if (identityCols.length > 0) {
      await c.env.DB.prepare(
        `UPDATE contacts SET ${identityCols.map((k) => `${k} = ?`).join(', ')}, updated_at = ?
         WHERE id = ?`,
      )
        .bind(...identityCols.map((k) => fields[k]), new Date().toISOString(), id)
        .run();
    }
    if (profileCols.length > 0) {
      await c.env.DB.prepare(
        `UPDATE event_contacts SET ${profileCols.map((k) => `${k} = ?`).join(', ')}
         WHERE event_id = ? AND contact_id = ?`,
      )
        .bind(...profileCols.map((k) => fields[k]), eventId, id)
        .run();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('UNIQUE')) return apiError(c, 409, 'email_exists', 'A contact with this email already exists in this event.');
    throw err;
  }
  await bumpEventRevision(c.env, eventId);
  const row = await c.env.DB.prepare(CONTACT_SELECT).bind(eventId, id).first();
  if (!row) return apiError(c, 404, 'not_found', 'No contact with this id in this event.');
  return c.json(row);
});

// DELETE /events/:event_id/contacts/:cid — DETACH, not destroy. Since 0015 the
// contact is an org-level person while this route is event-scoped, so the
// correct REST semantic is removing the event_contacts row: this event's
// membership and profile (biography, company, job title, notes, headshot) go,
// the person's identity and their history at the org's other events stay.
//
// If that was their last event they belong to no roster at all, so the contact
// row goes too rather than accumulating orphans; the NOT EXISTS makes that a
// no-op while any other event still holds them.
//
// event_contacts.headshot_asset_id and file_assets.uploaded_by_contact_id are
// mutually referential; null the headshot ref first in the same batch (same fix
// as the admin speaker-delete bug). A remaining FK violation (e.g. a reviewer
// assignment with no ON DELETE clause) surfaces as 409, not a 500.
restApiRoutes.delete('/events/:event_id/contacts/:cid', async (c) => {
  const eventId = c.get('event').id;
  const id = c.req.param('cid');
  const exists = await c.env.DB.prepare(
    'SELECT 1 FROM event_contacts WHERE event_id = ? AND contact_id = ?',
  )
    .bind(eventId, id)
    .first();
  if (!exists) return apiError(c, 404, 'not_found', 'No contact with this id in this event.');
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE event_contacts SET headshot_asset_id = NULL WHERE event_id = ? AND contact_id = ?').bind(eventId, id),
      c.env.DB.prepare('DELETE FROM event_contacts WHERE event_id = ? AND contact_id = ?').bind(eventId, id),
      stageAirtableDeletes(
        c.env.DB,
        'reviews',
        'reviewer_contact_id = ? AND NOT EXISTS (SELECT 1 FROM event_contacts ec WHERE ec.contact_id = ?)',
        id,
        id,
      ),
      stageAirtableDeletes(
        c.env.DB,
        'contacts',
        'id = ? AND NOT EXISTS (SELECT 1 FROM event_contacts ec WHERE ec.contact_id = ?)',
        id,
        id,
      ),
      c.env.DB.prepare(
        `DELETE FROM contacts WHERE id = ?1
           AND NOT EXISTS (SELECT 1 FROM event_contacts ec WHERE ec.contact_id = ?1)`,
      ).bind(id),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    return apiError(c, 409, 'constraint', message || 'This contact cannot be deleted while other records reference it.');
  }
  await bumpEventRevision(c.env, eventId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Submissions CRUD (work item 2)
// ---------------------------------------------------------------------------

const SUBMISSION_WRITE_FIELDS = ['description', 'format', 'level', 'language'] as const;

interface SubmissionWriteResult {
  fields: Record<string, string | null>;
  errors: FieldError[];
  trackId: string | null | undefined; // undefined = not provided
  status: string | undefined;
}

async function pickSubmissionFields(
  c: Context<RestEnv>,
  raw: unknown,
  { allowStatus }: { allowStatus: boolean },
): Promise<SubmissionWriteResult> {
  const body = (raw ?? {}) as Record<string, unknown>;
  const fields: Record<string, string | null> = {};
  const errors: FieldError[] = [];

  if ('title' in body) {
    const v = body.title;
    if (typeof v === 'string' && v.trim()) fields.title = v.trim();
    else errors.push({ field: 'title', message: 'title must be a non-empty string.' });
  }
  for (const field of SUBMISSION_WRITE_FIELDS) {
    if (!(field in body)) continue;
    const v = body[field];
    if (v === null || v === '') fields[field] = null;
    else if (typeof v === 'string') fields[field] = v;
    else errors.push({ field, message: `${field} must be a string.` });
  }

  let trackId: string | null | undefined;
  if ('track_id' in body) {
    const v = body.track_id;
    if (v === null || v === '') trackId = null;
    else if (typeof v === 'string') {
      const track = await c.env.DB.prepare('SELECT id FROM tracks WHERE id = ? AND event_id = ?')
        .bind(v, c.get('event').id)
        .first();
      if (!track) errors.push({ field: 'track_id', message: 'track_id does not belong to this event.' });
      else trackId = v;
    } else {
      errors.push({ field: 'track_id', message: 'track_id must be a string.' });
    }
  }

  let status: string | undefined;
  if (allowStatus && 'status' in body) {
    const v = body.status;
    if (typeof v === 'string' && SUBMISSION_STATUSES.has(v)) status = v;
    else errors.push({ field: 'status', message: `status must be one of: ${[...SUBMISSION_STATUSES].join(', ')}.` });
  }

  return { fields, errors, trackId, status };
}

// POST /events/:event_id/submissions — manual create (source='manual').
restApiRoutes.post('/events/:event_id/submissions', async (c) => {
  const eventId = c.get('event').id;
  const body = await readBody(c);
  const { fields, errors, trackId } = await pickSubmissionFields(c, body, { allowStatus: false });
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) errors.unshift({ field: 'title', message: 'title is required.' });
  if (errors.length > 0) return validationError(c, errors);

  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  const result = await c.env.DB.prepare(
    `INSERT INTO submissions
       (id, event_id, code, kind, title, description, status, format, level, language, track_id, source, created_at, updated_at)
     SELECT ?, ?,
       'SESS-' || (COALESCE((SELECT MAX(CAST(SUBSTR(code,6) AS INTEGER)) FROM submissions WHERE event_id=? AND code LIKE 'SESS-%'),0)+1),
       'abstract', ?, ?, 'pending', ?, ?, ?, ?, 'manual', ?, ?`,
  )
    .bind(
      id, eventId, eventId,
      title, fields.description ?? null,
      fields.format ?? null, fields.level ?? null, fields.language ?? null,
      trackId ?? null,
      ts, ts,
    )
    .run();
  if (result.meta.changes === 0) return apiError(c, 422, 'create_failed', 'Could not create the submission.');
  await bumpEventRevision(c.env, eventId);
  const row = await c.env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

// PUT /events/:event_id/submissions/:sid
restApiRoutes.put('/events/:event_id/submissions/:sid', async (c) => {
  const eventId = c.get('event').id;
  const id = c.req.param('sid');
  const { fields, errors, trackId, status } = await pickSubmissionFields(c, await readBody(c), { allowStatus: true });
  if (errors.length > 0) return validationError(c, errors);

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    params.push(value);
  }
  if (trackId !== undefined) {
    sets.push('track_id = ?');
    params.push(trackId);
  }
  if (status !== undefined) {
    sets.push('status = ?');
    params.push(status);
  }
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());

  const result = await c.env.DB.prepare(
    `UPDATE submissions SET ${sets.join(', ')} WHERE id = ? AND event_id = ?`,
  )
    .bind(...params, id, eventId)
    .run();
  if (result.meta.changes === 0) return apiError(c, 404, 'not_found', 'No submission with this id in this event.');
  await bumpEventRevision(c.env, eventId);
  const row = await c.env.DB.prepare('SELECT * FROM submissions WHERE id = ? AND event_id = ?').bind(id, eventId).first();
  return c.json(row);
});

// DELETE /events/:event_id/submissions/:sid — every child row cascades
// (answers, participants, tags, review data, task assignments), so a plain
// delete is safe; no batch/FK workaround needed here.
restApiRoutes.delete('/events/:event_id/submissions/:sid', async (c) => {
  const eventId = c.get('event').id;
  const sid = c.req.param('sid');
  const results = await c.env.DB.batch([
    stageAirtableDeletes(c.env.DB, 'reviews', 'submission_id = ?', sid),
    stageAirtableDeletes(c.env.DB, 'submissions', 'id = ? AND event_id = ?', sid, eventId),
    c.env.DB.prepare('DELETE FROM submissions WHERE id = ? AND event_id = ?').bind(sid, eventId),
  ]);
  if ((results[2]?.meta.changes ?? 0) === 0) return apiError(c, 404, 'not_found', 'No submission with this id in this event.');
  await bumpEventRevision(c.env, eventId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Tasks CRUD (work item 2)
// ---------------------------------------------------------------------------

const TASK_TARGETS = new Set(['contact', 'group', 'submission']);
const TASK_ASSIGNMENT_MODES = new Set(['manual', 'automatic']);
const TASK_TRIGGERS = new Set(['on_accept', 'on_schedule', 'none']);
const TASK_ACTION_TYPES = new Set(['file_upload', 'portal_form', 'acknowledge', 'external_link']);

interface TaskWriteResult {
  cols: Record<string, unknown>;
  errors: FieldError[];
}

async function pickTaskFields(c: Context<RestEnv>, raw: unknown, { requireTitle }: { requireTitle: boolean }): Promise<TaskWriteResult> {
  const body = (raw ?? {}) as Record<string, unknown>;
  const cols: Record<string, unknown> = {};
  const errors: FieldError[] = [];
  const eventId = c.get('event').id;

  if ('title' in body || requireTitle) {
    const v = body.title;
    if (typeof v === 'string' && v.trim()) cols.title = v.trim();
    else if (requireTitle) errors.push({ field: 'title', message: 'title is required.' });
  }
  if ('description' in body) {
    const v = body.description;
    cols.description = v === null || v === '' ? null : typeof v === 'string' ? v : undefined;
    if (cols.description === undefined) errors.push({ field: 'description', message: 'description must be a string.' });
  }
  if ('target' in body) {
    const v = body.target;
    if (typeof v === 'string' && TASK_TARGETS.has(v)) cols.target = v;
    else errors.push({ field: 'target', message: `target must be one of: ${[...TASK_TARGETS].join(', ')}.` });
  }
  if ('assignment_mode' in body) {
    const v = body.assignment_mode;
    if (typeof v === 'string' && TASK_ASSIGNMENT_MODES.has(v)) cols.assignment_mode = v;
    else errors.push({ field: 'assignment_mode', message: `assignment_mode must be one of: ${[...TASK_ASSIGNMENT_MODES].join(', ')}.` });
  }
  if ('trigger' in body) {
    const v = body.trigger;
    if (typeof v === 'string' && TASK_TRIGGERS.has(v)) cols.trigger = v;
    else errors.push({ field: 'trigger', message: `trigger must be one of: ${[...TASK_TRIGGERS].join(', ')}.` });
  }
  if ('action_type' in body) {
    const v = body.action_type;
    if (typeof v === 'string' && TASK_ACTION_TYPES.has(v)) cols.action_type = v;
    else errors.push({ field: 'action_type', message: `action_type must be one of: ${[...TASK_ACTION_TYPES].join(', ')}.` });
  }
  if ('portal_form_id' in body) {
    const v = body.portal_form_id;
    if (v === null || v === '') cols.portal_form_id = null;
    else if (typeof v === 'string') {
      const row = await c.env.DB.prepare('SELECT id FROM portal_forms WHERE id = ? AND event_id = ?').bind(v, eventId).first();
      if (!row) errors.push({ field: 'portal_form_id', message: 'portal_form_id does not belong to this event.' });
      else cols.portal_form_id = v;
    } else {
      errors.push({ field: 'portal_form_id', message: 'portal_form_id must be a string.' });
    }
  }
  if ('file_request_id' in body) {
    const v = body.file_request_id;
    if (v === null || v === '') cols.file_request_id = null;
    else if (typeof v === 'string') {
      const row = await c.env.DB.prepare('SELECT id FROM file_requests WHERE id = ? AND event_id = ?').bind(v, eventId).first();
      if (!row) errors.push({ field: 'file_request_id', message: 'file_request_id does not belong to this event.' });
      else cols.file_request_id = v;
    } else {
      errors.push({ field: 'file_request_id', message: 'file_request_id must be a string.' });
    }
  }
  if ('due_at' in body) {
    const v = body.due_at;
    if (v === null || v === '') cols.due_at = null;
    else if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) cols.due_at = v;
    else errors.push({ field: 'due_at', message: 'due_at must be an ISO 8601 timestamp.' });
  }
  if ('reminder_offsets_days' in body) {
    const v = body.reminder_offsets_days;
    if (v === null) cols.reminder_offsets_days = null;
    else if (Array.isArray(v) && v.every((n) => Number.isInteger(n))) cols.reminder_offsets_days = JSON.stringify(v);
    else errors.push({ field: 'reminder_offsets_days', message: 'reminder_offsets_days must be an array of integers.' });
  }
  if ('required' in body) {
    const v = body.required;
    if (typeof v === 'boolean') cols.required = v ? 1 : 0;
    else errors.push({ field: 'required', message: 'required must be a boolean.' });
  }

  return { cols, errors };
}

// POST /events/:event_id/tasks
restApiRoutes.post('/events/:event_id/tasks', async (c) => {
  const eventId = c.get('event').id;
  const { cols, errors } = await pickTaskFields(c, await readBody(c), { requireTitle: true });
  if (errors.length > 0) return validationError(c, errors);

  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  const keys = Object.keys(cols);
  const quoted = keys.map((k) => (k === 'trigger' ? '"trigger"' : k));
  await c.env.DB.prepare(
    `INSERT INTO tasks (id, event_id, created_at, updated_at, ${quoted.join(', ')})
     VALUES (?, ?, ?, ?${', ?'.repeat(keys.length)})`,
  )
    .bind(id, eventId, ts, ts, ...keys.map((k) => cols[k]))
    .run();
  await bumpEventRevision(c.env, eventId);
  const row = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

// PUT /events/:event_id/tasks/:tid
restApiRoutes.put('/events/:event_id/tasks/:tid', async (c) => {
  const eventId = c.get('event').id;
  const id = c.req.param('tid');
  const { cols, errors } = await pickTaskFields(c, await readBody(c), { requireTitle: false });
  if (errors.length > 0) return validationError(c, errors);

  const keys = Object.keys(cols);
  if (keys.length > 0) {
    const quoted = keys.map((k) => (k === 'trigger' ? '"trigger"' : k));
    const result = await c.env.DB.prepare(
      `UPDATE tasks SET ${quoted.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND event_id = ?`,
    )
      .bind(...keys.map((k) => cols[k]), new Date().toISOString(), id, eventId)
      .run();
    if (result.meta.changes === 0) return apiError(c, 404, 'not_found', 'No task with this id in this event.');
  }
  await bumpEventRevision(c.env, eventId);
  const row = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND event_id = ?').bind(id, eventId).first();
  if (!row) return apiError(c, 404, 'not_found', 'No task with this id in this event.');
  return c.json(row);
});

// DELETE /events/:event_id/tasks/:tid — assignments cascade via task_id.
restApiRoutes.delete('/events/:event_id/tasks/:tid', async (c) => {
  const eventId = c.get('event').id;
  const tid = c.req.param('tid');
  const results = await c.env.DB.batch([
    stageAirtableDeletes(c.env.DB, 'tasks', 'id = ? AND event_id = ?', tid, eventId),
    c.env.DB.prepare('DELETE FROM tasks WHERE id = ? AND event_id = ?').bind(tid, eventId),
  ]);
  if ((results[1]?.meta.changes ?? 0) === 0) return apiError(c, 404, 'not_found', 'No task with this id in this event.');
  await bumpEventRevision(c.env, eventId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Forms (work item 2): read-only for v1 preview. Creation/editing stays
// admin-UI only (formsAdmin.ts) — see docs/10 §2.
// ---------------------------------------------------------------------------

// GET /events/:event_id/forms
restApiRoutes.get('/events/:event_id/forms', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT f.id, f.internal_name, f.external_title, f.collection_type, f.status, f.close_at,
            f.created_at, f.updated_at,
            (SELECT COUNT(*) FROM form_questions q WHERE q.form_id = f.id) AS question_count,
            (SELECT COUNT(*) FROM submissions s WHERE s.form_id = f.id) AS submission_count
     FROM submission_forms f WHERE f.event_id = ? ORDER BY f.created_at DESC`,
  )
    .bind(c.get('event').id)
    .all();
  return c.json({ data: results });
});

// GET /events/:event_id/forms/:fid — form + its questions.
restApiRoutes.get('/events/:event_id/forms/:fid', async (c) => {
  const eventId = c.get('event').id;
  const id = c.req.param('fid');
  const form = await c.env.DB.prepare('SELECT * FROM submission_forms WHERE id = ? AND event_id = ?')
    .bind(id, eventId)
    .first();
  if (!form) return apiError(c, 404, 'not_found', 'No form with this id in this event.');
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM form_questions WHERE form_id = ? ORDER BY section, position',
  )
    .bind(id)
    .all();
  return c.json({ ...form, questions: results });
});

// ---------------------------------------------------------------------------
// Cursor pagination (work item 1). Keyset mode is opt-in via ?cursor= — the
// registry's fromSql/selectSql/filters are reused as-is (RESOURCES is
// call-only here), and only the id-tiebreaker aliases + numeric-vs-text
// sentinel are declared locally so this doesn't depend on BE-3's concurrent
// edits to adminApi.ts. Offset mode (no ?cursor=) is unchanged for back-compat.
// ---------------------------------------------------------------------------

/** Primary-key column alias per resource's fromSql — the keyset tiebreaker. */
const CURSOR_ID_EXPR: Record<string, string> = {
  contacts: 'c.id',
  submissions: 's.id',
  tasks: 'ta.id',
  messages: 'm.id',
};

// The only sort field whose JSON value is a number, not a string — everything
// else (titles, statuses, ISO timestamps) sorts correctly as text.
const NUMERIC_SORT_FIELDS = new Set(['rating']);
const NULL_TEXT_SENTINEL = '';
const NULL_NUMBER_SENTINEL = -1e15;

/** Resolve the SQL sort expression + JSON row key for cursor mode. Falls back
 * to ordering by id when no (valid) ?sort= is given — a total, stable order. */
function cursorSort(
  resource: string,
  def: ResourceDef,
  field: string | null,
): { orderExpr: string; idExpr: string; rowKey: string; numeric: boolean } {
  const idExpr = CURSOR_ID_EXPR[resource] ?? 'id';
  if (field && def.sortable[field]) {
    const numeric = NUMERIC_SORT_FIELDS.has(field);
    const wrapped = numeric
      ? `COALESCE(${def.sortable[field]}, ${NULL_NUMBER_SENTINEL})`
      : `COALESCE(${def.sortable[field]}, '${NULL_TEXT_SENTINEL}')`;
    return { orderExpr: wrapped, idExpr, rowKey: field, numeric };
  }
  return { orderExpr: idExpr, idExpr, rowKey: 'id', numeric: false };
}

async function handleCursorList(c: Context<RestEnv>, resource: string, def: ResourceDef, cursorRaw: string) {
  const eventId = c.get('event').id;
  const cursor: CursorPayload | null = cursorRaw === '' ? null : decodeCursor(cursorRaw);
  if (cursorRaw !== '' && !cursor) return apiError(c, 400, 'invalid_cursor', 'The cursor parameter is not valid.');

  const limitRaw = Number(c.req.query('limit'));
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 25;

  let sortField: string | null = null;
  let direction: 'asc' | 'desc' = 'asc';
  const sortRaw = c.req.query('sort');
  if (sortRaw) {
    const desc = sortRaw.startsWith('-');
    const field = desc ? sortRaw.slice(1) : sortRaw;
    if (def.sortable[field]) {
      sortField = field;
      direction = desc ? 'desc' : 'asc';
    }
  }
  const { orderExpr, idExpr, rowKey, numeric } = cursorSort(resource, def, sortField);

  const filterClauses: { sql: string; params: unknown[] }[] = [];
  for (const name of Object.keys(def.filters)) {
    const value = c.req.query(name);
    if (value === undefined || value === '') continue;
    const built = def.filters[name]?.(value);
    if (built) filterClauses.push(built);
  }

  const whereForCount = filterClauses.length > 0 ? ` AND ${filterClauses.map((f) => f.sql).join(' AND ')}` : '';
  const countParams = [eventId, ...filterClauses.flatMap((f) => f.params)];
  const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS n ${def.fromSql}${whereForCount}`)
    .bind(...countParams)
    .first<{ n: number }>();

  const clauses = [...filterClauses];
  const listParams: unknown[] = [eventId];
  if (cursor) {
    const kw = keysetWhere(orderExpr, idExpr, direction, cursor);
    clauses.push({ sql: kw.sql, params: kw.binds });
  }
  const whereSql = clauses.length > 0 ? ` AND ${clauses.map((cl) => cl.sql).join(' AND ')}` : '';
  for (const cl of clauses) listParams.push(...cl.params);

  const dir = direction === 'desc' ? 'DESC' : 'ASC';
  const listSql = `${def.selectSql} ${def.fromSql}${whereSql} ORDER BY ${orderExpr} ${dir}, ${idExpr} ${dir} LIMIT ?`;
  const { results } = await c.env.DB.prepare(listSql).bind(...listParams, limit + 1).all();
  const rows = results as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = page[page.length - 1]!;
    const id = String(last.id);
    let v: string | number;
    if (rowKey === 'id') v = id;
    else {
      const raw = last[rowKey];
      v = raw === null || raw === undefined ? (numeric ? NULL_NUMBER_SENTINEL : NULL_TEXT_SENTINEL) : (raw as string | number);
    }
    nextCursor = encodeCursor({ v, id });
  }

  return c.json({
    data: page,
    total: totalRow?.n ?? 0,
    limit,
    offset: null,
    has_more: hasMore,
    next_cursor: nextCursor,
  });
}

// ---------------------------------------------------------------------------
// Generic list endpoint (must register after the specific routes above)
// ---------------------------------------------------------------------------

// GET /events/:event_id/:resource → { data, total, limit, offset, has_more }
// (?cursor= switches to keyset pagination, adding next_cursor.)
restApiRoutes.get('/events/:event_id/:resource', async (c) => {
  const resource = c.req.param('resource');
  const def = RESOURCES[resource];
  if (!def) {
    return apiError(
      c,
      404,
      'unknown_resource',
      `No resource named "${resource}". Available: ${Object.keys(RESOURCES).join(', ')}.`,
    );
  }

  const cursorRaw = c.req.query('cursor');
  if (cursorRaw !== undefined) return handleCursorList(c, resource, def, cursorRaw);

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
    next_cursor: null,
  });
});
