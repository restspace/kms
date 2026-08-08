// JSON API for the admin SPA workspace (docs/12 M0.5). Generic list endpoint
// pattern: POST /:resource/query with { from, size, filters, sort } in and
// { items, total } out. Relation filters translate to EXISTS subqueries against
// join tables — the tabs never see junction rows (docs/12 §0). Every filter and
// sort field is whitelisted here; all values travel as bound parameters.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { can } from '@kms/core';
import type { Actor, Role } from '@kms/core';
import type { AppEnv, Env } from '../env';
import { sha256Hex } from '../hashing';
import { createSessionToken, getSession, setSessionCookie, type SessionPayload } from '../session';
import { formsAdminRoutes } from './formsAdmin';
import { evaluationRoutes } from './evaluation';
import { agendaRoutes } from './agenda';
import { dashboardRoutes } from './dashboard';

type ApiEnv = { Bindings: Env; Variables: { session: SessionPayload } };

export const adminApiRoutes = new Hono<ApiEnv>();

// Guard every /app/api route with JSON errors (the /app HTML gate is separate).
// Reviewers (docs/06 §4) reach only /me and /app/api/review/*; everything else
// requires admin.
adminApiRoutes.use('*', async (c, next) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: 'unauthenticated' }, 401);
  const actor: Actor = { contactId: session.contactId, email: session.email, role: session.role };
  if (!can(actor, 'review.view')) return c.json({ error: 'forbidden' }, 403);
  const reviewerSurface = c.req.path.startsWith('/app/api/review/') || c.req.path === '/app/api/me';
  if (!reviewerSurface && !can(actor, 'admin.view')) return c.json({ error: 'forbidden' }, 403);
  c.set('session', session);
  await next();
});

// GET /app/api/meta — self-description for API consumers, agents included.
// Derived from the same RESOURCES registry the query endpoint executes, so it
// cannot drift from reality; filter semantics come from filterDocs verbatim.
adminApiRoutes.get('/meta', (c) => {
  const resources: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(RESOURCES)) {
    resources[name] = {
      query: `POST /app/api/${name}/query`,
      request: { from: 'int ≥ 0', size: 'int 1–200', filters: 'object, see filters', sort: '{ field, direction: asc|desc } | omitted' },
      response: '{ items: row[], total: int }',
      filters: Object.fromEntries(
        Object.keys(def.filters).map((key) => [key, def.filterDocs[key] ?? '']),
      ),
      sortable: Object.keys(def.sortable),
    };
  }
  return c.json({
    resources,
    conventions: {
      scope: 'Every request is scoped to the event bound to the current session.',
      errors: 'Non-2xx responses carry { error: <machine_code> }; validation failures add errors: [{ question_id, code, message }].',
      unknown_filters: 'Unknown filter names are ignored, never an error.',
      forms_create: 'POST /app/api/forms accepts idempotency_key; replays within 24 h return the originally created form.',
      forms_update: 'PUT /app/api/forms/:id accepts expected_updated_at; a stale value yields 409 { error: "conflict", current_updated_at }.',
      json_columns: 'Structured columns (routing_rules, participant_roles, visibility, options, notify lists) are parsed JSON in responses; requests may send them as objects.',
    },
  });
});

// Form builder + question endpoints (docs/04) — inherits the guard above.
adminApiRoutes.route('/forms', formsAdminRoutes);

// Review & scoring: submission ops, evaluation admin, reviewer surface (docs/06).
adminApiRoutes.route('/', evaluationRoutes);

// Agenda & scheduling (docs/07) — board payload, schedule writes, conflicts.
adminApiRoutes.route('/agenda', agendaRoutes);

// Dashboards (docs/09) — aggregates with ETag polling, reminder sends.
adminApiRoutes.route('/dashboard', dashboardRoutes);

