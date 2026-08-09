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
import { accessibleEventIds, accessibleEvents, isWriter, requireEventAccess, type AccessEnv } from '../access';
import { decodeCursor, encodeCursor, keysetWhere } from '../cursor';
import { bumpEventRevision, getEventRevision } from '../revision';
import { createSessionToken, getRevalidatedPrivilegedSession, setSessionCookie, type SessionPayload } from '../session';
import { formsAdminRoutes } from './formsAdmin';
import { evaluationRoutes } from './evaluation';
import { agendaRoutes } from './agenda';
import { dashboardRoutes } from './dashboard';

type ApiEnv = AccessEnv;

export const adminApiRoutes = new Hono<ApiEnv>();

// Guard every /app/api route with JSON errors (the /app HTML gate is separate).
// Reviewers (docs/06 §4) reach only /me and /app/api/review/*; everything else
// requires admin.
adminApiRoutes.use('*', async (c, next) => {
  const session = await getRevalidatedPrivilegedSession(c);
  if (!session) return c.json({ error: 'unauthenticated' }, 401);
  const actor: Actor = { contactId: session.contactId, email: session.email, role: session.role };
  if (!can(actor, 'review.view')) return c.json({ error: 'forbidden' }, 403);
  const reviewerSurface = c.req.path.startsWith('/app/api/review/') || c.req.path === '/app/api/me';
  if (!reviewerSurface && !can(actor, 'admin.view')) return c.json({ error: 'forbidden' }, 403);
  c.set('session', session);
  // Every route behind this guard can reach the workspace's accessible-event
  // set through `accessibleEvents(c)` / `requireEventAccess(c, id)` (access.ts),
  // which resolves it once per request and memoises it on this context. It is
  // deliberately lazy: per-event routes that only need session.eventId — agenda,
  // formsAdmin, evaluation — pay nothing until they adopt it.
  await next();
});

const EVENT_FILTER_DOC =
  'Restrict to one event. Omitted → every event this staff email can access in the organisation. Outside that set → 403.';

