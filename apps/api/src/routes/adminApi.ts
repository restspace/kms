// JSON API for the admin SPA workspace (docs/12 M0.5). Generic list endpoint
// pattern: POST /:resource/query with { from, size, filters, sort } in and
// { items, total } out. Relation filters translate to EXISTS subqueries against
// join tables — the tabs never see junction rows (docs/12 §0). Every filter and
// sort field is whitelisted here; all values travel as bound parameters.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { can } from '@kms/core';
import type { Actor, Role } from '@kms/core';
import { createDb } from '@kms/db';
import type { AppEnv, Env } from '../env';
import { sha256Hex } from '../hashing';
import { accessibleEventIds, accessibleEvents, isWriter, requireEventAccess, type AccessEnv } from '../access';
import { decodeCursor, encodeCursor, keysetWhere } from '../cursor';
import { bumpEventRevision, getEventRevision } from '../revision';
import { createSessionToken, getRevalidatedPrivilegedSession, setSessionCookie, type SessionPayload } from '../session';
import { IMAGE_TYPES, MAX_HEADSHOT_BYTES, saveFile } from '../filestore';
import { appendUploadVersion } from '../fileVersions';
import { formsAdminRoutes } from './formsAdmin';
import { evaluationRoutes } from './evaluation';
import { agendaRoutes } from './agenda';
import { stageAirtableDeletes } from '../airtableStage';
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

// Last-resort safety net: any exception that escapes a route handler below
// (this file's own, or a mounted sub-router's) used to propagate past Hono
// entirely and come back to the browser as a bare network-level "Failed to
// fetch" rather than a status code the UI could render (manual review: the
// Review section and a freshly created event's workspace both died this
// way). Individual hot paths get their own try/catch for a precise error
// code; this is the floor under everything else in /app/api.
adminApiRoutes.onError((err, c) => {
  console.error(`${c.req.method} ${c.req.path} failed`, err);
  const message = err instanceof Error ? err.message : 'unknown_error';
  return c.json({ error: 'internal_error', message }, 500);
});