// GET /app/api/builder-meta — everything the builder's pickers need: the
// field library, and routing-rule targets (tracks, tags, evaluation plans).
adminApiRoutes.get('/builder-meta', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const [fields, tracks, tags, plans] = await Promise.all([
    db.prepare('SELECT id, key, label, type, scope, options, max_chars, system FROM field_definitions WHERE event_id = ? ORDER BY label').bind(session.eventId).all(),
    db.prepare('SELECT id, name, color FROM tracks WHERE event_id = ? ORDER BY position').bind(session.eventId).all(),
    db.prepare('SELECT id, name, color FROM tags WHERE event_id = ? ORDER BY name').bind(session.eventId).all(),
    db.prepare('SELECT id, name, status FROM evaluation_plans WHERE event_id = ? ORDER BY name').bind(session.eventId).all(),
  ]);
  return c.json({
    fields: fields.results,
    tracks: tracks.results,
    tags: tags.results,
    plans: plans.results,
  });
});

// ---------------------------------------------------------------------------
// Query endpoint machinery
// ---------------------------------------------------------------------------

export interface QueryBody {
  from: number;
  size: number;
  filters: Record<string, unknown>;
  sort?: { field: string; direction: 'asc' | 'desc' };
}

/** A filter contributes a WHERE fragment plus its bound params. */
type FilterBuilder = (value: unknown) => { sql: string; params: unknown[] } | null;