// GET /app/api/meta — self-description for API consumers, agents included.
// Derived from the same RESOURCES registry the query endpoint executes, so it
// cannot drift from reality; filter semantics come from filterDocs verbatim.
adminApiRoutes.get('/meta', (c) => {
  const resources: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(RESOURCES)) {
    resources[name] = {
      query: `POST /app/api/${name}/query`,
      request: {
        from: 'int ≥ 0',
        size: 'int 1–200',
        filters: 'object, see filters',
        sort: '{ field, direction: asc|desc } | omitted',
        cursor: 'string | omitted — "" asks for the first keyset page, then pass next_cursor',
      },
      response: '{ items: row[], total: int, next_cursor: string | null }',
      filters: Object.fromEntries([
        ...Object.keys(def.filters).map((key) => [key, def.filterDocs[key] ?? '']),
        ['event_id', EVENT_FILTER_DOC],
      ]),
      sortable: Object.keys(def.sortable),
    };
  }
  return c.json({
    resources,
    conventions: {
      scope:
        'Queries span every event in the organisation where this staff email holds a seat; every row carries event_id and event_name. Pass filters.event_id to narrow to one (403 outside the accessible set).',
      pagination:
        'from/size offset paging and cursor keyset paging both work. Cursor mode ignores from, returns next_cursor, and answers 400 { error: "invalid_cursor" } for a tampered value.',
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
  /** Keyset mode (sweep item P2-18): '' asks for the first page, an opaque
   * cursor asks for the page after it. Absent = classic from/offset paging. */
  cursor?: string;
}

/** Thrown for client-fixable query problems; routes map `code` to a 4xx body. */
export class QueryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'QueryError';
  }
}

/** A filter contributes a WHERE fragment plus its bound params. */
type FilterBuilder = (value: unknown) => { sql: string; params: unknown[] } | null;

export interface ResourceDef {
  /** FROM clause including joins, no WHERE — the workspace appends its own
   * `event_id IN (…)` scope, one placeholder per accessible event. */
  baseFrom: string;
  /** Single-event form, `${baseFrom} WHERE <eventExpr> = ?`, derived below.
   * The REST API (/api/v1) is event-addressed and builds on this one. */
  fromSql: string;
  selectSql: string;
  /** Column carrying the owning event id — the scope predicate and the
   * event_id/event_name row columns are built from it. */
  eventExpr: string;
  /** Unique row id expression; the keyset cursor's tiebreaker. */
  idExpr: string;
  /** sort field name → SQL expression (whitelist doubles as injection guard) */
  sortable: Record<string, string>;
  defaultSort: string;
  /** Single-column ordering used by cursor mode when no sort is requested
   * (defaultSort may be multi-column, which a keyset cannot express). */
  defaultCursorSort: { field: string; direction: 'asc' | 'desc' };
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
const RESOURCE_SPECS: Record<string, Omit<ResourceDef, 'fromSql'>> = {
  contacts: {
    baseFrom: 'FROM contacts c JOIN events ev ON ev.id = c.event_id',
    selectSql: 'SELECT c.*, ev.name AS event_name',
    eventExpr: 'c.event_id',
    idExpr: 'c.id',
    defaultCursorSort: { field: 'last_name', direction: 'asc' },
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
    baseFrom: `FROM submissions s
              JOIN events ev ON ev.id = s.event_id
              LEFT JOIN tracks t ON t.id = s.track_id
              LEFT JOIN contacts sc ON sc.id = s.submitter_contact_id
              LEFT JOIN evaluation_plans ep ON ep.id = s.evaluation_plan_id`,
    eventExpr: 's.event_id',
    idExpr: 's.id',
    defaultCursorSort: { field: 'created_at', direction: 'desc' },
    selectSql: `SELECT s.*, ev.name AS event_name, t.name AS track_name,
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
      // rating_cache is json { "<plan_id>": 4.2 } (0001_init.sql:218), kept
      // current by evaluation.ts refreshRatingCache — reading the cached value
      // costs one json_extract instead of a correlated AVG per row (P2-18).
      rating: `json_extract(s.rating_cache, '$."' || COALESCE(s.evaluation_plan_id, '') || '"')`,
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
    baseFrom: `FROM task_assignments ta
              JOIN tasks t ON t.id = ta.task_id
              JOIN events ev ON ev.id = t.event_id
              JOIN contacts c ON c.id = ta.contact_id
              LEFT JOIN submissions s ON s.id = ta.submission_id`,
    eventExpr: 't.event_id',
    idExpr: 'ta.id',
    defaultCursorSort: { field: 'due_at', direction: 'asc' },
    selectSql: `SELECT ta.id, ta.status, ta.completed_at, ta.submission_id, ta.contact_id,
                t.event_id AS event_id, ev.name AS event_name,
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
    baseFrom: `FROM message_log m
              JOIN events ev ON ev.id = m.event_id
              LEFT JOIN contacts mc ON mc.id = m.contact_id`,
    eventExpr: 'm.event_id',
    idExpr: 'm.id',
    defaultCursorSort: { field: 'created_at', direction: 'desc' },
    selectSql: `SELECT m.id, m.template_key, m.to_email, m.contact_id, m.subject, m.status,
                m.error, m.created_at, m.sent_at,
                m.event_id AS event_id, ev.name AS event_name,
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

// The single-event form every /api/v1 list and export builds on is derived
// from the same spec, so the two surfaces can never disagree about the joins.
export const RESOURCES: Record<string, ResourceDef> = Object.fromEntries(
  Object.entries(RESOURCE_SPECS).map(([name, def]) => [
    name,
    { ...def, fromSql: `${def.baseFrom} WHERE ${def.eventExpr} = ?` },
  ]),
);

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
  const cursor = typeof body.cursor === 'string' ? body.cursor : undefined;
  return { from, size, filters, sort, cursor };
}

/** Stable stringify (sorted keys) so an identical filter set hashes identically. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export interface QueryOptions {
  /** Enables the COUNT cache; without a revision the count is always fresh. */
  kv?: KVNamespace;
  revision?: string;
  resource?: string;
}

export interface QueryResult {
  items: Record<string, unknown>[];
  total: number;
  /** Cursor mode only: the cursor for the next page, or null at the end. */
  next_cursor: string | null;
}

const COUNT_CACHE_TTL_SECONDS = 300;

/**
 * Execute a registry query for one resource, scoped to an event. Shared by the
 * SPA's POST /:resource/query, the REST API's GET list endpoints and the
 * export endpoints — one executor, three surfaces.
 */
export async function queryResource(
  db: D1Database,
  def: ResourceDef,
  eventId: string | string[],
  { from, size, filters, sort, cursor }: QueryBody,
  opts: QueryOptions = {},
): Promise<QueryResult> {
  const eventIds = (Array.isArray(eventId) ? eventId : [eventId]).filter(Boolean);
  if (eventIds.length === 0) return { items: [], total: 0, next_cursor: null };

  // Event scoping first: every row of every resource belongs to exactly one
  // event, and the workspace spans the accessible set (never more).
  const where: string[] = [`${def.eventExpr} IN (${eventIds.map(() => '?').join(', ')})`];
  const params: unknown[] = [...eventIds];
  for (const [key, value] of Object.entries(filters)) {
    const builder = def.filters[key];
    if (!builder) continue; // unknown filter names are ignored, never interpolated
    const built = builder(value);
    if (!built) continue;
    where.push(built.sql);
    params.push(...built.params);
  }
  const whereSql = ` WHERE ${where.join(' AND ')}`;
  const countSql = `SELECT COUNT(*) AS n ${def.baseFrom}${whereSql}`;

  // Totals are the expensive half of a page read and change only when the
  // event does, so cache them per (resource, scope, filters, revision).
  const countPromise = (async (): Promise<number> => {
    const cacheable = opts.kv && opts.revision && opts.resource;
    let key = '';
    if (cacheable) {
      const digest = await sha256Hex(
        stableStringify({ e: [...eventIds].sort(), f: filters, r: opts.revision }),
      );
      key = `cnt:${opts.resource}:${digest}`;
      const hit = await opts.kv!.get(key);
      if (hit !== null) return Number(hit) || 0;
    }
    const row = await db.prepare(countSql).bind(...params).first<{ n: number }>();
    const total = row?.n ?? 0;
    if (cacheable) {
      await opts.kv!.put(key, String(total), { expirationTtl: COUNT_CACHE_TTL_SECONDS }).catch(() => {});
    }
    return total;
  })();

  // --- keyset mode (cursor present, '' = first page) ------------------------
  if (cursor !== undefined) {
    const field = sort && def.sortable[sort.field] ? sort.field : def.defaultCursorSort.field;
    const direction = sort && def.sortable[sort.field] ? sort.direction : def.defaultCursorSort.direction;
    // COALESCE keeps the ordering total: a NULL sort value would otherwise
    // compare false against every keyset bound and silently drop rows.
    const sortExpr = `COALESCE(${def.sortable[field] ?? def.idExpr}, '')`;
    const dir = direction === 'desc' ? 'DESC' : 'ASC';
    const keysetParams: unknown[] = [];
    if (cursor !== '') {
      const decoded = decodeCursor(cursor);
      if (!decoded) throw new QueryError('invalid_cursor');
      const clause = keysetWhere(sortExpr, def.idExpr, direction, decoded);
      where.push(clause.sql);
      keysetParams.push(...clause.binds);
    }
    const listSql =
      `${def.selectSql}, ${sortExpr} AS __cursor_v, ${def.idExpr} AS __cursor_id ` +
      `${def.baseFrom} WHERE ${where.join(' AND ')} ` +
      `ORDER BY ${sortExpr} ${dir}, ${def.idExpr} ${dir} LIMIT ?`;
    const list = await db.prepare(listSql).bind(...params, ...keysetParams, size + 1).all();
    const rows = list.results as Record<string, unknown>[];
    const page = rows.slice(0, size);
    const last = page[page.length - 1];
    const next_cursor =
      rows.length > size && last
        ? encodeCursor({ v: last.__cursor_v as string | number, id: String(last.__cursor_id) })
        : null;
    for (const row of page) {
      delete row.__cursor_v;
      delete row.__cursor_id;
    }
    return { items: page, total: await countPromise, next_cursor };
  }

  // --- classic offset mode (kept one release for the SPA's from/size) -------
  const orderSql =
    sort && def.sortable[sort.field]
      ? `${def.sortable[sort.field]} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}`
      : def.defaultSort;
  const listSql = `${def.selectSql} ${def.baseFrom}${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`;
  const list = await db.prepare(listSql).bind(...params, size, from).all();

  return { items: list.results as Record<string, unknown>[], total: await countPromise, next_cursor: null };
}

/**
 * The event ids a workspace query may read: the accessible set by default,
 * narrowed by an explicit `filters.event_id` which must be inside it.
 */
async function resolveQueryScope(
  c: Context<ApiEnv>,
  filters: Record<string, unknown>,
): Promise<{ ids: string[] } | { forbidden: true }> {
  const ids = await accessibleEventIds(c);
  const requested = typeof filters.event_id === 'string' ? filters.event_id.trim() : '';
  if (requested === '') return { ids };
  if (!ids.includes(requested)) return { forbidden: true };
  return { ids: [requested] };
}

/** One revision string covering every event in scope (the totals cache key). */
async function scopeRevision(env: Env, eventIds: string[]): Promise<string> {
  const revisions = await Promise.all(eventIds.map((id) => getEventRevision(env, id)));
  return revisions.join('|');
}

// POST /app/api/:resource/query → { items, total, next_cursor }
adminApiRoutes.post('/:resource/query', async (c) => {
  const resource = c.req.param('resource');
  const def = RESOURCES[resource];
  if (!def) return c.json({ error: 'unknown_resource' }, 404);

  const body = parseQueryBody(await c.req.json().catch(() => ({})));
  const scope = await resolveQueryScope(c, body.filters);
  if ('forbidden' in scope) return c.json({ error: 'event_not_accessible' }, 403);

  try {
    const result = await queryResource(c.env.DB, def, scope.ids, body, {
      kv: c.env.KV,
      revision: await scopeRevision(c.env, scope.ids),
      resource,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof QueryError) return c.json({ error: err.code }, 400);
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Contact CRUD (Speakers tab create/edit/delete — docs/12 M0.5)
// ---------------------------------------------------------------------------

// `notes` is organiser-only (manual review, "internal Notes field"): it rides
// the registry into the grid and the exports, and packages/core's redactor
// strips it from every speaker-facing read.
const CONTACT_FIELDS = [
  'email', 'first_name', 'last_name', 'company', 'job_title',
  'mobile_phone', 'biography', 'pronouns', 'notes',
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
  await bumpEventRevision(c.env, session.eventId);
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
    await bumpEventRevision(c.env, session.eventId);
  }
  const row = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ? AND event_id = ?')
    .bind(id, session.eventId)
    .first();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
});

// DELETE /contacts/:id — every dependent row either cascades or nulls out at
// the schema level, except the two references that point *at* an asset rather
// than at the contact: contacts.headshot_asset_id and the event's branding
// columns have no ON DELETE clause, so a contact whose own upload is still
// referenced sits on a mutual reference with file_assets.uploaded_by_contact_id
// (SET NULL). Clearing those pointers in the same batch as the delete removes
// the only ordering that could fail, and a constraint error is reported rather
// than surfacing as a 500 (manual review: "can't delete speaker").
adminApiRoutes.delete('/contacts/:id', async (c) => {
  const session = c.get('session');
  const id = c.req.param('id');
  const db = c.env.DB;

  let results;
  try {
    results = await db.batch([
      db.prepare('UPDATE contacts SET headshot_asset_id = NULL WHERE id = ? AND event_id = ?')
        .bind(id, session.eventId),
      db.prepare(
        `UPDATE events SET logo_asset_id = NULL
         WHERE id = ? AND logo_asset_id IN (SELECT id FROM file_assets WHERE uploaded_by_contact_id = ?)`,
      ).bind(session.eventId, id),
      db.prepare(
        `UPDATE events SET background_asset_id = NULL
         WHERE id = ? AND background_asset_id IN (SELECT id FROM file_assets WHERE uploaded_by_contact_id = ?)`,
      ).bind(session.eventId, id),
      db.prepare('DELETE FROM contacts WHERE id = ? AND event_id = ?').bind(id, session.eventId),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'delete_conflict', detail }, 409);
  }

  if ((results[3]?.meta.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404);
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Internal notes on a submission (manual review, approved)
// ---------------------------------------------------------------------------

const NOTES_MAX_CHARS = 10_000;

/** PUT /submissions/:id/notes { notes } — organiser-only, event-scoped. */
adminApiRoutes.put('/submissions/:id/notes', async (c) => {
  const session = c.get('session');
  // The guard already refuses reviewers (admin.view is owner/admin); this is
  // the explicit second lock on a field reviewers must never write.
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!('notes' in body)) return c.json({ error: 'notes_required' }, 400);
  const raw = body.notes;
  if (raw !== null && typeof raw !== 'string') return c.json({ error: 'invalid_notes' }, 400);
  const trimmed = raw === null ? null : raw.trim();
  const notes = trimmed === null || trimmed === '' ? null : trimmed.slice(0, NOTES_MAX_CHARS);

  const result = await c.env.DB.prepare(
    'UPDATE submissions SET notes = ?, updated_at = ? WHERE id = ? AND event_id = ?',
  )
    .bind(notes, new Date().toISOString(), c.req.param('id'), session.eventId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true, notes });
});

// ---------------------------------------------------------------------------
// Tasks CRUD (manual review: tasks were read-only in admin)
// ---------------------------------------------------------------------------

const TASK_ENUMS = {
  target: ['contact', 'group', 'submission'],
  assignment_mode: ['manual', 'automatic'],
  trigger: ['on_accept', 'on_schedule', 'none'],
  action_type: ['file_upload', 'portal_form', 'acknowledge', 'external_link'],
} as const;

interface TaskFields {
  values: Record<string, string | number | null>;
  error?: string;
}

/** Whitelist + validate a task body. `trigger` is a SQL keyword — always quoted. */
function pickTaskFields(raw: unknown, { requireTitle }: { requireTitle: boolean }): TaskFields {
  const body = (raw ?? {}) as Record<string, unknown>;
  const values: Record<string, string | number | null> = {};
  const fail = (error: string): TaskFields => ({ values: {}, error });

  if ('title' in body || requireTitle) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (title === '') return fail('title_required');
    values.title = title.slice(0, 200);
  }
  if ('description' in body) {
    const d = body.description;
    if (d !== null && typeof d !== 'string') return fail('invalid_description');
    values.description = d === null || d.trim() === '' ? null : d.trim().slice(0, 5000);
  }
  for (const key of ['target', 'assignment_mode', 'trigger', 'action_type'] as const) {
    if (!(key in body)) continue;
    const v = typeof body[key] === 'string' ? (body[key] as string) : '';
    if (!(TASK_ENUMS[key] as readonly string[]).includes(v)) return fail(`invalid_${key}`);
    values[key] = v;
  }
  for (const key of ['portal_form_id', 'file_request_id'] as const) {
    if (!(key in body)) continue;
    const v = body[key];
    if (v === null || v === '') values[key] = null;
    else if (typeof v === 'string') values[key] = v;
    else return fail(`invalid_${key}`);
  }
  if ('due_at' in body) {
    const v = body.due_at;
    if (v === null || v === '') values.due_at = null;
    else if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) values.due_at = new Date(v).toISOString();
    else return fail('invalid_due_at');
  }
  if ('reminder_offsets_days' in body) {
    const v = body.reminder_offsets_days;
    if (v === null || v === '') values.reminder_offsets_days = null;
    else if (Array.isArray(v) && v.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 365)) {
      values.reminder_offsets_days = JSON.stringify(v);
    } else return fail('invalid_reminder_offsets_days');
  }
  if ('required' in body) {
    const v = body.required;
    if (v === true || v === 1 || v === '1') values.required = 1;
    else if (v === false || v === 0 || v === '0' || v === null) values.required = 0;
    else return fail('invalid_required');
  }
  return { values };
}

/** Both reference columns must point inside the same event (tenant isolation). */
async function taskRefsBelongToEvent(
  db: D1Database,
  eventId: string,
  values: Record<string, string | number | null>,
): Promise<boolean> {
  const checks: Array<[string, string]> = [];
  if (typeof values.portal_form_id === 'string') checks.push(['portal_forms', values.portal_form_id]);
  if (typeof values.file_request_id === 'string') checks.push(['file_requests', values.file_request_id]);
  for (const [table, id] of checks) {
    const row = await db.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ? AND event_id = ?`)
      .bind(id, eventId).first();
    if (!row) return false;
  }
  return true;
}

const taskRow = (db: D1Database, id: string, eventId: string) =>
  db.prepare(
    `SELECT id, event_id, title, description, target, assignment_mode, "trigger", action_type,
            portal_form_id, file_request_id, due_at, reminder_offsets_days, required, created_at
     FROM tasks WHERE id = ? AND event_id = ?`,
  ).bind(id, eventId).first();

adminApiRoutes.post('/tasks', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const { values, error } = pickTaskFields(await c.req.json().catch(() => ({})), { requireTitle: true });
  if (error) return c.json({ error }, 400);
  if (!(await taskRefsBelongToEvent(c.env.DB, session.eventId, values))) {
    return c.json({ error: 'reference_not_in_event' }, 400);
  }

  const id = crypto.randomUUID();
  const cols = Object.keys(values);
  await c.env.DB.prepare(
    `INSERT INTO tasks (id, event_id, created_at${cols.map((k) => `, "${k}"`).join('')})
     VALUES (?, ?, ?${', ?'.repeat(cols.length)})`,
  )
    .bind(id, session.eventId, new Date().toISOString(), ...cols.map((k) => values[k]))
    .run();
  await bumpEventRevision(c.env, session.eventId);
  return c.json(await taskRow(c.env.DB, id, session.eventId), 201);
});