// GET /app/api/builder-meta — everything the builder's pickers need: the
// field library, and routing-rule targets (tracks, tags, evaluation plans).
adminApiRoutes.get('/builder-meta', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  try {
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
  } catch (err) {
    console.error('GET /builder-meta failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    return c.json({ error: 'builder_meta_failed', message }, 500);
  }
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
    // The join to event_contacts is both the membership filter and the source of
    // the profile columns, so a query that omits it loses the columns it came
    // for rather than silently widening from event to org (0015 / workplan §1).
    baseFrom:
      'FROM contacts c JOIN event_contacts ec ON ec.contact_id = c.id JOIN events ev ON ev.id = ec.event_id',
    // custom_fields_json: `{ <definition key>: value }` for this contact's
    // event, NULL when it has none set (json_group_object over zero rows) —
    // same shape POST/PUT /contacts echo back via contactWithCustomFields.
    // confirmation: 'confirmed' when at least one submission_participants row
    // for this contact has confirmed_at set, 'awaiting' when it appears as a
    // participant but none of its rows are confirmed, NULL when it is not a
    // participant at all (never invited to confirm — distinct from awaiting).
    selectSql: `SELECT c.*, ev.name AS event_name,
        ec.event_id, ec.biography, ec.headshot_asset_id, ec.company, ec.job_title,
        ec.notes, ec.added_at, ec.source,
        (SELECT json_group_object(d.key, v.value) FROM contact_field_values v
         JOIN contact_field_definitions d ON d.id = v.field_id
         WHERE v.contact_id = c.id AND d.event_id = ec.event_id) AS custom_fields_json,
        (CASE
           WHEN EXISTS (SELECT 1 FROM submission_participants sp JOIN submissions s ON s.id = sp.submission_id
                         WHERE sp.contact_id = c.id AND s.event_id = ec.event_id AND sp.confirmed_at IS NOT NULL) THEN 'confirmed'
           WHEN EXISTS (SELECT 1 FROM submission_participants sp JOIN submissions s ON s.id = sp.submission_id
                         WHERE sp.contact_id = c.id AND s.event_id = ec.event_id) THEN 'awaiting'
           ELSE NULL
         END) AS confirmation`,
    eventExpr: 'ec.event_id',
    idExpr: 'c.id',
    defaultCursorSort: { field: 'last_name', direction: 'asc' },
    sortable: {
      first_name: 'c.first_name',
      last_name: 'c.last_name',
      email: 'c.email',
      company: 'ec.company',
      job_title: 'ec.job_title',
      created_at: 'c.created_at',
    },
    defaultSort: 'c.last_name ASC, c.first_name ASC',
    filters: {
      q: (value) => {
        const v = asText(value);
        if (v === null) return null;
        const like = `%${v}%`;
        return {
          sql: '(c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR ec.company LIKE ?)',
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
      // SPK-04: roster filter mirroring the `confirmation` column above —
      // kept as its own EXISTS pair rather than wrapping the column expression
      // so it stays sargable (no correlated subquery inside a WHERE on a
      // computed SELECT column).
      confirmation: (value) => {
        const v = asText(value);
        if (v === 'confirmed') {
          return {
            sql: `EXISTS (SELECT 1 FROM submission_participants sp JOIN submissions s ON s.id = sp.submission_id
                           WHERE sp.contact_id = c.id AND s.event_id = ec.event_id AND sp.confirmed_at IS NOT NULL)`,
            params: [],
          };
        }
        if (v === 'awaiting') {
          return {
            sql: `EXISTS (SELECT 1 FROM submission_participants sp JOIN submissions s ON s.id = sp.submission_id
                           WHERE sp.contact_id = c.id AND s.event_id = ec.event_id)
                  AND NOT EXISTS (SELECT 1 FROM submission_participants sp JOIN submissions s ON s.id = sp.submission_id
                                   WHERE sp.contact_id = c.id AND s.event_id = ec.event_id AND sp.confirmed_at IS NOT NULL)`,
            params: [],
          };
        }
        return null;
      },
      // Dashboard deep-link (docs/09 §1): accepted speakers whose programme
      // profile is incomplete.
      missing_assets: (value) =>
        value === true || value === 'true'
          ? {
              sql: `(ec.biography IS NULL OR ec.biography = '' OR ec.headshot_asset_id IS NULL)
                    AND EXISTS (SELECT 1 FROM submission_participants sp
                                JOIN submissions s ON s.id = sp.submission_id
                                WHERE sp.contact_id = c.id AND s.event_id = ec.event_id
                                  AND s.status = 'accepted')`,
              params: [],
            }
          : null,
    },
    filterDocs: {
      q: 'Free-text match over first name, last name, email and company.',
      submission_id:
        'Contacts related to this submission: its participants (any role) or its submitter.',
      contact_id: 'Exactly this contact. The global anchor filter uses this.',
      confirmation:
        "confirmed → has a submission_participants row with confirmed_at set. awaiting → is a participant somewhere but none of those rows are confirmed. Not a participant at all is neither (its `confirmation` column reads null) and this filter never matches it.",
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
                -- Across every round the submission has been scored in, not
                -- just the legacy evaluation_plan_id routing column: since
                -- 0012 a submission can sit in a round it was never routed to,
                -- and filtering on that column blanked the Ratings column for
                -- exactly those (reviews recorded, nothing shown).
                (SELECT ROUND(AVG(r.weighted_total), 2) FROM reviews r
                 WHERE r.submission_id = s.id) AS rating,
                (SELECT COUNT(*) FROM reviews r
                 WHERE r.submission_id = s.id) AS review_count`,
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
      // current by evaluation.ts ratingCacheStatement — sorting off the cache
      // costs a walk of one small json object instead of a correlated AVG over
      // reviews per row (P2-18). Averaging every key, rather than reading the
      // legacy `evaluation_plan_id` one, keeps the sort in step with the
      // `rating` column above for submissions scored in a round they were
      // never routed to; no cache entry (never scored) still sorts as NULL.
      rating: `(SELECT AVG(je.value) FROM json_each(COALESCE(s.rating_cache, '{}')) je)`,
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
  // A NULL sort value (e.g. an unscored submission's `rating`) always sorts
  // after every real value, in both directions — SQLite's native NULL-is-
  // smallest rule would otherwise put unscored rows first on an ASC sort,
  // ahead of genuinely low scores, which reads as backwards in the grid.
  const orderSql =
    sort && def.sortable[sort.field]
      ? `(CASE WHEN ${def.sortable[sort.field]} IS NULL THEN 1 ELSE 0 END) ASC, ${def.sortable[sort.field]} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}`
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
    // A D1/runtime failure here used to rethrow past this handler entirely —
    // the client (DataList) sees a bare network-level "Failed to fetch"
    // instead of a renderable error. Surface it as structured JSON instead
    // (manual review: workspace item lists dying with no message).
    console.error(`POST /${resource}/query failed`, err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    return c.json({ error: 'query_failed', message }, 500);
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

// 0015 split the speaker form across two tables: identity (email, names,
// pronouns, mobile, links) is org-level on `contacts` and shared by every event
// the person appears in, while these five are this event's own answer and live
// on its `event_contacts` row. Every write below routes its columns through
// splitContactFields so neither table is handed a column it no longer has.
const CONTACT_PROFILE_FIELDS: readonly string[] = [
  'biography', 'headshot_asset_id', 'company', 'job_title', 'notes',
];

/** A pickContactFields() result split into the two tables' column maps. */
function splitContactFields(fields: Record<string, string | null>): {
  identity: Record<string, string | null>;
  profile: Record<string, string | null>;
} {
  const identity: Record<string, string | null> = {};
  const profile: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (CONTACT_PROFILE_FIELDS.includes(key)) profile[key] = value;
    else identity[key] = value;
  }
  return { identity, profile };
}

// SPK contacts-hygiene item 2: the portal profile (portal.ts's LINK_FIELDS)
// already writes these four into `contacts.links` (0001_init.sql:60, json
// {linkedin, twitter, facebook, website}) — the organiser-side speaker form
// had no matching control, so a speaker's own social links were invisible in
// the workspace. Same json shape both ends so the two writers never fight
// over the column's format.
const SOCIAL_LINK_KEYS = ['linkedin', 'twitter', 'facebook', 'website'] as const;

/** `body.links` (an object keyed by SOCIAL_LINK_KEYS) → the `links` column's json text, or null when every link is blank. Absent entirely when the request didn't send `links` at all, so a PUT that only changes e.g. company never touches the column. */
function pickContactLinks(body: Record<string, unknown>): string | null | undefined {
  if (!('links' in body)) return undefined;
  const value = body.links;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const key of SOCIAL_LINK_KEYS) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim();
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

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
  const links = pickContactLinks(body);
  if (links !== undefined) out.links = links;
  return out;
}

/**
 * F13: the contacts UNIQUE (org_id, lower(email)) violation is caught by
 * matching the D1 error text, not a pre-check — so the offending row's id has
 * to be looked up after the fact. That index is org-wide as of 0015, so the row
 * this points the client at can belong to a sibling event. Returns null (never
 * throws) if the lookup itself fails; the client falls back to the plain error
 * message with no recovery button rather than a 500.
 */
async function findContactIdByEmail(c: Context<ApiEnv>, email: string | null | undefined): Promise<string | null> {
  if (!email) return null;
  const session = c.get('session');
  const row = await c.env.DB.prepare(
    `SELECT id FROM contacts
      WHERE org_id = (SELECT org_id FROM events WHERE id = ?) AND lower(email) = lower(?)`,
  )
    .bind(session.eventId, email)
    .first<{ id: string }>()
    .catch(() => null);
  return row?.id ?? null;
}

adminApiRoutes.post('/contacts', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const fields = pickContactFields(body);
  if (!fields.email) return c.json({ error: 'email_required' }, 400);
  const { identity, profile } = splitContactFields(fields);

  const orgId = await sessionOrgId(c);
  if (!orgId) return c.json({ error: 'not_found' }, 404);

  // Identity is deduped org-wide as of 0015: an email the org already knows is
  // the SAME person, so adding them here attaches that identity to this event
  // rather than creating a second row (the unique index would reject one
  // anyway). Already on THIS event's roster is still a duplicate, and keeps the
  // 409 the grid turns into a "show me the existing record" recovery.
  const existing = await createDb(db).contacts.getByEmail(orgId, fields.email);
  if (existing) {
    const onRoster = await db
      .prepare('SELECT 1 AS ok FROM event_contacts WHERE event_id = ? AND contact_id = ?')
      .bind(session.eventId, existing.id)
      .first();
    if (onRoster) return c.json({ error: 'email_exists', existing_id: existing.id }, 409);
  }

  const id = existing?.id ?? crypto.randomUUID();
  // Validated before the insert, not after: a bad custom-field value must
  // never leave a contact half-created.
  const fieldOps = await prepareContactFieldValueOps(db, session.eventId, id, body.custom_fields);
  if (fieldOps.error) return c.json({ error: fieldOps.error, field: fieldOps.field }, 400);

  const ts = new Date().toISOString();
  const identityCols = Object.keys(identity);
  try {
    await db.batch([
      existing
        // The identity row is shared with every other event in the org, so
        // attaching someone fills blanks only: this event's form must not
        // overwrite a name another event already has on file. A deliberate
        // rename is PUT /contacts/:id, which does overwrite.
        ? db.prepare(
            `UPDATE contacts
                SET ${identityCols.map((k) => `${k} = COALESCE(NULLIF(${k}, ''), ?)`).join(', ')},
                    updated_at = ?
              WHERE id = ?`,
          ).bind(...identityCols.map((k) => identity[k]), ts, id)
        : db.prepare(
            `INSERT INTO contacts (id, org_id, created_at, updated_at, ${identityCols.join(', ')})
             VALUES (?, ?, ?, ?${', ?'.repeat(identityCols.length)})`,
          ).bind(id, orgId, ts, ts, ...identityCols.map((k) => identity[k])),
      ...fieldOps.ops,
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('UNIQUE')) return c.json({ error: 'email_exists', existing_id: await findContactIdByEmail(c, fields.email) }, 409);
    throw err;
  }

  // Membership is its own row: creating the identity without attaching it would
  // leave a person who exists in the org but appears on no roster at all.
  // attachToEvent is idempotent and seeds the profile from their most recent
  // event in the same org, which the submitted profile columns then override.
  await createDb(db).contacts.attachToEvent(session.eventId, id, 'admin');
  const profileCols = Object.keys(profile);
  if (profileCols.length > 0) {
    await db
      .prepare(
        `UPDATE event_contacts SET ${profileCols.map((k) => `${k} = ?`).join(', ')}
          WHERE event_id = ? AND contact_id = ?`,
      )
      .bind(...profileCols.map((k) => profile[k]), session.eventId, id)
      .run();
  }

  await bumpEventRevision(c.env, session.eventId);
  const row = await contactWithCustomFields(db, session.eventId, id);
  return c.json(row, 201);
});

adminApiRoutes.put('/contacts/:id', async (c) => {
  const session = c.get('session');
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const fields = pickContactFields(body);
  if ('email' in fields && !fields.email) return c.json({ error: 'email_required' }, 400);

  // Custom-field writes need the contact to be on this event's roster even when
  // no fixed field changed (the UPDATEs below would otherwise be skipped, and
  // with them the only check that the id belongs to this event). The join to
  // event_contacts is that check now that `contacts` is org-level.
  const existing = await c.env.DB.prepare(
    `SELECT c.id FROM contacts c
       JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
      WHERE c.id = ?`,
  )
    .bind(session.eventId, id)
    .first();
  if (!existing) return c.json({ error: 'not_found' }, 404);

  const fieldOps = await prepareContactFieldValueOps(c.env.DB, session.eventId, id, body.custom_fields);
  if (fieldOps.error) return c.json({ error: fieldOps.error, field: fieldOps.field }, 400);

  const { identity, profile } = splitContactFields(fields);
  const identityCols = Object.keys(identity);
  const profileCols = Object.keys(profile);
  const ts = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  if (identityCols.length > 0) {
    // Editing identity here edits it for every event in the org — that is what
    // the merge means, not a leak. The EXISTS repeats the roster check as this
    // statement's own tenancy guard.
    statements.push(
      c.env.DB.prepare(
        `UPDATE contacts SET ${identityCols.map((k) => `${k} = ?`).join(', ')}, updated_at = ?
          WHERE id = ?
            AND EXISTS (SELECT 1 FROM event_contacts ec
                         WHERE ec.contact_id = contacts.id AND ec.event_id = ?)`,
      ).bind(...identityCols.map((k) => identity[k]), ts, id, session.eventId),
    );
  } else if (profileCols.length > 0) {
    // event_contacts carries no updated_at of its own, so a profile-only edit
    // still touches the person's row to keep freshness reading the same.
    statements.push(c.env.DB.prepare('UPDATE contacts SET updated_at = ? WHERE id = ?').bind(ts, id));
  }
  if (profileCols.length > 0) {
    statements.push(
      c.env.DB.prepare(
        `UPDATE event_contacts SET ${profileCols.map((k) => `${k} = ?`).join(', ')}
          WHERE event_id = ? AND contact_id = ?`,
      ).bind(...profileCols.map((k) => profile[k]), session.eventId, id),
    );
  }
  statements.push(...fieldOps.ops);
  if (statements.length > 0) {
    try {
      await c.env.DB.batch(statements);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('UNIQUE')) return c.json({ error: 'email_exists', existing_id: await findContactIdByEmail(c, fields.email) }, 409);
      throw err;
    }
    await bumpEventRevision(c.env, session.eventId);
  }
  const row = await contactWithCustomFields(c.env.DB, session.eventId, id);
  return c.json(row);
});

// DELETE /contacts/:id — DETACH from this event, not destroy the person. Since
// 0015 a contact belongs to the organisation and can sit on several rosters, so
// removing them from the Speakers tab drops this event's event_contacts row —
// membership plus that event's own profile, headshot pointer included — and
// leaves their other events untouched. Only when that was their LAST membership
// does the identity row go too; nothing outside the org's events refers to it
// then, and the whole cascade fan-out (participants, assignments, invites, …)
// still fires exactly as before.
//
// The event's branding columns point *at* an asset rather than at the contact
// and carry no ON DELETE clause, so they are cleared in the same batch as that
// identity delete — the mutual reference with file_assets.uploaded_by_contact_id
// (SET NULL) is the one ordering that could fail. They are conditioned on the
// same last-membership test, because a plain detach must not blank a logo that
// is still perfectly valid. A constraint error is reported rather than
// surfacing as a 500 (manual review: "can't delete speaker").
adminApiRoutes.delete('/contacts/:id', async (c) => {
  const session = c.get('session');
  const id = c.req.param('id');
  const db = c.env.DB;

  let results;
  try {
    results = await db.batch([
      db.prepare(
        `UPDATE events SET logo_asset_id = NULL
          WHERE id = ?1
            AND logo_asset_id IN (SELECT id FROM file_assets WHERE uploaded_by_contact_id = ?2)
            AND NOT EXISTS (SELECT 1 FROM event_contacts
                             WHERE contact_id = ?2 AND event_id <> ?1)`,
      ).bind(session.eventId, id),
      db.prepare(
        `UPDATE events SET background_asset_id = NULL
          WHERE id = ?1
            AND background_asset_id IN (SELECT id FROM file_assets WHERE uploaded_by_contact_id = ?2)
            AND NOT EXISTS (SELECT 1 FROM event_contacts
                             WHERE contact_id = ?2 AND event_id <> ?1)`,
      ).bind(session.eventId, id),
      db.prepare('DELETE FROM event_contacts WHERE event_id = ? AND contact_id = ?')
        .bind(session.eventId, id),
      // Runs after the detach above (batch statements are sequential and share
      // one transaction), so the NOT EXISTS is what makes this a no-op for a
      // contact who still belongs to another event in the org.
      stageAirtableDeletes(
        db,
        'reviews',
        'reviewer_contact_id = ? AND NOT EXISTS (SELECT 1 FROM event_contacts ec WHERE ec.contact_id = ?)',
        id,
        id,
      ),
      stageAirtableDeletes(
        db,
        'contacts',
        'id = ? AND NOT EXISTS (SELECT 1 FROM event_contacts ec WHERE ec.contact_id = ?)',
        id,
        id,
      ),
      db.prepare(
        `DELETE FROM contacts
          WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM event_contacts WHERE contact_id = ?1)`,
      ).bind(id),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'delete_conflict', detail }, 409);
  }

  // The detach, not the identity delete, is what "found" means: a contact in
  // another event of the org is not on this roster and reads as absent.
  if ((results[2]?.meta.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404);
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Cross-event contact surface (workplan §4) — the payoff of 0015. Three routes
// that only make sense once a contact is an ORG-level person: put someone the
// org already knows onto this event, read their history across the events you
// administer, and destroy the person outright rather than detaching them.
//
// All three are guarded exactly like their neighbours above — against the
// session's event, resolved from the cookie and never from the request — with
// the single documented exception called out on the history route.
// ---------------------------------------------------------------------------

/** Picker page size. Small on purpose: it is a type-ahead, not a roster. */
const ORG_SEARCH_LIMIT = 25;

// GET /contacts/org-search?q= — everyone in the session's organisation who is
// NOT already on this event, for the Speakers tab's "Add existing contact".
// Until 0015 the question could not even be asked: a contact belonged to one
// event, so "already exists elsewhere in the org" was not a state.
adminApiRoutes.get('/contacts/org-search', async (c) => {
  const session = c.get('session');
  const q = (c.req.query('q') ?? '').trim();
  const orgId = await sessionOrgId(c);
  if (!orgId) return c.json({ error: 'not_found' }, 404);

  const like = `%${q}%`;
  const { results } = await c.env.DB.prepare(
    // `contacts` carries org_id since 0015, so THAT is the tenancy guard here
    // and there is no event_contacts join to make — the whole point of the
    // endpoint is the people who have no row for this event yet. The NOT
    // EXISTS is the exclusion, not the guard.
    //
    // company/job_title come from the person's most recent event in the same
    // org: precisely the row contacts.attachToEvent seeds the new profile
    // from, so the picker shows the organiser what they are about to get.
    `SELECT c.id, c.email, c.first_name, c.last_name,
            (SELECT ec.company FROM event_contacts ec
               JOIN events e ON e.id = ec.event_id
              WHERE ec.contact_id = c.id AND e.org_id = c.org_id
              ORDER BY ec.added_at DESC LIMIT 1) AS company,
            (SELECT ec.job_title FROM event_contacts ec
               JOIN events e ON e.id = ec.event_id
              WHERE ec.contact_id = c.id AND e.org_id = c.org_id
              ORDER BY ec.added_at DESC LIMIT 1) AS job_title
       FROM contacts c
      WHERE c.org_id = ?1
        AND NOT EXISTS (SELECT 1 FROM event_contacts ec
                         WHERE ec.contact_id = c.id AND ec.event_id = ?2)
        AND (?3 = '' OR c.first_name LIKE ?4 OR c.last_name LIKE ?4 OR c.email LIKE ?4)
      -- Nameless stub contacts (submit.tsx's bare {email} rows — see the admin
      -- app's isPlaceholderContact) sort last rather than being dropped: still
      -- findable by typing the address, but they never head the list.
      ORDER BY (COALESCE(c.first_name, '') = '' AND COALESCE(c.last_name, '') = ''),
               c.last_name, c.first_name, c.email
      LIMIT ?5`,
  )
    .bind(orgId, session.eventId, q, like, ORG_SEARCH_LIMIT)
    .all();
  return c.json({ items: results });
});

// POST /contacts/:id/attach — put an existing org contact on this event. The
// counterpart to DELETE /contacts/:id's detach, and the only write path that
// adds membership without touching identity.
adminApiRoutes.post('/contacts/:id/attach', async (c) => {
  const session = c.get('session');
  const id = c.req.param('id');
  const db = c.env.DB;
  const orgId = await sessionOrgId(c);
  if (!orgId) return c.json({ error: 'not_found' }, 404);

  // The org check stands in for the event_contacts join every other
  // /contacts/:id route guards with — that join cannot be the guard here,
  // because a contact with no row for this event is exactly what this route
  // takes. Another org's person still reads as absent.
  const contact = await createDb(db).contacts.getByIdOrgWide(orgId, id);
  if (!contact) return c.json({ error: 'not_found' }, 404);

  const already = await db
    .prepare('SELECT 1 AS ok FROM event_contacts WHERE event_id = ? AND contact_id = ?')
    .bind(session.eventId, id)
    .first();
  if (already) return c.json({ error: 'already_on_event' }, 409);

  // Seeds biography/company/job_title from their most recent event in the same
  // org (never the headshot, which is an event-scoped asset) — the whole
  // reason a returning speaker does not have to retype their profile.
  await createDb(db).contacts.attachToEvent(session.eventId, id, 'admin');
  await bumpEventRevision(c.env, session.eventId);
  const row = await contactWithCustomFields(db, session.eventId, id);
  return c.json(row, 201);
});

/** One event a contact has been part of — the history panel's grouping key. */
interface ContactHistoryEvent {
  event_id: string;
  event_name: string;
  event_starts_at: string | null;
  added_at: string | null;
  source: string | null;
  company: string | null;
  job_title: string | null;
}

/** One submission of theirs, already narrowed to a readable event. */
interface ContactHistorySubmission {
  id: string;
  event_id: string;
  code: string;
  title: string;
  status: string;
  starts_at: string | null;
  room_name: string | null;
  role: string | null;
}

// GET /contacts/:id/history — submissions and sessions grouped by event: the
// feature the whole workplan exists for (§4).
adminApiRoutes.get('/contacts/:id/history', async (c) => {
  const session = c.get('session');
  const id = c.req.param('id');
  const db = c.env.DB;

  // Ordinary event guard first, identical to the headshot route's: the panel
  // opens off this event's roster, so a contact with no row here is absent.
  const onRoster = await db
    .prepare(
      `SELECT c.id FROM contacts c
         JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
        WHERE c.id = ?`,
    )
    .bind(session.eventId, id)
    .first();
  if (!onRoster) return c.json({ error: 'not_found' }, 404);

  // THE ONE DELIBERATELY ORG-WIDE READ IN THIS FILE. Everything else joins
  // event_contacts to stay pinned to the session's event; this joins on
  // contact_id alone, because a person's history spanning the organisation is
  // the entire point of 0015. Two things keep it from being the silent
  // widening the sweep warns about:
  //
  //  1. the roster check above — you can only ask about someone already
  //     standing in front of you on this event;
  //  2. `accessibleEventIds` (access.ts) — the answer is clipped to events
  //     where this staff email holds an owner/admin/reviewer seat, so an admin
  //     of event A never learns that event B exists, never mind that the
  //     contact is on it. There is deliberately no "…and N events you cannot
  //     see" tally either: the count alone discloses the existence this is
  //     withholding.
  const eventIds = await accessibleEventIds(c);
  const marks = eventIds.map(() => '?').join(', ');

  const memberships = await db
    .prepare(
      `SELECT ec.event_id, e.name AS event_name, e.starts_at AS event_starts_at,
              ec.added_at, ec.source, ec.company, ec.job_title
         FROM event_contacts ec
         JOIN events e ON e.id = ec.event_id
        WHERE ec.contact_id = ? AND ec.event_id IN (${marks})`,
    )
    .bind(id, ...eventIds)
    .all<ContactHistoryEvent>();

  // Same broad "theirs" relation the submissions resource's `contact_id`
  // filter uses (submitter OR participant), lifted across events. `role` is
  // their participant role where they have one, falling back to 'submitter'.
  const submissions = await db
    .prepare(
      `SELECT s.id, s.event_id, s.code, s.title, s.status, s.starts_at,
              r.name AS room_name,
              COALESCE(
                (SELECT sp.role FROM submission_participants sp
                  WHERE sp.submission_id = s.id AND sp.contact_id = ?1 LIMIT 1),
                CASE WHEN s.submitter_contact_id = ?1 THEN 'submitter' END
              ) AS role
         FROM submissions s
         LEFT JOIN rooms r ON r.id = s.room_id
        WHERE s.event_id IN (${marks})
          AND (s.submitter_contact_id = ?1
               OR EXISTS (SELECT 1 FROM submission_participants sp
                           WHERE sp.submission_id = s.id AND sp.contact_id = ?1))
        ORDER BY s.starts_at IS NULL, s.starts_at, s.code`,
    )
    .bind(id, ...eventIds)
    .all<ContactHistorySubmission>();

  // Grouped server-side so the panel renders one list per event without
  // knowing the accessible set. An event they submitted to but were never
  // attached to still gets a group — the membership row can be missing on
  // legacy data — and its profile columns simply read null.
  const groups = new Map<string, ContactHistoryEvent & { submissions: ContactHistorySubmission[] }>();
  for (const row of memberships.results) groups.set(row.event_id, { ...row, submissions: [] });
  for (const row of submissions.results) {
    let group = groups.get(row.event_id);
    if (!group) {
      const meta = await db
        .prepare('SELECT name, starts_at FROM events WHERE id = ?')
        .bind(row.event_id)
        .first<{ name: string; starts_at: string | null }>();
      group = {
        event_id: row.event_id,
        event_name: meta?.name ?? row.event_id,
        event_starts_at: meta?.starts_at ?? null,
        added_at: null,
        source: null,
        company: null,
        job_title: null,
        submissions: [],
      };
      groups.set(row.event_id, group);
    }
    group.submissions.push(row);
  }

  // Most recent event first; the current one is just another entry, flagged so
  // the panel can label it rather than hide it.
  const events = [...groups.values()].sort((a, b) =>
    (b.event_starts_at ?? '').localeCompare(a.event_starts_at ?? ''),
  );
  return c.json({ events, current_event_id: session.eventId });
});

// DELETE /contacts/:id/org — destroy the PERSON, as opposed to DELETE
// /contacts/:id, which detaches them from this event and only reaches the
// identity row when that was their last membership (workplan §4).
//
// Free when no other event references them; otherwise it needs ?confirm=1, and
// the 409 asking for it names every event that goes with them. That list
// cannot honestly be shown for events the caller holds no seat on, so those
// refuse outright (403) rather than rendering as "…and 2 others" — the count
// alone would disclose exactly what the history route above withholds.
adminApiRoutes.delete('/contacts/:id/org', async (c) => {
  const session = c.get('session');
  const id = c.req.param('id');
  const db = c.env.DB;
  const confirmed = c.req.query('confirm') === '1';

  const orgId = await sessionOrgId(c);
  if (!orgId) return c.json({ error: 'not_found' }, 404);

  // The same roster join the detach guards with: this is reached from the
  // contact detail panel, so the person must be on this event.
  const onRoster = await db
    .prepare(
      `SELECT c.id FROM contacts c
         JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
        WHERE c.id = ?`,
    )
    .bind(session.eventId, id)
    .first();
  if (!onRoster) return c.json({ error: 'not_found' }, 404);

  const others = await db
    .prepare(
      `SELECT ec.event_id, e.name AS event_name
         FROM event_contacts ec
         JOIN events e ON e.id = ec.event_id
        WHERE ec.contact_id = ? AND ec.event_id <> ?
        ORDER BY e.starts_at, e.name`,
    )
    .bind(id, session.eventId)
    .all<{ event_id: string; event_name: string }>();

  const accessible = await accessibleEventIds(c);
  if (others.results.some((r) => !accessible.includes(r.event_id))) {
    return c.json({ error: 'other_events_not_accessible' }, 403);
  }
  if (others.results.length > 0 && !confirmed) {
    return c.json({ error: 'confirm_required', events: others.results }, 409);
  }

  // Every event losing them, this one included — bounded, and checked
  // accessible above, so it is safe to write across.
  const affected = [session.eventId, ...others.results.map((r) => r.event_id)];
  const affectedMarks = affected.map(() => '?').join(', ');
  try {
    await db.batch([
      // Same branding carve-out as the detach route, minus its last-membership
      // condition (the person is going regardless): the branding columns point
      // *at* an asset and carry no ON DELETE clause, and
      // file_assets.uploaded_by_contact_id (SET NULL) is the mutual reference
      // that makes the ordering matter.
      db.prepare(
        `UPDATE events SET logo_asset_id = NULL
          WHERE id IN (${affectedMarks})
            AND logo_asset_id IN (SELECT id FROM file_assets WHERE uploaded_by_contact_id = ?)`,
      ).bind(...affected, id),
      db.prepare(
        `UPDATE events SET background_asset_id = NULL
          WHERE id IN (${affectedMarks})
            AND background_asset_id IN (SELECT id FROM file_assets WHERE uploaded_by_contact_id = ?)`,
      ).bind(...affected, id),
      // org_id is this statement's own tenancy guard, repeating the check the
      // roster join made. The cascade fan-out (memberships, participants,
      // assignments, invites, …) fires exactly as on the detach route's
      // last-membership path.
      stageAirtableDeletes(db, 'reviews', 'reviewer_contact_id = ?', id),
      stageAirtableDeletes(db, 'contacts', 'id = ? AND org_id = ?', id, orgId),
      db.prepare('DELETE FROM contacts WHERE id = ? AND org_id = ?').bind(id, orgId),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'delete_conflict', detail }, 409);
  }

  for (const eventId of affected) await bumpEventRevision(c.env, eventId);
  return c.json({ ok: true, events_affected: affected.length });
});

// SPK-10 fix: headshots were stored as a plain file_assets row (via
// saveFile) plus a pointer on contacts.headshot_asset_id, but the Files
// library (filesAdminRoutes.get('/library'), the query behind the Files
// workspace tab) reads exclusively from file_request_uploads — one row per
// "chain" (file_request_id, contact_id, submission_id) — joined onto
// file_assets. A file_assets row with no matching file_request_uploads row
// is invisible to that query, so uploaded headshots never appeared there
// (0 records before and after), even though GET /files/:id could always
// serve the bytes.
//
// Fix: give every event a standing, idempotently-created "Headshots" file
// request (id is deterministic per event, so concurrent first-uploads can't
// race to create two), and register each headshot save as a version in that
// contact's chain via fileVersions.ts's existing appendUploadVersion — the
// same helper the speaker-portal file-request flow already uses, so a
// headshot shows up in the library exactly like any other uploaded file:
// filename, size, uploader, timestamp, and the existing /files/:id
// view/download link. No schema migration needed — file_requests and
// file_request_uploads already support this without any new columns.
// `contact_id` on the upload row is the contact the headshot is *for* (the
// speaker), matching the library's "for" semantics; file_assets separately
// keeps uploaded_by_contact_id as who actually performed the upload
// (an admin here, the speaker themselves on the portal path).
async function ensureHeadshotFileRequestId(db: D1Database, eventId: string): Promise<string> {
  const id = `file-request-headshots-${eventId}`;
  await db
    .prepare(
      `INSERT OR IGNORE INTO file_requests (id, event_id, title, type, created_at)
       VALUES (?, ?, 'Headshots', 'contacts', ?)`,
    )
    .bind(id, eventId, new Date().toISOString())
    .run();
  return id;
}

// POST /contacts/:id/headshot { headshot: File } → { ok, headshot_asset_id }
//
// CNT-10: the organiser speaker edit form had no photo control at all — the
// only way to set a headshot was the speaker's own portal profile page
// (portal.ts's POST /:slug/profile), which is unreachable for a speaker who
// never logs in. Reuses the exact same storage seam (filestore.ts's
// saveFile, same MAX_HEADSHOT_BYTES/IMAGE_TYPES limits and magic-byte check,
// same KV-backed file_assets row) so a headshot set from either surface is
// indistinguishable in storage and both read back through GET /files/:id.
adminApiRoutes.post('/contacts/:id/headshot', async (c) => {
  const session = c.get('session');
  const id = c.req.param('id');
  const db = c.env.DB;

  // The join to event_contacts is the tenancy guard: a contact with no row for
  // this event is not on its roster and must read as absent.
  const exists = await db
    .prepare(
      `SELECT c.id FROM contacts c
         JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
        WHERE c.id = ?`,
    )
    .bind(session.eventId, id)
    .first<{ id: string }>();
  if (!exists) return c.json({ error: 'not_found' }, 404);

  const body = await c.req.parseBody();
  const upload = body.headshot;
  if (!(upload instanceof File) || upload.size === 0) return c.json({ error: 'file_required' }, 400);

  const saved = await saveFile(c.env, {
    eventId: session.eventId,
    uploadedByContactId: session.contactId,
    file: upload,
    maxBytes: MAX_HEADSHOT_BYTES,
    allowedTypes: IMAGE_TYPES,
  });
  if ('error' in saved) return c.json({ error: saved.error }, 400);

  const fileRequestId = await ensureHeadshotFileRequestId(db, session.eventId);
  await appendUploadVersion(
    db,
    { fileRequestId, contactId: id, submissionId: null },
    { assetId: saved.id, uploadedAt: new Date().toISOString() },
  );

  // The headshot is an event-scoped asset, so its pointer lives on this event's
  // event_contacts row; contacts.updated_at still moves so the grid re-reads.
  await db.batch([
    db.prepare('UPDATE event_contacts SET headshot_asset_id = ? WHERE event_id = ? AND contact_id = ?')
      .bind(saved.id, session.eventId, id),
    db.prepare('UPDATE contacts SET updated_at = ? WHERE id = ?')
      .bind(new Date().toISOString(), id),
  ]);
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true, headshot_asset_id: saved.id });
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

/**
 * CNT-01: a task *definition* row (`tasks`) is invisible in the admin Tasks
 * grid, which lists `task_assignments` (one row per assignee). Creating a
 * manual task with no assignments therefore looked like a silent failure. The
 * create endpoint now takes explicit targets and materialises the assignment
 * rows in the same request.
 */
const MAX_TASK_TARGETS = 500;

interface TaskTargets {
  contactIds: string[];
  submissionIds: string[];
  error?: string;
}

/** Read + shape-validate the (optional) target id arrays on a create body. */
function pickTaskTargets(raw: unknown): TaskTargets {
  const body = (raw ?? {}) as Record<string, unknown>;
  const read = (key: string): string[] | null => {
    const v = body[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > MAX_TASK_TARGETS) return null;
    const ids: string[] = [];
    for (const item of v) {
      if (typeof item !== 'string' || item.trim() === '') return null;
      if (!ids.includes(item)) ids.push(item);
    }
    return ids;
  };
  const contactIds = read('assignee_contact_ids');
  if (contactIds === null) return { contactIds: [], submissionIds: [], error: 'invalid_assignee_contact_ids' };
  const submissionIds = read('submission_ids');
  if (submissionIds === null) return { contactIds: [], submissionIds: [], error: 'invalid_submission_ids' };
  return { contactIds, submissionIds };
}

/**
 * Every id in `ids` exists in `table` under `eventId` (tenant isolation).
 *
 * `contacts` has no event_id since 0015 — belonging to an event means having an
 * event_contacts row — so it checks membership on the join table instead. The
 * other tables keep their own event_id column and the plain check.
 */
async function idsBelongToEvent(
  db: D1Database,
  table: 'contacts' | 'submissions',
  ids: string[],
  eventId: string,
): Promise<boolean> {
  if (ids.length === 0) return true;
  const placeholders = ids.map(() => '?').join(',');
  const sql = table === 'contacts'
    ? `SELECT COUNT(*) AS n FROM event_contacts WHERE event_id = ? AND contact_id IN (${placeholders})`
    : `SELECT COUNT(*) AS n FROM ${table} WHERE event_id = ? AND id IN (${placeholders})`;
  const row = await db.prepare(sql).bind(eventId, ...ids).first<{ n: number }>();
  return (row?.n ?? 0) === ids.length;
}

/**
 * Expand the requested targets into (contact_id, submission_id) assignment
 * pairs. `task_assignments.contact_id` is NOT NULL, so a submission target
 * resolves to that submission's people — the explicitly picked contacts when
 * the organiser named some, otherwise its participants plus its submitter.
 */
async function expandTaskTargets(
  db: D1Database,
  targets: TaskTargets,
): Promise<Array<{ contactId: string; submissionId: string | null }>> {
  const pairs: Array<{ contactId: string; submissionId: string | null }> = [];
  if (targets.submissionIds.length > 0) {
    const placeholders = targets.submissionIds.map(() => '?').join(',');
    const people = targets.contactIds.length > 0
      ? targets.submissionIds.flatMap((submissionId) =>
          targets.contactIds.map((contactId) => ({ submission_id: submissionId, contact_id: contactId })),
        )
      : (
          await db
            .prepare(
              `SELECT submission_id, contact_id FROM submission_participants WHERE submission_id IN (${placeholders})
               UNION
               SELECT id AS submission_id, submitter_contact_id AS contact_id FROM submissions
               WHERE id IN (${placeholders}) AND submitter_contact_id IS NOT NULL`,
            )
            .bind(...targets.submissionIds, ...targets.submissionIds)
            .all<{ submission_id: string; contact_id: string }>()
        ).results;
    for (const p of people) pairs.push({ contactId: p.contact_id, submissionId: p.submission_id });
  } else {
    for (const contactId of targets.contactIds) pairs.push({ contactId, submissionId: null });
  }
  return pairs;
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
  const body = await c.req.json().catch(() => ({}));
  const { values, error } = pickTaskFields(body, { requireTitle: true });
  if (error) return c.json({ error }, 400);
  if (!(await taskRefsBelongToEvent(c.env.DB, session.eventId, values))) {
    return c.json({ error: 'reference_not_in_event' }, 400);
  }
  const targets = pickTaskTargets(body);
  if (targets.error) return c.json({ error: targets.error }, 400);
  if (
    !(await idsBelongToEvent(c.env.DB, 'contacts', targets.contactIds, session.eventId)) ||
    !(await idsBelongToEvent(c.env.DB, 'submissions', targets.submissionIds, session.eventId))
  ) {
    return c.json({ error: 'reference_not_in_event' }, 400);
  }

  const id = crypto.randomUUID();
  const cols = Object.keys(values);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO tasks (id, event_id, created_at, updated_at${cols.map((k) => `, "${k}"`).join('')})
     VALUES (?, ?, ?, ?${', ?'.repeat(cols.length)})`,
  )
    .bind(id, session.eventId, now, now, ...cols.map((k) => values[k]))
    .run();

  // OR IGNORE: 0005_integrity added a unique logical index over
  // (task_id, contact_id, COALESCE(submission_id,'')), and a submission's
  // participant list can legitimately name the same person twice by role.
  const pairs = await expandTaskTargets(c.env.DB, targets);
  if (pairs.length > 0) {
    await c.env.DB.batch(
      pairs.map((p) =>
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO task_assignments (id, task_id, contact_id, submission_id, status)
           VALUES (?, ?, ?, ?, 'not_started')`,
        ).bind(crypto.randomUUID(), id, p.contactId, p.submissionId),
      ),
    );
  }
  const assignmentCount = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM task_assignments WHERE task_id = ?')
    .bind(id)
    .first<{ n: number }>();

  await bumpEventRevision(c.env, session.eventId);
  const row = await taskRow(c.env.DB, id, session.eventId);
  return c.json({ ...(row as Record<string, unknown>), assignments_created: assignmentCount?.n ?? 0 }, 201);
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
      `UPDATE tasks SET ${cols.map((k) => `"${k}" = ?`).join(', ')}, updated_at = ? WHERE id = ? AND event_id = ?`,
    )
      .bind(...cols.map((k) => values[k]), new Date().toISOString(), id, session.eventId)
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
  const id = c.req.param('id');
  const results = await c.env.DB.batch([
    stageAirtableDeletes(c.env.DB, 'tasks', 'id = ? AND event_id = ?', id, session.eventId),
    c.env.DB.prepare('DELETE FROM tasks WHERE id = ? AND event_id = ?').bind(id, session.eventId),
  ]);
  if ((results[1]?.meta.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404);
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Rooms & tracks CRUD (deferred-gap item: the tables existed with event_id +
// position, but only agendaPayload ever SELECTed them — a freshly created
// event offered nothing but "No room" / "No track" in the Add Session dialog,
// which fails an eval scenario outright). Deletes null the reference on any
// session that pointed at the room/track rather than blocking the delete or
// cascading the session away — a session losing its room/track is a much
// smaller surprise than a session disappearing.
// ---------------------------------------------------------------------------

const ROOM_TRACK_NAME_MAX_CHARS = 200;

interface RoomFields {
  values: Record<string, string | number | null>;
  error?: string;
}

function pickRoomFields(raw: unknown, { requireName }: { requireName: boolean }): RoomFields {
  const body = (raw ?? {}) as Record<string, unknown>;
  const values: Record<string, string | number | null> = {};
  const fail = (error: string): RoomFields => ({ values: {}, error });

  if (requireName || 'name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return fail('name_required');
    values.name = name.slice(0, ROOM_TRACK_NAME_MAX_CHARS);
  }
  if ('capacity' in body) {
    const capacity = parseCapacityValue(body.capacity);
    if (capacity === undefined) return fail('invalid_capacity');
    values.capacity = capacity;
  }
  if ('notes' in body) {
    const v = body.notes;
    if (v === null || v === '') values.notes = null;
    else if (typeof v === 'string') values.notes = v.trim().slice(0, 2000);
    else return fail('invalid_notes');
  }
  return { values };
}

/** Optional non-negative integer; `undefined` = not supplied/invalid (shared shape with agenda.ts's parseCapacity). */
function parseCapacityValue(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

const roomRow = (db: D1Database, id: string, eventId: string) =>
  db.prepare('SELECT id, event_id, name, capacity, position, notes FROM rooms WHERE id = ? AND event_id = ?')
    .bind(id, eventId)
    .first();

// GET /app/api/rooms — the event's rooms, position order (settings + agenda builder).
adminApiRoutes.get('/rooms', async (c) => {
  const session = c.get('session');
  const { results } = await c.env.DB.prepare(
    'SELECT id, event_id, name, capacity, position, notes FROM rooms WHERE event_id = ? ORDER BY position',
  )
    .bind(session.eventId)
    .all();
  return c.json({ items: results });
});

adminApiRoutes.post('/rooms', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const { values, error } = pickRoomFields(await c.req.json().catch(() => ({})), { requireName: true });
  if (error) return c.json({ error }, 400);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO rooms (id, event_id, name, capacity, notes, position, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, COALESCE((SELECT MAX(position) + 1 FROM rooms WHERE event_id = ?2), 0), ?6`,
  )
    .bind(id, session.eventId, values.name, values.capacity ?? null, values.notes ?? null, new Date().toISOString())
    .run();
  await bumpEventRevision(c.env, session.eventId);
  return c.json(await roomRow(c.env.DB, id, session.eventId), 201);
});

adminApiRoutes.put('/rooms/:id', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const { values, error } = pickRoomFields(await c.req.json().catch(() => ({})), { requireName: false });
  if (error) return c.json({ error }, 400);

  const cols = Object.keys(values);
  if (cols.length > 0) {
    const result = await c.env.DB.prepare(
      `UPDATE rooms SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND event_id = ?`,
    )
      .bind(...cols.map((k) => values[k]), new Date().toISOString(), id, session.eventId)
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
    await bumpEventRevision(c.env, session.eventId);
  }
  const row = await roomRow(c.env.DB, id, session.eventId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
});

// DELETE /rooms/:id — any session scheduled "in" this room keeps its slot but
// loses the room reference; a deleted room must never leave a dangling id
// that the agenda board can no longer resolve to a name.
adminApiRoutes.delete('/rooms/:id', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const db = c.env.DB;
  const results = await db.batch([
    db.prepare('UPDATE submissions SET room_id = NULL, updated_at = ? WHERE room_id = ? AND event_id = ?')
      .bind(new Date().toISOString(), id, session.eventId),
    stageAirtableDeletes(db, 'rooms', 'id = ? AND event_id = ?', id, session.eventId),
    db.prepare('DELETE FROM rooms WHERE id = ? AND event_id = ?').bind(id, session.eventId),
  ]);
  if ((results[2]?.meta.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404);
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true });
});

interface TrackFields {
  values: Record<string, string | number | null>;
  error?: string;
}

function pickTrackFields(raw: unknown, { requireName }: { requireName: boolean }): TrackFields {
  const body = (raw ?? {}) as Record<string, unknown>;
  const values: Record<string, string | number | null> = {};
  const fail = (error: string): TrackFields => ({ values: {}, error });

  if (requireName || 'name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return fail('name_required');
    values.name = name.slice(0, ROOM_TRACK_NAME_MAX_CHARS);
  }
  if ('color' in body) {
    const v = body.color;
    if (v === null || v === '') values.color = null;
    else if (typeof v === 'string') values.color = v.trim().slice(0, 20);
    else return fail('invalid_color');
  }
  return { values };
}

const trackRow = (db: D1Database, id: string, eventId: string) =>
  db.prepare('SELECT id, event_id, name, color, position FROM tracks WHERE id = ? AND event_id = ?')
    .bind(id, eventId)
    .first();

// GET /app/api/tracks — the event's tracks, position order.
adminApiRoutes.get('/tracks', async (c) => {
  const session = c.get('session');
  const { results } = await c.env.DB.prepare(
    'SELECT id, event_id, name, color, position FROM tracks WHERE event_id = ? ORDER BY position',
  )
    .bind(session.eventId)
    .all();
  return c.json({ items: results });
});

adminApiRoutes.post('/tracks', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const { values, error } = pickTrackFields(await c.req.json().catch(() => ({})), { requireName: true });
  if (error) return c.json({ error }, 400);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO tracks (id, event_id, name, color, position, updated_at)
     SELECT ?1, ?2, ?3, ?4, COALESCE((SELECT MAX(position) + 1 FROM tracks WHERE event_id = ?2), 0), ?5`,
  )
    .bind(id, session.eventId, values.name, values.color ?? null, new Date().toISOString())
    .run();
  await bumpEventRevision(c.env, session.eventId);
  return c.json(await trackRow(c.env.DB, id, session.eventId), 201);
});

adminApiRoutes.put('/tracks/:id', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const { values, error } = pickTrackFields(await c.req.json().catch(() => ({})), { requireName: false });
  if (error) return c.json({ error }, 400);

  const cols = Object.keys(values);
  if (cols.length > 0) {
    const result = await c.env.DB.prepare(
      `UPDATE tracks SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND event_id = ?`,
    )
      .bind(...cols.map((k) => values[k]), new Date().toISOString(), id, session.eventId)
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
    await bumpEventRevision(c.env, session.eventId);
  }
  const row = await trackRow(c.env.DB, id, session.eventId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
});

// DELETE /tracks/:id — same null-the-reference semantics as rooms, plus the
// M6 submission_tracks junction (multi-track, 0006_features.sql) which has no
// application-level cleanup path otherwise.
adminApiRoutes.delete('/tracks/:id', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const db = c.env.DB;
  const results = await db.batch([
    db.prepare('UPDATE submissions SET track_id = NULL, updated_at = ? WHERE track_id = ? AND event_id = ?')
      .bind(new Date().toISOString(), id, session.eventId),
    db.prepare(
      `DELETE FROM submission_tracks WHERE track_id = ?
       AND submission_id IN (SELECT id FROM submissions WHERE event_id = ?)`,
    ).bind(id, session.eventId),
    stageAirtableDeletes(db, 'tracks', 'id = ? AND event_id = ?', id, session.eventId),
    db.prepare('DELETE FROM tracks WHERE id = ? AND event_id = ?').bind(id, session.eventId),
  ]);
  if ((results[3]?.meta.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404);
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Contact custom fields (SPK-15): per-event field definitions for the
// Speakers tab (settings-card CRUD), plus the values store the contacts
// endpoints below read/write. Mirrors the rooms/tracks CRUD shape above —
// auto position on create, PUT patches whatever keys are present, DELETE
// cascades its values (contact_field_values.field_id ON DELETE CASCADE).
// ---------------------------------------------------------------------------

const CONTACT_FIELD_TYPES = new Set(['text', 'select', 'multiline']);
const CONTACT_FIELD_LABEL_MAX_CHARS = 200;
const CONTACT_FIELD_VALUE_MAX_CHARS = 2000;
const CONTACT_FIELD_OPTION_MAX_CHARS = 200;

interface ContactFieldDefFields {
  values: Record<string, string | number | null>;
  error?: string;
}

function pickContactFieldDefFields(raw: unknown, { requireLabel }: { requireLabel: boolean }): ContactFieldDefFields {
  const body = (raw ?? {}) as Record<string, unknown>;
  const values: Record<string, string | number | null> = {};
  const fail = (error: string): ContactFieldDefFields => ({ values: {}, error });

  if (requireLabel || 'label' in body) {
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (!label) return fail('label_required');
    values.label = label.slice(0, CONTACT_FIELD_LABEL_MAX_CHARS);
  }
  if (requireLabel || 'type' in body) {
    const type = typeof body.type === 'string' ? body.type : '';
    if (!CONTACT_FIELD_TYPES.has(type)) return fail('invalid_type');
    values.type = type;
  }
  if ('options' in body) {
    const raw = body.options;
    if (raw === null) {
      values.options = null;
    } else if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) {
      const cleaned = Array.from(
        new Set(raw.map((v) => v.trim().slice(0, CONTACT_FIELD_OPTION_MAX_CHARS)).filter((v) => v.length > 0)),
      );
      values.options = cleaned.length > 0 ? JSON.stringify(cleaned) : null;
    } else {
      return fail('invalid_options');
    }
  }
  return { values };
}

const contactFieldDefRow = (db: D1Database, id: string, eventId: string) =>
  db.prepare('SELECT id, event_id, key, label, type, options, position FROM contact_field_definitions WHERE id = ? AND event_id = ?')
    .bind(id, eventId)
    .first();

// GET /app/api/contact-fields — the event's speaker-record field definitions, position order.
adminApiRoutes.get('/contact-fields', async (c) => {
  const session = c.get('session');
  const { results } = await c.env.DB.prepare(
    'SELECT id, event_id, key, label, type, options, position FROM contact_field_definitions WHERE event_id = ? ORDER BY position',
  )
    .bind(session.eventId)
    .all();
  return c.json({ items: results });
});

adminApiRoutes.post('/contact-fields', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const { values, error } = pickContactFieldDefFields(await c.req.json().catch(() => ({})), { requireLabel: true });
  if (error) return c.json({ error }, 400);

  const id = crypto.randomUUID();
  // key is derived, not user-editable — matches formsAdmin.ts's "Create Field"
  // slugging so a field's identity survives a later rename.
  const key = `custom_${String(values.label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)}_${id.slice(0, 4)}`;
  await c.env.DB.prepare(
    `INSERT INTO contact_field_definitions (id, event_id, key, label, type, options, position)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, COALESCE((SELECT MAX(position) + 1 FROM contact_field_definitions WHERE event_id = ?2), 0)`,
  )
    .bind(id, session.eventId, key, values.label, values.type, values.options ?? null)
    .run();
  await bumpEventRevision(c.env, session.eventId);
  return c.json(await contactFieldDefRow(c.env.DB, id, session.eventId), 201);
});

adminApiRoutes.put('/contact-fields/:id', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const { values, error } = pickContactFieldDefFields(await c.req.json().catch(() => ({})), { requireLabel: false });
  if (error) return c.json({ error }, 400);

  const cols = Object.keys(values);
  if (cols.length > 0) {
    const result = await c.env.DB.prepare(
      `UPDATE contact_field_definitions SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND event_id = ?`,
    )
      .bind(...cols.map((k) => values[k]), id, session.eventId)
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
    await bumpEventRevision(c.env, session.eventId);
  }
  const row = await contactFieldDefRow(c.env.DB, id, session.eventId);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
});

// DELETE /contact-fields/:id — values cascade via contact_field_values.field_id
// ON DELETE CASCADE; no contact loses its other fields.
adminApiRoutes.delete('/contact-fields/:id', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const result = await c.env.DB.prepare('DELETE FROM contact_field_definitions WHERE id = ? AND event_id = ?')
    .bind(id, session.eventId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true });
});

// POST /contact-fields/reorder { ids } — positions follow the given order (formsAdmin.ts's questions/reorder shape).
adminApiRoutes.post('/contact-fields/reorder', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === 'string') : [];
  if (ids.length === 0) return c.json({ error: 'ids_required' }, 400);

  await c.env.DB.batch(
    ids.map((fid, index) =>
      c.env.DB.prepare('UPDATE contact_field_definitions SET position = ? WHERE id = ? AND event_id = ?')
        .bind(index, fid, session.eventId),
    ),
  );
  const { results } = await c.env.DB.prepare(
    'SELECT id, event_id, key, label, type, options, position FROM contact_field_definitions WHERE event_id = ? ORDER BY position',
  )
    .bind(session.eventId)
    .all();
  return c.json({ items: results });
});

/**
 * Validates `body.custom_fields` (an object of `{ <definition key>: string |
 * null }`) against the event's field definitions and returns the D1
 * statements to write it — batched alongside the contacts insert/update so a
 * bad value never leaves a contact half-saved. Returns an `error` (never
 * throws) on an unknown key, a non-string value, or a `select` value outside
 * its options; the caller turns that into a 400 before running anything.
 */
async function prepareContactFieldValueOps(
  db: D1Database,
  eventId: string,
  contactId: string,
  raw: unknown,
): Promise<{ ops: D1PreparedStatement[]; error?: string; field?: string }> {
  if (raw === undefined) return { ops: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ops: [], error: 'invalid_custom_fields' };
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).length === 0) return { ops: [] };

  const { results } = await db
    .prepare('SELECT id, key, type, options FROM contact_field_definitions WHERE event_id = ?')
    .bind(eventId)
    .all<{ id: string; key: string; type: string; options: string | null }>();
  const byKey = new Map(results.map((d) => [d.key, d]));

  const ops: D1PreparedStatement[] = [];
  for (const [key, rawValue] of Object.entries(body)) {
    const def = byKey.get(key);
    if (!def) return { ops: [], error: 'unknown_field', field: key };
    if (rawValue === null || rawValue === '' || rawValue === undefined) {
      ops.push(db.prepare('DELETE FROM contact_field_values WHERE contact_id = ? AND field_id = ?').bind(contactId, def.id));
      continue;
    }
    if (typeof rawValue !== 'string') return { ops: [], error: 'invalid_value', field: key };
    const value = rawValue.trim().slice(0, CONTACT_FIELD_VALUE_MAX_CHARS);
    if (def.type === 'select') {
      let options: string[] = [];
      try {
        options = def.options ? JSON.parse(def.options) : [];
      } catch {
        options = [];
      }
      if (!options.includes(value)) return { ops: [], error: 'invalid_option', field: key };
    }
    ops.push(
      db
        .prepare(
          `INSERT INTO contact_field_values (contact_id, field_id, value) VALUES (?, ?, ?)
           ON CONFLICT (contact_id, field_id) DO UPDATE SET value = excluded.value`,
        )
        .bind(contactId, def.id, value),
    );
  }
  return { ops };
}

/** Contact row plus its custom field values as `{ <key>: value }` json text — same shape (and same NULL-when-empty) as the contacts resource query's `custom_fields_json` column below, so POST/PUT responses match what a subsequent grid refetch would show. Everything is pinned to `eventId`: the join to event_contacts is both the tenancy guard and the source of the profile columns, and the field definitions are event-scoped too, so a contact who also appears in a sibling event never brings that event's custom values back with them. */
async function contactWithCustomFields(
  db: D1Database,
  eventId: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  return db
    .prepare(
      `SELECT c.*, ec.event_id, ec.biography, ec.headshot_asset_id, ec.company,
              ec.job_title, ec.notes, ec.added_at, ec.source,
        (SELECT json_group_object(d.key, v.value) FROM contact_field_values v
         JOIN contact_field_definitions d ON d.id = v.field_id
         WHERE v.contact_id = c.id AND d.event_id = ec.event_id) AS custom_fields_json
       FROM contacts c
       JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
      WHERE c.id = ?`,
    )
    .bind(eventId, id)
    .first();
}

// ---------------------------------------------------------------------------
// Events: create (FR-EVT-1/2) + patch (agenda publish rides the same route)
// ---------------------------------------------------------------------------

const EVENT_TYPES = ['conference', 'workshop', 'summit', 'meetup', 'other'];
const SLUG_RE = /^[a-z0-9-]{2,64}$/;
const DESCRIPTION_MAX_CHARS = 1000;

const looksLikeUrl = (value: string): boolean => /^https?:\/\/[^\s.]+\.[^\s]+$/i.test(value.trim());

// ---------------------------------------------------------------------------
// Event date parsing: CreateEventDialog's <input type="date"> submits bare
// "YYYY-MM-DD" strings. Naively doing `new Date("2027-05-12").toISOString()`
// parses that as UTC midnight, which — rendered back in the event's own
// timezone by apps/admin/src/agenda/timeUtils.ts eventDays() — lands one
// calendar day early for any timezone west of UTC (e.g. a US event configured
// for May 12–14 rendered as May 11–13). Bare dates must instead be read as
// local midnight IN THE EVENT'S TIMEZONE. Full ISO instants (with time/zone,
// e.g. from the REST API or older stored rows) are left untouched.
//
// This mirrors apps/admin/src/agenda/timeUtils.ts's utcToLocal/localToUtc
// two-pass technique, duplicated here rather than imported because the API
// worker and the admin SPA are separate build targets that do not share a
// runtime package for this.
// ---------------------------------------------------------------------------

const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const eventDateDtfCache = new Map<string, Intl.DateTimeFormat>();
function eventDateDtf(tz: string): Intl.DateTimeFormat {
  let f = eventDateDtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    eventDateDtfCache.set(tz, f);
  }
  return f;
}

function utcToLocalDay(iso: string, tz: string): { day: string; minutes: number } {
  const parts = eventDateDtf(tz).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const hour = Number(get('hour')) % 24; // en-CA can emit "24" at midnight
  return { day: `${get('year')}-${get('month')}-${get('day')}`, minutes: hour * 60 + Number(get('minute')) };
}

/** Wall clock (day, minutes) in `tz` -> UTC ISO. Two-pass offset refinement. */
function localDayToUtc(day: string, minutes: number, tz: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const target = Date.UTC(y as number, (m as number) - 1, d as number, 0, minutes);
  let ts = target;
  for (let i = 0; i < 2; i++) {
    const local = utcToLocalDay(new Date(ts).toISOString(), tz);
    const [ly, lm, ld] = local.day.split('-').map(Number);
    const localTs = Date.UTC(ly as number, (lm as number) - 1, ld as number, 0, local.minutes);
    ts += target - localTs;
  }
  return new Date(ts).toISOString();
}

/**
 * starts_at/ends_at accept either a full ISO instant (unchanged behaviour) or
 * a bare YYYY-MM-DD. Bare dates resolve to local midnight in `tz`; `end`
 * dates resolve to the *end* of that local day (the next local midnight minus
 * 1ms) so the configured last day is still the last day agenda/eventDays()
 * shows, not the first minute of it.
 */
export function eventDateToIso(value: unknown, tz: string, end: boolean): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (BARE_DATE_RE.test(trimmed)) {
    if (!end) return localDayToUtc(trimmed, 0, tz);
    const nextLocalMidnight = localDayToUtc(trimmed, 24 * 60, tz);
    return new Date(Date.parse(nextLocalMidnight) - 1).toISOString();
  }
  return Number.isNaN(Date.parse(trimmed)) ? null : new Date(trimmed).toISOString();
}

interface EventFields {
  values: Record<string, string | number | null>;
  error?: string;
}

/** FR-EVT-2 fields, shared by create and patch. `theme` carries the description
 * (0001_init.sql:34 — the events table has no `description` column).
 * `defaultTz` is the timezone bare starts_at/ends_at dates resolve against
 * when the payload doesn't itself carry a `timezone` (create: the env
 * default that will be used if none is given; patch: the event's current
 * stored timezone). */
function pickEventFields(
  raw: unknown,
  { require: mustHave, defaultTz }: { require: boolean; defaultTz: string },
): EventFields {
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
  const effectiveTz = (values.timezone as string | undefined) ?? defaultTz;
  if (mustHave || 'starts_at' in body) {
    const starts = eventDateToIso(body.starts_at, effectiveTz, false);
    if (!starts) return fail('invalid_starts_at');
    values.starts_at = starts;
  }
  if (mustHave || 'ends_at' in body) {
    const ends = eventDateToIso(body.ends_at, effectiveTz, true);
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

interface NamedRow {
  name: string;
  extra: string | number | null;
}

/** Repeatable rooms/tracks rows from the create-event dialog. Blank rows (an
 * empty "add another" row the user never filled in) are dropped rather than
 * rejected — the dialog's UX is add-a-row-then-maybe-fill-it. */
function parseNamedRows(raw: unknown, extraKey: 'capacity' | 'color'): NamedRow[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: NamedRow[] = [];
  for (const item of raw) {
    let name = '';
    let extra: string | number | null = null;
    if (typeof item === 'string') {
      name = item.trim();
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      name = typeof obj.name === 'string' ? obj.name.trim() : '';
      if (extraKey === 'capacity') {
        if ('capacity' in obj) {
          const capacity = parseCapacityValue(obj.capacity);
          if (capacity === undefined) return null;
          extra = capacity;
        }
      } else {
        const color = obj.color;
        if (color === null || color === undefined || color === '') extra = null;
        else if (typeof color === 'string') extra = color.trim().slice(0, 20);
        else return null;
      }
    } else {
      return null;
    }
    if (!name) continue;
    out.push({ name: name.slice(0, ROOM_TRACK_NAME_MAX_CHARS), extra });
  }
  return out;
}

// POST /app/api/events — a new event inside the creator's organisation. The
// creator lands in it as an owner: contacts are org-level since 0015, so their
// existing identity is attached to the new event rather than copied into a
// second row, and the owner seat points at that same person.
// Optional `rooms`/`tracks` arrays (repeatable fields in the create-event
// dialog) are inserted in the same batch so the agenda builder's Add Session
// dialog has real options from the first save, not just "No room"/"No track".
adminApiRoutes.post('/events', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const db = c.env.DB;

  const body = await c.req.json().catch(() => ({}));
  const { values, error } = pickEventFields(body, { require: true, defaultTz: c.env.EVENT_DEFAULT_TZ });
  if (error) return c.json({ error }, 400);
  const rawBody = (body ?? {}) as Record<string, unknown>;
  const rooms = parseNamedRows(rawBody.rooms, 'capacity');
  if (rooms === null) return c.json({ error: 'invalid_rooms' }, 400);
  const tracks = parseNamedRows(rawBody.tracks, 'color');
  if (tracks === null) return c.json({ error: 'invalid_tracks' }, 400);

  const org = await db.prepare('SELECT org_id FROM events WHERE id = ?')
    .bind(session.eventId).first<{ org_id: string }>();
  if (!org) return c.json({ error: 'not_found' }, 404);

  const slug = values.slug as string;
  const taken = await db.prepare('SELECT 1 AS ok FROM events WHERE slug = ?').bind(slug).first();
  if (taken) return c.json({ error: 'slug_taken' }, 409);

  // The creator already has an identity row in this org; the org check is the
  // tenancy guard on reusing it.
  const me = await db.prepare('SELECT id FROM contacts WHERE id = ? AND org_id = ?')
    .bind(session.contactId, org.org_id).first<{ id: string }>();
  if (!me) return c.json({ error: 'not_found' }, 404);

  const id = crypto.randomUUID();
  const contactId = session.contactId;
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
        `INSERT INTO event_users (event_id, contact_id, role, invited_at, accepted_at)
         VALUES (?, ?, 'owner', ?, ?)`,
      ).bind(id, contactId, ts, ts),
      ...rooms.map((r, i) =>
        db.prepare('INSERT INTO rooms (id, event_id, name, capacity, position, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), id, r.name, r.extra, i, ts),
      ),
      ...tracks.map((t, i) =>
        db.prepare('INSERT INTO tracks (id, event_id, name, color, position, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), id, t.name, t.extra, i, ts),
      ),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('UNIQUE')) return c.json({ error: 'slug_taken' }, 409);
    throw err;
  }
  // Membership after the batch: event_contacts.event_id references the event
  // that batch creates. Without it the owner holds a seat but appears on no
  // roster (and reads back through no event-scoped contact query).
  await createDb(db).contacts.attachToEvent(id, contactId, 'admin');
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

  // Bare starts_at/ends_at dates (see eventDateToIso) resolve against the
  // *current* stored timezone when the patch doesn't also change it, so fetch
  // the current row up front whenever either date field is present — this
  // also covers the pre-existing range-check re-query below, one query
  // instead of two.
  let current: { starts_at: string; ends_at: string; timezone: string } | null = null;
  if ('starts_at' in body || 'ends_at' in body) {
    current = await c.env.DB.prepare('SELECT starts_at, ends_at, timezone FROM events WHERE id = ?')
      .bind(eventId).first<{ starts_at: string; ends_at: string; timezone: string }>();
  }

  const { values, error } = pickEventFields(body, {
    require: false,
    defaultTz: current?.timezone ?? c.env.EVENT_DEFAULT_TZ,
  });
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

// GET /app/api/events — the workspace Events tab (W2-E): the org's
// accessible events (event-as-filter model, docs/12) with the fields a list
// row needs plus two cheap counts. Both counts are single grouped queries
// over the same accessible id set rather than one query per event.
adminApiRoutes.get('/events', async (c) => {
  const accessible = await accessibleEvents(c);
  if (accessible.length === 0) return c.json({ items: [] });
  const ids = accessible.map((e) => e.event_id);
  const placeholders = ids.map(() => '?').join(', ');
  const db = c.env.DB;
  const [eventsResult, contactCounts, submissionCounts] = await Promise.all([
    db
      .prepare(
        `SELECT id, name, slug, starts_at, ends_at, agenda_published
         FROM events WHERE id IN (${placeholders}) ORDER BY starts_at DESC`,
      )
      .bind(...ids)
      .all<{ id: string; name: string; slug: string; starts_at: string; ends_at: string; agenda_published: number }>(),
    // Roster size, so it counts event_contacts rows: `contacts` is org-level
    // since 0015 and one person can be counted by several events.
    db
      .prepare(`SELECT event_id, COUNT(*) AS n FROM event_contacts WHERE event_id IN (${placeholders}) GROUP BY event_id`)
      .bind(...ids)
      .all<{ event_id: string; n: number }>(),
    db
      .prepare(`SELECT event_id, COUNT(*) AS n FROM submissions WHERE event_id IN (${placeholders}) GROUP BY event_id`)
      .bind(...ids)
      .all<{ event_id: string; n: number }>(),
  ]);
  const byId = new Map(accessible.map((e) => [e.event_id, e]));
  const contactsById = new Map(contactCounts.results.map((r) => [r.event_id, r.n]));
  const submissionsById = new Map(submissionCounts.results.map((r) => [r.event_id, r.n]));
  return c.json({
    items: eventsResult.results.map((e) => ({
      id: e.id,
      name: e.name,
      slug: e.slug,
      starts_at: e.starts_at,
      ends_at: e.ends_at,
      agenda_published: e.agenda_published === 1,
      role: byId.get(e.id)?.role ?? 'reviewer',
      speaker_count: contactsById.get(e.id) ?? 0,
      submission_count: submissionsById.get(e.id) ?? 0,
    })),
  });
});

// ---------------------------------------------------------------------------
// Bulk jobs (sweep item P2-19) — progress for the 202-style bulk routes.
// ---------------------------------------------------------------------------

// GET /app/api/bulk-jobs/:id → { id, kind, status, total, enqueued, sent, failed, queued, error }
//
// Progress for all three producers of a bulk_jobs row: this file's remind
// handler ('remind-tasks'), agenda send-confirmations (BE-1) and evaluation
// send-decisions (BE-4). `enqueued` is the expander's own counter on the row.
// sent/failed are counted from message_log by `bulk_job_id` — its own
// indexed column since migration 0014. This used to match the job id as an
// interior segment of idempotency_key (`LIKE '%:'||id||':%'`), which put the
// batch inside the UNIQUE key that per-message dedupe depends on and broke
// per-day reminder idempotency outright; it also could never use an index.
// `queued` is every message_log row for this job that is neither sent nor
// failed yet, so a caller that settles on 'done' can distinguish "nothing was
// ever queued" from "queued, delivery still in flight" — reporting the former
// for the latter is what made the decision-email toast contradict the
// Notified stamp the same run had just set.
adminApiRoutes.get('/bulk-jobs/:id', async (c) => {
  const session = c.get('session');
  const jobId = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT j.id, j.kind, j.status, j.total, j.enqueued, j.error, j.params_json, j.skipped_duplicate,
            (SELECT COUNT(*) FROM message_log m
              WHERE m.bulk_job_id = ?1 AND m.status = 'sent') AS sent,
            (SELECT COUNT(*) FROM message_log m
              WHERE m.bulk_job_id = ?1 AND m.status = 'failed') AS failed,
            (SELECT COUNT(*) FROM message_log m
              WHERE m.bulk_job_id = ?1 AND m.status NOT IN ('sent', 'failed')) AS queued
     FROM bulk_jobs j WHERE j.id = ?1 AND j.event_id = ?2`,
  )
    .bind(jobId, session.eventId)
    .first<{
      id: string; kind: string; status: string; total: number | null; enqueued: number;
      error: string | null; params_json: string; skipped_duplicate: number;
      sent: number; failed: number; queued: number;
    }>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  const { params_json, ...body } = row;

  // Additive for the decision-email flow (CFP-14 fix): a submission with no
  // submitter contact is flipped to accepted/declined but never queues a
  // message, so it never picks up notified_at either — the same signal that
  // now gates the "Notified" stamp. Reporting it here lets the UI say
  // "2 sent, 1 skipped (no submitter)" instead of implying every decision
  // was communicated. Computed defensively: any parse/query failure just
  // omits the field rather than failing the whole poll.
  let skippedNoSubmitter: number | undefined;
  if (row.kind === 'send-decisions') {
    try {
      const ids = (JSON.parse(params_json) as { ids?: unknown }).ids;
      if (Array.isArray(ids) && ids.length > 0) {
        const idList = ids.filter((v): v is string => typeof v === 'string');
        if (idList.length > 0) {
          const placeholders = idList.map(() => '?').join(', ');
          const skipped = await c.env.DB.prepare(
            `SELECT COUNT(*) AS n FROM submissions
             WHERE id IN (${placeholders}) AND status IN ('accepted', 'declined') AND notified_at IS NULL`,
          )
            .bind(...idList)
            .first<{ n: number }>();
          skippedNoSubmitter = skipped?.n ?? 0;
        }
      }
    } catch {
      // leave skippedNoSubmitter undefined
    }
  }

  // Additive for the remind-tasks flow (CNT-08 follow-up): expandRemindTasks
  // now delivers inline (see jobs/bulkJobs.ts's deliverNow), so `sent` here
  // is trustworthy the moment the job reports 'done' — but a snapshot id
  // whose contact has no email address (or was deleted) still can't be
  // mailed. Surfacing that count separately means the completion banner can
  // say "1 sent, 1 skipped — no email" instead of a bare "1 reminder sent"
  // that leaves the second id unaccounted for. Computed defensively, same
  // pattern as skippedNoSubmitter above: any parse/query failure just omits
  // the field.
  let skippedNoEmail: number | undefined;
  if (row.kind === 'remind-tasks') {
    try {
      const assignmentIds = (JSON.parse(params_json) as { assignment_ids?: unknown }).assignment_ids;
      if (Array.isArray(assignmentIds) && assignmentIds.length > 0) {
        const idList = assignmentIds.filter((v): v is string => typeof v === 'string');
        if (idList.length > 0) {
          const placeholders = idList.map(() => '?').join(', ');
          const skipped = await c.env.DB.prepare(
            `SELECT COUNT(*) AS n FROM task_assignments ta
             LEFT JOIN contacts c ON c.id = ta.contact_id
             WHERE ta.id IN (${placeholders}) AND (c.id IS NULL OR c.email IS NULL OR TRIM(c.email) = '')`,
          )
            .bind(...idList)
            .first<{ n: number }>();
          skippedNoEmail = skipped?.n ?? 0;
        }
      }
    } catch {
      // leave skippedNoEmail undefined
    }
  }

  return c.json({
    ...body,
    ...(skippedNoSubmitter === undefined ? {} : { skipped_no_submitter: skippedNoSubmitter }),
    ...(skippedNoEmail === undefined ? {} : { skipped_no_email: skippedNoEmail }),
  });
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
  try {
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
  } catch (err) {
    // A fresh event / seat-less legacy session shape must never crash the
    // workspace shell outright — surface a structured error instead of
    // letting the exception propagate as a network-level failure.
    console.error('GET /me failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    return c.json({ error: 'me_failed', message }, 500);
  }
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