export interface ResourceDef {
  /** FROM clause including joins; `?1` is always the event id. */
  fromSql: string;
  selectSql: string;
  /** sort field name → SQL expression (whitelist doubles as injection guard) */
  sortable: Record<string, string>;
  defaultSort: string;
  filters: Record<string, FilterBuilder>;
  /** One line of intent per filter — served verbatim by GET /app/api/meta so
   * agent tooling learns the vocabulary from the registry, not from docs. */
  filterDocs: Record<string, string>;
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

// Exported: the REST API (/api/v1) and its OpenAPI document are generated from
// this same registry, so the public surface cannot drift from the SPA's.
export const RESOURCES: Record<string, ResourceDef> = {
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
      contact_id: eq('c.id'),
      // Dashboard deep-link (docs/09 §1): accepted speakers whose programme
      // profile is incomplete.
      missing_assets: (value) =>
        value === true || value === 'true'
          ? {
              sql: `(c.biography IS NULL OR c.biography = '' OR c.headshot_asset_id IS NULL)
                    AND EXISTS (SELECT 1 FROM submission_participants sp
                                JOIN submissions s ON s.id = sp.submission_id
                                WHERE sp.contact_id = c.id AND s.status = 'accepted')`,
              params: [],
            }
          : null,
    },
    filterDocs: {
      q: 'Free-text match over first name, last name, email and company.',
      submission_id:
        'Contacts related to this submission: its participants (any role) or its submitter.',
      contact_id: 'Exactly this contact. The global anchor filter uses this.',
      missing_assets:
        'true → accepted speakers missing a biography or headshot (the programme-completeness list).',
    },
  },

  submissions: {
    fromSql: `FROM submissions s
              LEFT JOIN tracks t ON t.id = s.track_id
              LEFT JOIN contacts sc ON sc.id = s.submitter_contact_id
              LEFT JOIN evaluation_plans ep ON ep.id = s.evaluation_plan_id
              WHERE s.event_id = ?`,
    selectSql: `SELECT s.*, t.name AS track_name,
                NULLIF(TRIM(COALESCE(sc.first_name, '') || ' ' || COALESCE(sc.last_name, '')), '') AS submitter_name,
                ep.name AS plan_name,
                (SELECT ROUND(AVG(r.weighted_total), 2) FROM reviews r
                 WHERE r.submission_id = s.id AND r.plan_id = s.evaluation_plan_id) AS rating,
                (SELECT COUNT(*) FROM reviews r
                 WHERE r.submission_id = s.id AND r.plan_id = s.evaluation_plan_id) AS review_count`,
    sortable: {
      code: 's.code',
      title: 's.title',
      status: 's.status',
      format: 's.format',
      track_name: 't.name',
      submitter_name: 'sc.last_name',
      created_at: 's.created_at',
      notified_at: 's.notified_at',
      rating: `(SELECT AVG(r.weighted_total) FROM reviews r
                WHERE r.submission_id = s.id AND r.plan_id = s.evaluation_plan_id)`,
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
    filterDocs: {
      q: 'Free-text match over title and code.',
      status:
        'Exact status: draft | pending | accept_queue | accepted | decline_queue | declined | withdrawn.',
      track_id: 'Submissions on this track.',
      tag_id: 'Submissions carrying this tag.',
      submitter_contact_id: 'Submissions this contact submitted (the narrow relation).',
      participant_contact_id:
        'Submissions this contact appears on as a participant, any role (the narrow relation).',
      contact_id:
        "Submissions that are this contact's in the broad sense: submitted by them OR with them as a participant. The global anchor filter uses this.",
    },
  },

  // Tasks tab (docs/12 M3): assignments joined to task + contact, receiving
  // both the contact and submission anchors.
  tasks: {
    fromSql: `FROM task_assignments ta
              JOIN tasks t ON t.id = ta.task_id
              JOIN contacts c ON c.id = ta.contact_id
              LEFT JOIN submissions s ON s.id = ta.submission_id
              WHERE t.event_id = ?`,
    selectSql: `SELECT ta.id, ta.status, ta.completed_at, ta.submission_id, ta.contact_id,
                t.id AS task_id, t.title AS task_title, t.action_type, t.due_at, t.required,
                NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '') AS assignee_name,
                c.email AS assignee_email, s.code AS submission_code, s.title AS submission_title`,
    sortable: {
      task_title: 't.title',
      assignee_name: 'c.last_name',
      status: 'ta.status',
      due_at: 't.due_at',
      completed_at: 'ta.completed_at',
    },
    defaultSort: `CASE WHEN ta.status = 'complete' THEN 1 ELSE 0 END, t.due_at`,
    filters: {
      q: (value) => {
        const v = asText(value);
        if (v === null) return null;
        const like = `%${v}%`;
        return {
          sql: '(t.title LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ?)',
          params: [like, like, like, like],
        };
      },
      status: (value) => {
        const v = asText(value);
        return v !== null && ['not_started', 'in_progress', 'complete'].includes(v)
          ? { sql: 'ta.status = ?', params: [v] }
          : null;
      },
      task_id: eq('ta.task_id'),
      contact_id: eq('ta.contact_id'),
      submission_id: eq('ta.submission_id'),
      overdue: (value) =>
        value === true || value === 'true'
          ? { sql: `ta.status != 'complete' AND t.due_at IS NOT NULL AND t.due_at < ?`, params: [new Date().toISOString()] }
          : null,
    },
    filterDocs: {
      q: 'Free-text match over task title and assignee name/email.',
      status: 'Exact assignment status: not_started | in_progress | complete.',
      task_id: 'Assignments of this task.',
      contact_id: 'Assignments belonging to this contact. The global anchor filter uses this.',
      submission_id: 'Assignments tied to this submission. The global anchor filter uses this.',
      overdue: 'true → incomplete assignments past their due date.',
    },
  },

  // Comms debugging (docs/12 M2 stretch): "every email we sent this speaker"
  // is one anchor click in the workspace Messages tab.
  messages: {
    fromSql: `FROM message_log m
              LEFT JOIN contacts mc ON mc.id = m.contact_id
              WHERE m.event_id = ?`,
    selectSql: `SELECT m.id, m.template_key, m.to_email, m.contact_id, m.subject, m.status,
                m.error, m.created_at, m.sent_at,
                NULLIF(TRIM(COALESCE(mc.first_name, '') || ' ' || COALESCE(mc.last_name, '')), '') AS contact_name`,
    sortable: {
      created_at: 'm.created_at',
      sent_at: 'm.sent_at',
      template_key: 'm.template_key',
      to_email: 'm.to_email',
      status: 'm.status',
    },
    defaultSort: 'm.created_at DESC',
    filters: {
      q: (value) => {
        const v = asText(value);
        if (v === null) return null;
        const like = `%${v}%`;
        return { sql: '(m.to_email LIKE ? OR m.subject LIKE ?)', params: [like, like] };
      },
      template_key: eq('m.template_key'),
      status: eq('m.status'),
      contact_id: eq('m.contact_id'),
    },
    filterDocs: {
      q: 'Free-text match over recipient email and subject.',
      template_key: 'Exact template key, e.g. submission_confirmation, magic_link, task_reminder.',
      status: 'Exact status: queued | sent | failed | bounced.',
      contact_id: 'Messages sent to this contact. The global anchor filter uses this.',
    },
  },
};

