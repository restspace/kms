// Form-builder API (docs/04 §1–2), mounted inside /app/api so the admin JSON
// guard already ran. Forms, their questions (joined to the field library),
// the field library itself, and the metadata the routing/notification editors
// need. Event scope comes from the session on every statement.

import { Hono } from 'hono';
import {
  validateConditionalRuleConfig,
  validateParticipantRolesConfig,
  validateRoutingConfig,
  type ConfigIssue,
  type RoutingActions,
  type RoutingConfig,
} from '@kms/core';
import type { Env } from '../env';
import type { SessionPayload } from '../session';

type ApiEnv = { Bindings: Env; Variables: { session: SessionPayload } };

export const formsAdminRoutes = new Hono<ApiEnv>();

const nowIso = () => new Date().toISOString();

/** Columns admins may write on submission_forms, with light coercion. */
const FORM_FIELDS: Record<string, (v: unknown) => unknown | undefined> = {
  internal_name: (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 255) : undefined),
  external_title: (v) => (typeof v === 'string' ? v.slice(0, 255) : undefined),
  page_heading: (v) => (typeof v === 'string' ? v.slice(0, 15) : undefined), // hard 15-char cap
  welcome_message: (v) => (typeof v === 'string' ? v : v === null ? null : undefined),
  welcome_message_visible: bool01,
  collection_type: (v) => (v === 'abstracts' || v === 'sessions' ? v : undefined),
  collect_participants: bool01,
  status: (v) => (v === 'open' || v === 'closed' ? v : undefined),
  close_at: nullableIso,
  submission_limit: nullableInt,
  allow_multiple_drafts: bool01,
  success_message: (v) => (typeof v === 'string' ? v : v === null ? null : undefined),
  auto_redirect_to_portal: bool01,
  routing_rules: jsonText,
  participant_roles: jsonText,
  notify_admins_on_create: jsonText,
  notify_admins_on_update: jsonText,
  confirmation_email_enabled: bool01,
};

function bool01(v: unknown): number | undefined {
  return typeof v === 'boolean' ? (v ? 1 : 0) : undefined;
}

function nullableIso(v: unknown): string | null | undefined {
  if (v === null || v === '') return null;
  if (typeof v !== 'string') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function nullableInt(v: unknown): number | null | undefined {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** json columns arrive as objects/arrays; store their canonical string. */
function jsonText(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string') {
    try {
      JSON.parse(v);
      return v;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Config guards (sweep item P1-6). Organiser-supplied JSON is validated at
// save time - shape first (shared @kms/core guards), then referential scope:
// a routing action must never point at another event's track, plan, tag or
// contact. Malformed config surfaces as 400 { error, issues[] }, never as a
// runtime surprise on the public form.
// ---------------------------------------------------------------------------

/** Accept the object form the builder posts or the JSON string the DB stores. */
function asJsonValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

async function rejectForeignIds(
  db: D1Database,
  eventId: string,
  table: 'tracks' | 'evaluation_plans' | 'tags' | 'contacts',
  ids: string[],
  path: string,
  issues: ConfigIssue[],
): Promise<void> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))];
  if (unique.length === 0) return;
  const placeholders = unique.map(() => '?').join(', ');
  // `contacts` lost its event_id in 0015: membership of an event now lives on
  // event_contacts. The question this guard asks is unchanged - "is this id on
  // THIS event's roster?" - so only the table it asks it of moves. Every other
  // table here is still plainly event-scoped.
  const sql =
    table === 'contacts'
      ? `SELECT contact_id AS id FROM event_contacts
          WHERE event_id = ? AND contact_id IN (${placeholders})`
      : `SELECT id FROM ${table} WHERE event_id = ? AND id IN (${placeholders})`;
  const { results } = await db
    .prepare(sql)
    .bind(eventId, ...unique)
    .all<{ id: string }>();
  const known = new Set(results.map((r) => r.id));
  for (const id of unique) {
    if (!known.has(id)) issues.push({ path, message: `${id} does not belong to this event` });
  }
}