adminApiRoutes.put('/tasks/:id', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const { values, error } = pickTaskFields(await c.req.json().catch(() => ({})), { requireTitle: false });
  if (error) return c.json({ error }, 400);
  if (!(await taskRefsBelongToEvent(c.env.DB, session.eventId, values))) {
    return c.json({ error: 'reference_not_in_event' }, 400);
  }

  const cols = Object.keys(values);
  if (cols.length > 0) {
    const result = await c.env.DB.prepare(
      `UPDATE tasks SET ${cols.map((k) => `"${k}" = ?`).join(', ')} WHERE id = ? AND event_id = ?`,
    )
      .bind(...cols.map((k) => values[k]), id, session.eventId)
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
    await bumpEventRevision(c.env, session.eventId);
  }
  const row = await taskRow(c.env.DB, id, session.eventId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
});

adminApiRoutes.delete('/tasks/:id', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const result = await c.env.DB.prepare('DELETE FROM tasks WHERE id = ? AND event_id = ?')
    .bind(c.req.param('id'), session.eventId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Events: create (FR-EVT-1/2) + patch (agenda publish rides the same route)
// ---------------------------------------------------------------------------

const EVENT_TYPES = ['conference', 'workshop', 'summit', 'meetup', 'other'];
const SLUG_RE = /^[a-z0-9-]{2,64}$/;
const DESCRIPTION_MAX_CHARS = 1000;

const isoOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : null;

const looksLikeUrl = (value: string): boolean => /^https?:\/\/[^\s.]+\.[^\s]+$/i.test(value.trim());

interface EventFields {
  values: Record<string, string | number | null>;
  error?: string;
}

/** FR-EVT-2 fields, shared by create and patch. `theme` carries the description
 * (0001_init.sql:34 — the events table has no `description` column). */
function pickEventFields(raw: unknown, { require: mustHave }: { require: boolean }): EventFields {
  const body = (raw ?? {}) as Record<string, unknown>;
  const values: Record<string, string | number | null> = {};
  const fail = (error: string): EventFields => ({ values: {}, error });

  if (mustHave || 'name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '') return fail('name_required');
    values.name = name.slice(0, 200);
  }
  if (mustHave || 'slug' in body) {
    const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
    if (!SLUG_RE.test(slug)) return fail('invalid_slug');
    values.slug = slug;
  }
  if ('type' in body) {
    const type = typeof body.type === 'string' ? body.type : '';
    if (!EVENT_TYPES.includes(type)) return fail('invalid_type');
    values.type = type;
  }
  if ('website_url' in body) {
    const v = body.website_url;
    if (v === null || v === '') values.website_url = null;
    else if (typeof v === 'string' && looksLikeUrl(v)) values.website_url = v.trim();
    else return fail('invalid_website_url');
  }
  if ('location' in body) {
    const v = body.location;
    if (v === null || v === '') values.location = null;
    else if (typeof v === 'string') values.location = v.trim().slice(0, 200);
    else return fail('invalid_location');
  }
  if ('timezone' in body) {
    const v = typeof body.timezone === 'string' ? body.timezone.trim() : '';
    if (v === '') return fail('invalid_timezone');
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: v });
    } catch {
      return fail('invalid_timezone');
    }
    values.timezone = v;
  }
  if (mustHave || 'starts_at' in body) {
    const starts = isoOrNull(body.starts_at);
    if (!starts) return fail('invalid_starts_at');
    values.starts_at = starts;
  }
  if (mustHave || 'ends_at' in body) {
    const ends = isoOrNull(body.ends_at);
    if (!ends) return fail('invalid_ends_at');
    values.ends_at = ends;
  }
  if (typeof values.starts_at === 'string' && typeof values.ends_at === 'string'
      && Date.parse(values.ends_at) < Date.parse(values.starts_at)) {
    return fail('ends_before_starts');
  }
  if ('description' in body) {
    const v = body.description;
    if (v === null || v === '') values.theme = null;
    else if (typeof v === 'string') {
      if (v.length > DESCRIPTION_MAX_CHARS) return fail('description_too_long');
      values.theme = v.trim();
    } else return fail('invalid_description');
  }
  return { values };
}