export function parseQueryBody(raw: unknown): QueryBody {
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

/**
 * Execute a registry query for one resource, scoped to an event. Shared by the
 * SPA's POST /:resource/query, the REST API's GET list endpoints and the
 * export endpoints — one executor, three surfaces.
 */
export async function queryResource(
  db: D1Database,
  def: ResourceDef,
  eventId: string,
  { from, size, filters, sort }: QueryBody,
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [eventId];
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
    db.prepare(listSql).bind(...params, size, from).all(),
    db.prepare(countSql).bind(...params).first<{ n: number }>(),
  ]);

  return { items: list.results as Record<string, unknown>[], total: count?.n ?? 0 };
}

// POST /app/api/:resource/query → { items, total }
adminApiRoutes.post('/:resource/query', async (c) => {
  const def = RESOURCES[c.req.param('resource')];
  if (!def) return c.json({ error: 'unknown_resource' }, 404);

  const session = c.get('session');
  const body = parseQueryBody(await c.req.json().catch(() => ({})));
  return c.json(await queryResource(c.env.DB, def, session.eventId, body));
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
// API tokens (Settings → API tokens; docs/10 §1, docs/12 M6)
// ---------------------------------------------------------------------------

/** The organisation owning the session's event — API tokens are org-scoped. */
async function sessionOrgId(c: Context<ApiEnv>): Promise<string | null> {
  const row = await c.env.DB.prepare('SELECT org_id FROM events WHERE id = ?')
    .bind(c.get('session').eventId)
    .first<{ org_id: string }>();
  return row?.org_id ?? null;
}

adminApiRoutes.get('/tokens', async (c) => {
  const orgId = await sessionOrgId(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, token_prefix, created_at, last_used_at, revoked_at
     FROM api_tokens WHERE org_id = ? ORDER BY created_at DESC`,
  )
    .bind(orgId)
    .all();
  return c.json({ tokens: results });
});

// POST /tokens { name } — the secret is returned exactly once; only its hash
// is stored (docs/10 §1: bearer tokens, org-scoped).
adminApiRoutes.post('/tokens', async (c) => {
  const orgId = await sessionOrgId(c);
  if (!orgId) return c.json({ error: 'not_found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : 'API token';

  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const token = 'kms_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO api_tokens (id, org_id, name, token_hash, token_prefix, created_by_contact_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, orgId, name, await sha256Hex(token), token.slice(0, 12), c.get('session').contactId, new Date().toISOString())
    .run();
  return c.json({ id, name, token, token_prefix: token.slice(0, 12) }, 201);
});

adminApiRoutes.delete('/tokens/:id', async (c) => {
  const orgId = await sessionOrgId(c);
  const result = await c.env.DB.prepare(
    'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL',
  )
    .bind(new Date().toISOString(), c.req.param('id'), orgId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// POST /demo/reset — replay the seed (docs/12 §2's "reset demo data" button).
// Gated on DEMO_RESET so a real deployment can never be wiped from the UI.
adminApiRoutes.post('/demo/reset', async (c) => {
  if (c.env.DEMO_RESET !== 'on') return c.json({ error: 'demo_reset_disabled' }, 403);
  const { resetDemoData } = await import('../demo');
  const statements = await resetDemoData(c.env.DB);
  return c.json({ ok: true, statements });
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