async function checkRoutingReferences(
  db: D1Database,
  eventId: string,
  config: unknown,
  issues: ConfigIssue[],
): Promise<void> {
  if (!config || typeof config !== 'object') return;
  const cfg = config as RoutingConfig;
  const entries: Array<{ path: string; actions: RoutingActions }> = [];
  (cfg.rules ?? []).forEach((rule, i) => {
    if (rule && typeof rule === 'object' && rule.then) {
      entries.push({ path: `routing_rules.rules[${i}].then`, actions: rule.then });
    }
  });
  if (cfg.fallback) entries.push({ path: 'routing_rules.fallback', actions: cfg.fallback });

  for (const { path, actions } of entries) {
    // `assign_track_ids` is the optional multi-track extra the submit pipeline
    // reads off the action object (RoutingActions itself is frozen).
    const extra = actions as RoutingActions & { assign_track_ids?: unknown };
    const trackIds = [
      ...(actions.set_track_id ? [actions.set_track_id] : []),
      ...(Array.isArray(extra.assign_track_ids)
        ? extra.assign_track_ids.filter((v): v is string => typeof v === 'string')
        : []),
    ];
    await rejectForeignIds(db, eventId, 'tracks', trackIds, `${path}.set_track_id`, issues);
    await rejectForeignIds(
      db,
      eventId,
      'evaluation_plans',
      actions.assign_evaluation_plan_id ? [actions.assign_evaluation_plan_id] : [],
      `${path}.assign_evaluation_plan_id`,
      issues,
    );
    await rejectForeignIds(db, eventId, 'tags', actions.add_tag_ids ?? [], `${path}.add_tag_ids`, issues);
    await rejectForeignIds(
      db,
      eventId,
      'contacts',
      actions.notify_contact_ids ?? [],
      `${path}.notify_contact_ids`,
      issues,
    );
  }
}

/** Validate every config column present on a form create/update body. */
async function formConfigIssues(
  db: D1Database,
  eventId: string,
  body: Record<string, unknown>,
): Promise<ConfigIssue[]> {
  const issues: ConfigIssue[] = [];
  if ('routing_rules' in body && body.routing_rules !== null) {
    const value = asJsonValue(body.routing_rules);
    if (value === undefined) {
      issues.push({ path: 'routing_rules', message: 'must be valid JSON' });
    } else {
      issues.push(...validateRoutingConfig(value));
      if (issues.length === 0) await checkRoutingReferences(db, eventId, value, issues);
    }
  }
  if ('participant_roles' in body && body.participant_roles !== null) {
    const value = asJsonValue(body.participant_roles);
    if (value === undefined) issues.push({ path: 'participant_roles', message: 'must be valid JSON' });
    else issues.push(...validateParticipantRolesConfig(value));
  }
  for (const key of ['notify_admins_on_create', 'notify_admins_on_update'] as const) {
    if (!(key in body) || body[key] === null) continue;
    const value = asJsonValue(body[key]);
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      issues.push({ path: key, message: 'must be an array of contact ids' });
      continue;
    }
    await rejectForeignIds(db, eventId, 'contacts', value as string[], key, issues);
  }
  return issues;
}

/** Validate a question's visibility rule (create + update share this). */
function questionConfigIssues(body: Record<string, unknown>): ConfigIssue[] {
  if (!('visibility' in body) || body.visibility === null) return [];
  const value = asJsonValue(body.visibility);
  if (value === undefined) return [{ path: 'visibility', message: 'must be valid JSON' }];
  return validateConditionalRuleConfig(value);
}