// POST /app/api/events — a new event inside the creator's organisation. The
// creator lands in it as an owner, which needs a contacts row too: contacts
// are event-scoped, so the seat and its person are created with the event.
adminApiRoutes.post('/events', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const db = c.env.DB;

  const { values, error } = pickEventFields(await c.req.json().catch(() => ({})), { require: true });
  if (error) return c.json({ error }, 400);

  const org = await db.prepare('SELECT org_id FROM events WHERE id = ?')
    .bind(session.eventId).first<{ org_id: string }>();
  if (!org) return c.json({ error: 'not_found' }, 404);

  const slug = values.slug as string;
  const taken = await db.prepare('SELECT 1 AS ok FROM events WHERE slug = ?').bind(slug).first();
  if (taken) return c.json({ error: 'slug_taken' }, 409);

  const me = await db.prepare('SELECT first_name, last_name FROM contacts WHERE id = ?')
    .bind(session.contactId).first<{ first_name: string | null; last_name: string | null }>();

  const id = crypto.randomUUID();
  const contactId = crypto.randomUUID();
  const ts = new Date().toISOString();
  const cols = Object.keys(values);
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO events (id, org_id, timezone, created_at, updated_at${cols.map((k) => `, ${k}`).join('')})
         VALUES (?, ?, ?, ?, ?${', ?'.repeat(cols.length)})`,
      ).bind(
        id,
        org.org_id,
        (values.timezone as string | undefined) ?? c.env.EVENT_DEFAULT_TZ,
        ts,
        ts,
        ...cols.map((k) => values[k]),
      ),
      db.prepare(
        `INSERT INTO contacts (id, event_id, email, first_name, last_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(contactId, id, session.email, me?.first_name ?? null, me?.last_name ?? null, ts, ts),
      db.prepare(
        `INSERT INTO event_users (event_id, contact_id, role, invited_at, accepted_at)
         VALUES (?, ?, 'owner', ?, ?)`,
      ).bind(id, contactId, ts, ts),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('UNIQUE')) return c.json({ error: 'slug_taken' }, 409);
    throw err;
  }
  await bumpEventRevision(c.env, id);
  return c.json({ ok: true, id }, 201);
});

