// Form-builder API (docs/04 §1–2), mounted inside /app/api so the admin JSON
// guard already ran. Forms, their questions (joined to the field library),
// the field library itself, and the metadata the routing/notification editors
// need. Event scope comes from the session on every statement.

import { Hono } from 'hono';
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

export async function loadQuestions(db: D1Database, formId: string) {
  const { results } = await db
    .prepare(`${QUESTION_SELECT} WHERE q.form_id = ? ORDER BY q.section, q.position`)
    .bind(formId)
    .all<QuestionRow>();
  return results.map(shapeQuestion);
}

async function getForm(db: D1Database, eventId: string, id: string) {
  return db
    .prepare('SELECT * FROM submission_forms WHERE id = ? AND event_id = ?')
    .bind(id, eventId)
    .first<Record<string, unknown>>();
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
  return c.json({ items: results });
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

// POST / — create a form seeded with the default question set.
formsAdminRoutes.post('/', async (c) => {
  const session = c.get('session');
  const fields = pickFormFields(await c.req.json().catch(() => ({})));
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

  const form = await getForm(c.env.DB, session.eventId, id);
  return c.json({ form, questions: await loadQuestions(c.env.DB, id) }, 201);
});

// GET /:id — full form + questions for the builder and the workspace.
formsAdminRoutes.get('/:id', async (c) => {
  const session = c.get('session');
  const form = await getForm(c.env.DB, session.eventId, c.req.param('id'));
  if (!form) return c.json({ error: 'not_found' }, 404);
  return c.json({ form, questions: await loadQuestions(c.env.DB, form.id as string) });
});

// PUT /:id — update builder-editable columns.
formsAdminRoutes.put('/:id', async (c) => {
  const session = c.get('session');
  const id = c.req.param('id');
  const fields = pickFormFields(await c.req.json().catch(() => ({})));
  const cols = Object.keys(fields);
  if (cols.length > 0) {
    const result = await c.env.DB.prepare(
      `UPDATE submission_forms SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ?
       WHERE id = ? AND event_id = ?`,
    )
      .bind(...cols.map((k) => fields[k]), nowIso(), id, session.eventId)
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  }
  const form = await getForm(c.env.DB, session.eventId, id);
  if (!form) return c.json({ error: 'not_found' }, 404);
  return c.json({ form });
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
  return c.json({ form, questions: await loadQuestions(c.env.DB, id) }, 201);
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

  return c.json({ questions: await loadQuestions(c.env.DB, formId) }, 201);
});

// PUT /:id/questions/:qid
formsAdminRoutes.put('/:id/questions/:qid', async (c) => {
  const session = c.get('session');
  const formId = c.req.param('id');
  const form = await getForm(c.env.DB, session.eventId, formId);
  if (!form) return c.json({ error: 'not_found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
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
  return c.json({ questions: await loadQuestions(c.env.DB, formId) });
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
  return c.json({ questions: await loadQuestions(c.env.DB, formId) });
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
  return c.json({ questions: await loadQuestions(c.env.DB, formId) });
});