function pickFormFields(raw: unknown): Record<string, unknown> {
  const body = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, coerce] of Object.entries(FORM_FIELDS)) {
    if (!(key in body)) continue;
    const value = coerce(body[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const QUESTION_SELECT = `
  SELECT q.id, q.form_id, q.section, q.position, q.required, q.locked,
         COALESCE(q.label, f.label) AS label, q.help_text,
         COALESCE(q.options, f.options) AS options,
         COALESCE(q.max_chars, f.max_chars) AS max_chars,
         q.visibility, f.id AS field_id, f.key AS field_key, f.type
  FROM form_questions q
  JOIN field_definitions f ON f.id = q.field_id`;

interface QuestionRow {
  id: string;
  form_id: string;
  section: string;
  position: number;
  required: number;
  locked: number;
  label: string;
  help_text: string | null;
  options: string | null;
  max_chars: number | null;
  visibility: string | null;
  field_id: string;
  field_key: string;
  type: string;
}

/** Parse the json-in-TEXT columns for the client. */
function shapeQuestion(row: QuestionRow) {
  return {
    ...row,
    required: row.required === 1,
    locked: row.locked === 1,
    options: row.options ? (JSON.parse(row.options) as unknown) : null,
    visibility: row.visibility ? (JSON.parse(row.visibility) as unknown) : null,
  };
}

/** A canonical Track question does not own its option list — the event's
 *  `tracks` rows are the option list, keyed by track id.
 *
 *  Storing track *names* as free-text options (which is what the form builder
 *  used to do) duplicates the tracks table into every form, so renaming or
 *  deleting a track left each form offering a name that no longer resolved —
 *  submissions then landed with no `track_id`, and the organiser's edit form,
 *  which can only offer real tracks, had no option to show for what the
 *  submitter picked. Deriving here means a rename propagates to every form on
 *  the next render and a submitted value is a track id, so resolution is an
 *  identity check rather than a string match.
 *
 *  Only the canonical `field_key === 'track'` binds. A question merely
 *  *labelled* "Track" (the form builder's "Create Field" flow mints a
 *  `custom_*` key) keeps its own options and the name-matching fallback in
 *  submit.tsx's `trackAnswers`. */
export const TRACK_FIELD_KEY = 'track';

async function trackOptions(db: D1Database, eventId: string) {
  const { results } = await db
    .prepare('SELECT id, name FROM tracks WHERE event_id = ? ORDER BY position')
    .bind(eventId)
    .all<{ id: string; name: string }>();
  return results.map((t) => ({ value: t.id, label: t.name }));
}

export async function loadQuestions(db: D1Database, formId: string, eventId?: string) {
  const { results } = await db
    .prepare(`${QUESTION_SELECT} WHERE q.form_id = ? ORDER BY q.section, q.position`)
    .bind(formId)
    .all<QuestionRow>();
  const questions = results.map(shapeQuestion);
  // Derived only when the question carries no option list of its own. A form
  // that deliberately authored track options — an import, or the id/slug-style
  // values submit-track-option-value.test.ts reproduces from the live CFP form
  // — keeps them and the name-matching path. Migration 0013 clears the stored
  // options on canonical track fields so existing forms adopt derivation.
  const derivable = (q: { field_key: string; options: unknown }) =>
    q.field_key === TRACK_FIELD_KEY && (q.options === null || (Array.isArray(q.options) && q.options.length === 0));
  if (!eventId || !questions.some(derivable)) return questions;
  const options = await trackOptions(db, eventId);
  return questions.map((q) => (derivable(q) ? { ...q, options } : q));
}

async function getForm(db: D1Database, eventId: string, id: string) {
  return db
    .prepare('SELECT * FROM submission_forms WHERE id = ? AND event_id = ?')
    .bind(id, eventId)
    .first<Record<string, unknown>>();
}

/** json-in-TEXT form columns, parsed on the way out — clients (and agents)
 * always see structured values; only the DB stores strings. */
const FORM_JSON_COLUMNS = [
  'routing_rules',
  'participant_roles',
  'cross_field_limits',
  'notify_admins_on_create',
  'notify_admins_on_update',
] as const;

function shapeForm(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  for (const column of FORM_JSON_COLUMNS) {
    const value = out[column];
    if (typeof value === 'string') {
      try {
        out[column] = JSON.parse(value) as unknown;
      } catch {
        out[column] = null;
      }
    }
  }
  return out;
}

// GET / — forms list with submission/draft counts (docs/04 §1).
formsAdminRoutes.get('/', async (c) => {
  const session = c.get('session');
  const { results } = await c.env.DB.prepare(
    `SELECT f.*,
            (SELECT COUNT(*) FROM submissions s WHERE s.form_id = f.id AND s.status != 'draft') AS submission_count,
            (SELECT COUNT(*) FROM submissions s WHERE s.form_id = f.id AND s.status = 'draft') AS draft_count
     FROM submission_forms f
     WHERE f.event_id = ?
     ORDER BY f.created_at`,
  )
    .bind(session.eventId)
    .all();
  return c.json({ items: results.map((r) => shapeForm(r as Record<string, unknown>)) });
});

/** The default question set for new forms (docs/04 §2.3–2.4), by field key. */
const DEFAULT_ABSTRACT_KEYS: Array<{ key: string; required: boolean; locked: boolean }> = [
  { key: 'title', required: true, locked: true },
  { key: 'description', required: true, locked: false },
  { key: 'format', required: true, locked: false },
  { key: 'tags', required: true, locked: false },
  { key: 'track', required: true, locked: false },
  { key: 'level', required: false, locked: false },
  { key: 'language', required: false, locked: false },
  { key: 'capacity', required: false, locked: false },
  { key: 'ceu_credits', required: false, locked: false },
  { key: 'client_session_id', required: false, locked: false },
];
const DEFAULT_PARTICIPANT_KEYS: Array<{ key: string; required: boolean; locked: boolean }> = [
  { key: 'first_name', required: true, locked: true },
  { key: 'last_name', required: true, locked: true },
  { key: 'email', required: true, locked: true },
  { key: 'mobile_phone', required: false, locked: false },
  { key: 'biography', required: false, locked: false },
];

// POST / — create a form seeded with the default question set. Retry-safe:
// an idempotency_key replayed within 24 h returns the originally created form
// instead of minting a duplicate (agents retrying on timeouts, NFR-11 spirit).
formsAdminRoutes.post('/', async (c) => {
  const session = c.get('session');
  const rawBody = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const idempotencyKey =
    typeof rawBody.idempotency_key === 'string' && rawBody.idempotency_key.trim() !== ''
      ? rawBody.idempotency_key.trim().slice(0, 128)
      : null;
  const idemKvKey = idempotencyKey ? `idem:form-create:${session.eventId}:${idempotencyKey}` : null;
  if (idemKvKey) {
    const existingId = await c.env.KV.get(idemKvKey);
    if (existingId) {
      const existing = await getForm(c.env.DB, session.eventId, existingId);
      if (existing) {
        return c.json(
          { form: shapeForm(existing), questions: await loadQuestions(c.env.DB, existingId, session.eventId), replayed: true },
          200,
        );
      }
    }
  }

  const configIssues = await formConfigIssues(c.env.DB, session.eventId, rawBody);
  if (configIssues.length > 0) return c.json({ error: 'invalid_config', issues: configIssues }, 400);

  const fields = pickFormFields(rawBody);
  const id = crypto.randomUUID();
  const ts = nowIso();
  const name = (fields.internal_name as string) ?? 'Untitled form';

  await c.env.DB.prepare(
    `INSERT INTO submission_forms (id, event_id, internal_name, external_title, page_heading,
       collection_type, collect_participants, status, participant_roles, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'open', ?, ?, ?)`,
  )
    .bind(
      id,
      session.eventId,
      name,
      (fields.external_title as string) ?? name,
      (fields.page_heading as string) ?? 'Submit',
      (fields.collection_type as string) ?? 'abstracts',
      JSON.stringify([{ role: 'speaker', min: 1, max: null }]),
      ts,
      ts,
    )
    .run();

  // Seed default questions from the event's field library, skipping any
  // missing keys (a sparse library just yields a shorter default form).
  const { results: fieldRows } = await c.env.DB.prepare(
    'SELECT id, key, max_chars FROM field_definitions WHERE event_id = ?',
  )
    .bind(session.eventId)
    .all<{ id: string; key: string; max_chars: number | null }>();
  const byKey = new Map(fieldRows.map((f) => [f.key, f]));

  const inserts: D1PreparedStatement[] = [];
  const seed = (section: string, defs: Array<{ key: string; required: boolean; locked: boolean }>) => {
    let position = 1;
    for (const def of defs) {
      const field = byKey.get(def.key);
      if (!field) continue;
      inserts.push(
        c.env.DB.prepare(
          `INSERT INTO form_questions (id, form_id, section, field_id, position, required, locked, max_chars)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), id, section, field.id, position++, def.required ? 1 : 0, def.locked ? 1 : 0, field.max_chars),
      );
    }
  };
  seed('abstract', DEFAULT_ABSTRACT_KEYS);
  seed('participant', DEFAULT_PARTICIPANT_KEYS);
  if (inserts.length > 0) await c.env.DB.batch(inserts);

  if (idemKvKey) {
    await c.env.KV.put(idemKvKey, id, { expirationTtl: 24 * 60 * 60 });
  }

  const form = await getForm(c.env.DB, session.eventId, id);
  return c.json({ form: form ? shapeForm(form) : null, questions: await loadQuestions(c.env.DB, id, session.eventId) }, 201);
});

// GET /:id — full form + questions for the builder and the workspace.
formsAdminRoutes.get('/:id', async (c) => {
  const session = c.get('session');
  const form = await getForm(c.env.DB, session.eventId, c.req.param('id'));
  if (!form) return c.json({ error: 'not_found' }, 404);
  return c.json({ form: shapeForm(form), questions: await loadQuestions(c.env.DB, form.id as string, session.eventId) });
});

// PUT /:id — update builder-editable columns. Optimistic concurrency: when
// the caller sends expected_updated_at and it no longer matches, nothing is
// written and 409 { error: 'conflict' } reports the current version — a
// concurrent writer's work is never silently clobbered.
formsAdminRoutes.put('/:id', async (c) => {
  const session = c.get('session');
  const id = c.req.param('id');
  const rawBody = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const expected =
    typeof rawBody.expected_updated_at === 'string' ? rawBody.expected_updated_at : null;
  // Read the current status/close_at unconditionally (not just when guarding
  // on expected_updated_at) — the reopen-transition detection below needs it.
  const before = await c.env.DB.prepare(
    'SELECT updated_at, status, close_at FROM submission_forms WHERE id = ? AND event_id = ?',
  )
    .bind(id, session.eventId)
    .first<{ updated_at: string; status: string; close_at: string | null }>();
  if (!before) return c.json({ error: 'not_found' }, 404);
  if (expected && before.updated_at !== expected) {
    return c.json({ error: 'conflict', current_updated_at: before.updated_at }, 409);
  }
  const configIssues = await formConfigIssues(c.env.DB, session.eventId, rawBody);
  if (configIssues.length > 0) return c.json({ error: 'invalid_config', issues: configIssues }, 400);

  const fields = pickFormFields(rawBody);

  // ABS defect: "Reopen" flipped status back to 'open' but the public gate
  // (submit.tsx isFormClosed, shared with portal.ts) also treats a past
  // close_at as closed, so a stale close date silently kept the form closed
  // underneath the new status. Reopening (closed -> open, detected against
  // the row read above so it fires from the forms list's one-field PUT and
  // from a builder Save alike) clears a close_at that is still in the past,
  // unless this same request is also setting a fresh one. A close_at the
  // caller is explicitly setting to a future date is left alone.
  if (before.status === 'closed' && fields.status === 'open') {
    const nextCloseAt = 'close_at' in fields ? (fields.close_at as string | null) : before.close_at;
    if (nextCloseAt !== null && new Date(nextCloseAt).getTime() < Date.now()) {
      fields.close_at = null;
    }
  }

  const cols = Object.keys(fields);
  if (cols.length > 0) {
    // The updated_at guard re-checks inside the write itself, so two racing
    // saves that both passed the read above still cannot both land.
    const guardSql = expected ? ' AND updated_at = ?' : '';
    const result = await c.env.DB.prepare(
      `UPDATE submission_forms SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ?
       WHERE id = ? AND event_id = ?${guardSql}`,
    )
      .bind(...cols.map((k) => fields[k]), nowIso(), id, session.eventId, ...(expected ? [expected] : []))
      .run();
    if (result.meta.changes === 0) {
      const current = await getForm(c.env.DB, session.eventId, id);
      if (!current) return c.json({ error: 'not_found' }, 404);
      return c.json({ error: 'conflict', current_updated_at: current.updated_at }, 409);
    }
  }
  const form = await getForm(c.env.DB, session.eventId, id);
  if (!form) return c.json({ error: 'not_found' }, 404);
  return c.json({ form: shapeForm(form) });
});

// DELETE /:id — submissions keep their rows (form_id set null by FK).
formsAdminRoutes.delete('/:id', async (c) => {
  const session = c.get('session');
  const result = await c.env.DB.prepare('DELETE FROM submission_forms WHERE id = ? AND event_id = ?')
    .bind(c.req.param('id'), session.eventId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// POST /:id/duplicate — clone the form with its questions and rules.
formsAdminRoutes.post('/:id/duplicate', async (c) => {
  const session = c.get('session');
  const source = await getForm(c.env.DB, session.eventId, c.req.param('id'));
  if (!source) return c.json({ error: 'not_found' }, 404);

  const id = crypto.randomUUID();
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO submission_forms (id, event_id, internal_name, external_title, page_heading,
       welcome_message, welcome_message_visible, collection_type, collect_participants,
       status, close_at, submission_limit, allow_multiple_drafts, success_message,
       auto_redirect_to_portal, cross_field_limits, routing_rules, participant_roles,
       notify_admins_on_create, notify_admins_on_update, confirmation_email_enabled,
       created_at, updated_at)
     SELECT ?, event_id, internal_name || ' (copy)', external_title, page_heading,
       welcome_message, welcome_message_visible, collection_type, collect_participants,
       status, close_at, submission_limit, allow_multiple_drafts, success_message,
       auto_redirect_to_portal, cross_field_limits, routing_rules, participant_roles,
       notify_admins_on_create, notify_admins_on_update, confirmation_email_enabled,
       ?, ?
     FROM submission_forms WHERE id = ?`,
  )
    .bind(id, ts, ts, source.id)
    .run();

  // Clone questions preserving visibility, remapping condition question ids.
  const questions = await c.env.DB.prepare('SELECT * FROM form_questions WHERE form_id = ?')
    .bind(source.id)
    .all<Record<string, unknown>>();
  const idMap = new Map<string, string>();
  for (const q of questions.results) idMap.set(q.id as string, crypto.randomUUID());
  const remapVisibility = (json: string | null): string | null => {
    if (!json) return null;
    try {
      const rule = JSON.parse(json) as { conditions?: Array<{ question_id: string }> };
      for (const cond of rule.conditions ?? []) {
        cond.question_id = idMap.get(cond.question_id) ?? cond.question_id;
      }
      return JSON.stringify(rule);
    } catch {
      return json;
    }
  };
  if (questions.results.length > 0) {
    await c.env.DB.batch(
      questions.results.map((q) =>
        c.env.DB.prepare(
          `INSERT INTO form_questions (id, form_id, section, field_id, label, help_text, position,
             required, locked, options, max_chars, visibility)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          idMap.get(q.id as string),
          id,
          q.section,
          q.field_id,
          q.label,
          q.help_text,
          q.position,
          q.required,
          q.locked,
          q.options,
          q.max_chars,
          remapVisibility(q.visibility as string | null),
        ),
      ),
    );
  }
  const form = await getForm(c.env.DB, session.eventId, id);
  return c.json({ form: form ? shapeForm(form) : null, questions: await loadQuestions(c.env.DB, id, session.eventId) }, 201);
});

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

const QUESTION_FIELDS: Record<string, (v: unknown) => unknown | undefined> = {
  label: (v) => (typeof v === 'string' ? v.slice(0, 255) : v === null ? null : undefined),
  help_text: (v) => (typeof v === 'string' ? v : v === null ? null : undefined),
  required: bool01,
  options: jsonText,
  max_chars: nullableInt,
  visibility: jsonText,
};

// POST /:id/questions — add from the library, or create a field then add.
formsAdminRoutes.post('/:id/questions', async (c) => {
  const session = c.get('session');
  const formId = c.req.param('id');
  const form = await getForm(c.env.DB, session.eventId, formId);
  if (!form) return c.json({ error: 'not_found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const visibilityIssues = questionConfigIssues(body);
  if (visibilityIssues.length > 0) return c.json({ error: 'invalid_config', issues: visibilityIssues }, 400);
  const section = body.section === 'participant' ? 'participant' : 'abstract';

  let fieldId = typeof body.field_id === 'string' ? body.field_id : null;
  const newField = body.new_field as Record<string, unknown> | undefined;
  if (!fieldId && newField && typeof newField.label === 'string' && typeof newField.type === 'string') {
    // "Create Field" adds to the event library, then references it.
    fieldId = crypto.randomUUID();
    const key = `custom_${newField.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)}_${fieldId.slice(0, 4)}`;
    await c.env.DB.prepare(
      `INSERT INTO field_definitions (id, event_id, key, label, type, scope, options, max_chars, system)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
      .bind(
        fieldId,
        session.eventId,
        key,
        newField.label,
        newField.type,
        section === 'participant' ? 'contact' : 'submission',
        jsonText(newField.options) ?? null,
        nullableInt(newField.max_chars) ?? null,
      )
      .run();
  }
  if (!fieldId) return c.json({ error: 'field_required' }, 400);

  const field = await c.env.DB.prepare('SELECT id FROM field_definitions WHERE id = ? AND event_id = ?')
    .bind(fieldId, session.eventId)
    .first();
  if (!field) return c.json({ error: 'field_not_found' }, 404);

  const posRow = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM form_questions WHERE form_id = ? AND section = ?',
  )
    .bind(formId, section)
    .first<{ next: number }>();

  const qid = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO form_questions (id, form_id, section, field_id, label, help_text, position, required, locked, options, max_chars, visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  )
    .bind(
      qid,
      formId,
      section,
      fieldId,
      QUESTION_FIELDS.label!(body.label) ?? null,
      QUESTION_FIELDS.help_text!(body.help_text) ?? null,
      posRow?.next ?? 1,
      bool01(body.required) ?? 0,
      jsonText(body.options) ?? null,
      nullableInt(body.max_chars) ?? null,
      jsonText(body.visibility) ?? null,
    )
    .run();

  return c.json({ questions: await loadQuestions(c.env.DB, formId, session.eventId) }, 201);
});

// PUT /:id/questions/:qid
formsAdminRoutes.put('/:id/questions/:qid', async (c) => {
  const session = c.get('session');
  const formId = c.req.param('id');
  const form = await getForm(c.env.DB, session.eventId, formId);
  if (!form) return c.json({ error: 'not_found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const visibilityIssues = questionConfigIssues(body);
  if (visibilityIssues.length > 0) return c.json({ error: 'invalid_config', issues: visibilityIssues }, 400);
  const updates: Record<string, unknown> = {};
  for (const [key, coerce] of Object.entries(QUESTION_FIELDS)) {
    if (!(key in body)) continue;
    const value = coerce(body[key]);
    if (value !== undefined) updates[key] = value;
  }
  const cols = Object.keys(updates);
  if (cols.length > 0) {
    const result = await c.env.DB.prepare(
      `UPDATE form_questions SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND form_id = ?`,
    )
      .bind(...cols.map((k) => updates[k]), c.req.param('qid'), formId)
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ questions: await loadQuestions(c.env.DB, formId, session.eventId) });
});

// DELETE /:id/questions/:qid — locked system questions cannot be removed.
formsAdminRoutes.delete('/:id/questions/:qid', async (c) => {
  const session = c.get('session');
  const formId = c.req.param('id');
  const form = await getForm(c.env.DB, session.eventId, formId);
  if (!form) return c.json({ error: 'not_found' }, 404);

  const result = await c.env.DB.prepare('DELETE FROM form_questions WHERE id = ? AND form_id = ? AND locked = 0')
    .bind(c.req.param('qid'), formId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'locked_or_missing' }, 400);
  return c.json({ questions: await loadQuestions(c.env.DB, formId, session.eventId) });
});

// POST /:id/questions/reorder {section, ids} — positions follow the given order.
formsAdminRoutes.post('/:id/questions/reorder', async (c) => {
  const session = c.get('session');
  const formId = c.req.param('id');
  const form = await getForm(c.env.DB, session.eventId, formId);
  if (!form) return c.json({ error: 'not_found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const section = body.section === 'participant' ? 'participant' : 'abstract';
  const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === 'string') : [];
  if (ids.length === 0) return c.json({ error: 'ids_required' }, 400);

  await c.env.DB.batch(
    ids.map((qid, index) =>
      c.env.DB.prepare('UPDATE form_questions SET position = ? WHERE id = ? AND form_id = ? AND section = ?')
        .bind(index + 1, qid, formId, section),
    ),
  );
  return c.json({ questions: await loadQuestions(c.env.DB, formId, session.eventId) });
});