// PATCH /app/api/events/:id — FR-EVT-2 edits plus the agenda go-live flag
// (FR-AGENDA-9). Only events inside the caller's accessible set.
adminApiRoutes.patch('/events/:id', async (c) => {
  const session = c.get('session');
  const eventId = c.req.param('id');
  const seat = await requireEventAccess(c, eventId);
  if (!seat && eventId !== session.eventId) return c.json({ error: 'event_not_accessible' }, 403);
  if (!isWriter(seat?.role ?? session.role)) return c.json({ error: 'forbidden' }, 403);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { values, error } = pickEventFields(body, { require: false });
  if (error) return c.json({ error }, 400);

  if ('agenda_published' in body) {
    const v = body.agenda_published;
    if (v === true || v === 1 || v === '1') values.agenda_published = 1;
    else if (v === false || v === 0 || v === '0') values.agenda_published = 0;
    else return c.json({ error: 'invalid_agenda_published' }, 400);
  }
  // A patch that only re-sends starts_at/ends_at must still be range-checked
  // against the stored value it does not carry.
  if (typeof values.starts_at === 'string' || typeof values.ends_at === 'string') {
    const current = await c.env.DB.prepare('SELECT starts_at, ends_at FROM events WHERE id = ?')
      .bind(eventId).first<{ starts_at: string; ends_at: string }>();
    const starts = (values.starts_at as string | undefined) ?? current?.starts_at ?? '';
    const ends = (values.ends_at as string | undefined) ?? current?.ends_at ?? '';
    if (starts && ends && Date.parse(ends) < Date.parse(starts)) {
      return c.json({ error: 'ends_before_starts' }, 400);
    }
  }

  const cols = Object.keys(values);
  if (cols.length === 0) return c.json({ error: 'nothing_to_update' }, 400);
  try {
    const result = await c.env.DB.prepare(
      `UPDATE events SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    )
      .bind(...cols.map((k) => values[k]), new Date().toISOString(), eventId)
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('UNIQUE')) return c.json({ error: 'slug_taken' }, 409);
    throw err;
  }
  await bumpEventRevision(c.env, eventId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Bulk jobs (sweep item P2-19) — progress for the 202-style bulk routes.
// ---------------------------------------------------------------------------

// GET /app/api/bulk-jobs/:id → { id, kind, status, total, enqueued, sent, failed, error }
//
// Progress for all three producers of a bulk_jobs row: this file's remind
// handler ('remind-tasks'), agenda send-confirmations (BE-1) and evaluation
// send-decisions (BE-4). `enqueued` is the expander's own counter on the row.
// sent/failed are counted from message_log: the expander sends with
// entityId = "<jobId>:<naturalId>", so the key reads
// "<template>:<contactId>:<jobId>:<naturalId>:v<version>" — the job id is an
// interior segment, matched as ':<jobId>:' (frozen contract with BE-4).
adminApiRoutes.get('/bulk-jobs/:id', async (c) => {
  const session = c.get('session');
  const jobId = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT j.id, j.kind, j.status, j.total, j.enqueued, j.error,
            (SELECT COUNT(*) FROM message_log m
              WHERE m.idempotency_key LIKE '%:' || ?1 || ':%' AND m.status = 'sent') AS sent,
            (SELECT COUNT(*) FROM message_log m
              WHERE m.idempotency_key LIKE '%:' || ?1 || ':%' AND m.status = 'failed') AS failed
     FROM bulk_jobs j WHERE j.id = ?1 AND j.event_id = ?2`,
  )
    .bind(jobId, session.eventId)
    .first();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
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

/** The workspace's event list: the accessible set, with the shell's fields. */
async function listWorkspaceEvents(c: Context<ApiEnv>): Promise<AdminEventRow[]> {
  const accessible = await accessibleEvents(c);
  if (accessible.length === 0) return [];
  const byId = new Map(accessible.map((e) => [e.event_id, e]));
  const placeholders = accessible.map(() => '?').join(', ');
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, slug, starts_at, ends_at FROM events WHERE id IN (${placeholders}) ORDER BY starts_at`,
  )
    .bind(...byId.keys())
    .all<Omit<AdminEventRow, 'role' | 'contact_id'>>();
  return results.map((row) => ({
    ...row,
    role: byId.get(row.id)!.role,
    contact_id: byId.get(row.id)!.contact_id,
  }));
}

// GET /app/api/me — who am I, which event am I in, which events does the
// workspace span. `events` is the accessible set (event-as-filter model), so
// reviewer seats appear here too, not just owner/admin ones.
adminApiRoutes.get('/me', async (c) => {
  const session = c.get('session');
  const [event, events] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, slug, starts_at, ends_at, timezone FROM events WHERE id = ?')
      .bind(session.eventId)
      .first(),
    listWorkspaceEvents(c),
  ]);
  return c.json({
    email: session.email,
    role: session.role,
    event,
    events: events.map(({ id, name, slug, starts_at, ends_at }) => ({ id, name, slug, starts_at, ends_at })),
  });
});

// POST /app/api/switch-event { event_id } — re-mint the session for another
// accessible event (the switcher never crosses a permission line). Kept for
// compatibility with the per-event surfaces; workspace lists no longer need it.
adminApiRoutes.post('/switch-event', async (c) => {
  const session = c.get('session');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const eventId = typeof body.event_id === 'string' ? body.event_id : '';
  const seat = await requireEventAccess(c, eventId);
  if (!seat) return c.json({ error: 'not_an_admin_of_event' }, 403);
  const target = await c.env.DB.prepare('SELECT slug FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ slug: string }>();
  if (!target) return c.json({ error: 'not_found' }, 404);

  const token = await createSessionToken(
    {
      v: 2,
      orgId: session.orgId,
      contactId: seat.contact_id,
      eventId: seat.event_id,
      eventSlug: target.slug,
      email: session.email,
      role: seat.role,
    },
    c.env.SESSION_SECRET,
  );
  setSessionCookie(c, token);
  return c.json({ ok: true });
});
