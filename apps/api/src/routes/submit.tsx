// Public CFP submission flow (docs/04 §5): the SSR'd wizard page plus the
// draft-autosave and submit endpoints behind it. The server is authoritative:
// visibility is re-evaluated, hidden answers discarded, limits and the close
// date enforced here regardless of what the client showed.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { renderToString } from 'preact-render-to-string';
import { createDb } from '@kms/db';
import {
  applyRouting,
  discardHiddenAnswers,
  parseParticipantRoles,
  sanitizeRichHtml,
  validateAnswers,
  type Answers,
  type QuestionDef,
  type RoutingConfig,
} from '@kms/core';
import { Page, SubmitPage, type SubmitBootstrap, type SubmitViewer } from '@kms/ui';
import type { AppEnv } from '../env';
import { sendTemplated } from '../mailer';
import { getSession, type SessionPayload } from '../session';
import { loadQuestions } from './formsAdmin';

export const submitRoutes = new Hono<AppEnv>();

interface FormRow {
  id: string;
  event_id: string;
  internal_name: string;
  external_title: string | null;
  page_heading: string | null;
  welcome_message: string | null;
  welcome_message_visible: number;
  collect_participants: number;
  collection_type: 'abstracts' | 'sessions';
  status: 'open' | 'closed';
  close_at: string | null;
  submission_limit: number | null;
  allow_multiple_drafts: number;
  success_message: string | null;
  auto_redirect_to_portal: number;
  routing_rules: string | null;
  participant_roles: string | null;
  confirmation_email_enabled: number;
}

interface EventRow {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  default_submission_limit: number;
}

interface FormContext {
  event: EventRow;
  form: FormRow;
  questions: QuestionDef[];
  limit: number | null;
  closed: boolean;
}

async function loadContext(db: D1Database, slug: string, formId: string): Promise<FormContext | null> {
  const event = await db
    .prepare('SELECT id, name, slug, timezone, default_submission_limit FROM events WHERE slug = ?')
    .bind(slug)
    .first<EventRow>();
  if (!event) return null;
  const form = await db
    .prepare('SELECT * FROM submission_forms WHERE id = ? AND event_id = ?')
    .bind(formId, event.id)
    .first<FormRow>();
  if (!form) return null;
  const questions = (await loadQuestions(db, form.id)) as unknown as QuestionDef[];
  const closed =
    form.status === 'closed' || (form.close_at !== null && new Date(form.close_at).getTime() < Date.now());
  return {
    event,
    form,
    questions,
    limit: form.submission_limit ?? event.default_submission_limit ?? null,
    closed,
  };
}

/** Drafts + submitted both count toward the limit (docs/02 §9); withdrawn does not. */
async function countForLimit(db: D1Database, formId: string, contactId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM submissions
       WHERE form_id = ? AND submitter_contact_id = ? AND status != 'withdrawn'`,
    )
    .bind(formId, contactId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function nextCode(db: D1Database, eventId: string): Promise<string> {
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(CAST(SUBSTR(code, 6) AS INTEGER)), 0) AS n
       FROM submissions WHERE event_id = ? AND code LIKE 'SESS-%'`,
    )
    .bind(eventId)
    .first<{ n: number }>();
  return `SESS-${(row?.n ?? 0) + 1}`;
}

/** Map system-field answers onto submission columns (docs/04 §5 after-submit). */
function systemColumns(questions: QuestionDef[], answers: Answers): Record<string, unknown> {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const out: Record<string, unknown> = {};
  for (const [qid, value] of Object.entries(answers)) {
    const q = byId.get(qid);
    if (!q || value === undefined || value === null) continue;
    switch (q.field_key) {
      case 'title': out.title = String(value).slice(0, 255); break;
      case 'description': out.description = String(value); break;
      case 'format': out.format = String(value); break;
      case 'level': out.level = String(value); break;
      case 'language': out.language = String(value); break;
      case 'capacity': out.capacity = Number(value) || null; break;
      case 'ceu_credits': out.ceu_credits = Number(value) || null; break;
      case 'client_session_id': out.client_session_id = String(value).slice(0, 255); break;
    }
  }
  return out;
}

function trackAnswer(questions: QuestionDef[], answers: Answers): string | null {
  const q = questions.find((x) => x.field_key === 'track');
  const v = q ? answers[q.id] : undefined;
  return typeof v === 'string' && v !== '' ? v : null;
}

function tagAnswers(questions: QuestionDef[], answers: Answers): string[] {
  const q = questions.find((x) => x.field_key === 'tags');
  const v = q ? answers[q.id] : undefined;
  return Array.isArray(v) ? v.map(String) : typeof v === 'string' && v !== '' ? [v] : [];
}

async function replaceAnswers(db: D1Database, submissionId: string, answers: Answers): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM submission_answers WHERE submission_id = ?').bind(submissionId),
  ];
  for (const [qid, value] of Object.entries(answers)) {
    if (value === undefined) continue;
    statements.push(
      db
        .prepare('INSERT INTO submission_answers (submission_id, question_id, value_json) VALUES (?, ?, ?)')
        .bind(submissionId, qid, JSON.stringify(value)),
    );
  }
  await db.batch(statements);
}

function parseAnswers(raw: unknown): Answers {
  if (!raw || typeof raw !== 'object') return {};
  const out: Answers = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (Array.isArray(value) && value.every((v) => typeof v === 'string'))
    ) {
      out[key] = value as Answers[string];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// GET /submit/:slug/:formId — the SSR'd wizard island
// ---------------------------------------------------------------------------

submitRoutes.get('/:slug/:formId', async (c) => {
  const ctx = await loadContext(c.env.DB, c.req.param('slug'), c.req.param('formId'));
  if (!ctx) return c.notFound();
  const { event, form, questions } = ctx;

  // The wizard is session-aware (resumed drafts, prefilled submitter), so the
  // page is not edge-cacheable; the island bundle itself is.
  let viewer: SubmitViewer | null = null;
  const session = await getSession(c);
  if (session && session.eventId === event.id) {
    const contact = await c.env.DB.prepare(
      'SELECT email, first_name, last_name, mobile_phone, biography FROM contacts WHERE id = ?',
    )
      .bind(session.contactId)
      .first<{ email: string; first_name: string | null; last_name: string | null; mobile_phone: string | null; biography: string | null }>();
    if (contact) {
      const [count, draft] = await Promise.all([
        countForLimit(c.env.DB, form.id, session.contactId),
        c.env.DB.prepare(
          `SELECT id FROM submissions
           WHERE form_id = ? AND submitter_contact_id = ? AND status = 'draft'
           ORDER BY updated_at DESC LIMIT 1`,
        )
          .bind(form.id, session.contactId)
          .first<{ id: string }>(),
      ]);
      let draftAnswers: Answers | null = null;
      if (draft) {
        const { results } = await c.env.DB.prepare(
          'SELECT question_id, value_json FROM submission_answers WHERE submission_id = ?',
        )
          .bind(draft.id)
          .all<{ question_id: string; value_json: string | null }>();
        draftAnswers = {};
        for (const row of results) {
          draftAnswers[row.question_id] = row.value_json ? (JSON.parse(row.value_json) as Answers[string]) : null;
        }
      }
      viewer = {
        ...contact,
        submission_count: count,
        draft: draft && draftAnswers ? { id: draft.id, answers: draftAnswers } : null,
      };
    }
  }

  const data: SubmitBootstrap = {
    event: { name: event.name, slug: event.slug, timezone: event.timezone },
    form: {
      id: form.id,
      external_title: form.external_title ?? form.internal_name,
      page_heading: form.page_heading ?? '',
      welcome_message: sanitizeRichHtml(form.welcome_message),
      welcome_message_visible: form.welcome_message_visible === 1,
      collect_participants: form.collect_participants === 1,
      participant_roles: form.participant_roles,
      close_at: form.close_at,
      submission_limit: ctx.limit,
      auto_redirect_to_portal: form.auto_redirect_to_portal === 1,
      success_message: sanitizeRichHtml(form.success_message),
    },
    questions,
    viewer,
    closed: ctx.closed,
    dev_mode: c.env.DEV_MODE === 'on',
    base_path: `/submit/${event.slug}/${form.id}`,
  };

  const html =
    '<!doctype html>' +
    renderToString(
      <Page
        title={`${data.form.external_title} — ${event.name}`}
        clientEntry="/static/submit.js"
        bootstrap={data}
      >
        <SubmitPage data={data} />
      </Page>,
    );
  c.header(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  c.header('referrer-policy', 'strict-origin-when-cross-origin');
  return c.html(html, 200, { 'cache-control': 'private, no-store' });
});

// ---------------------------------------------------------------------------
// POST /submit/:slug/:formId/draft — autosave (docs/04 §5 step 3)
// ---------------------------------------------------------------------------

async function requireSubmitter(c: Context<AppEnv>, eventId: string): Promise<SessionPayload | null> {
  const session = await getSession(c);
  return session && session.eventId === eventId ? session : null;
}

submitRoutes.post('/:slug/:formId/draft', async (c) => {
  const ctx = await loadContext(c.env.DB, c.req.param('slug'), c.req.param('formId'));
  if (!ctx) return c.notFound();
  if (ctx.closed) return c.json({ error: 'form_closed' }, 409);
  const session = await requireSubmitter(c, ctx.event.id);
  if (!session) return c.json({ error: 'unauthenticated' }, 401);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const abstractQuestions = ctx.questions.filter((q) => q.section === 'abstract');
  const answers = discardHiddenAnswers(abstractQuestions, parseAnswers(body.answers));
  const ts = new Date().toISOString();

  let submissionId = typeof body.submission_id === 'string' ? body.submission_id : null;
  if (submissionId) {
    const owned = await c.env.DB.prepare(
      `SELECT id FROM submissions WHERE id = ? AND form_id = ? AND submitter_contact_id = ? AND status = 'draft'`,
    )
      .bind(submissionId, ctx.form.id, session.contactId)
      .first();
    if (!owned) submissionId = null;
  }
  if (!submissionId) {
    // Without multiple-drafts, an existing open draft is reused, not duplicated.
    if (ctx.form.allow_multiple_drafts !== 1) {
      const existing = await c.env.DB.prepare(
        `SELECT id FROM submissions WHERE form_id = ? AND submitter_contact_id = ? AND status = 'draft'
         ORDER BY updated_at DESC LIMIT 1`,
      )
        .bind(ctx.form.id, session.contactId)
        .first<{ id: string }>();
      if (existing) submissionId = existing.id;
    }
  }

  const columns = systemColumns(abstractQuestions, answers);
  if (!submissionId) {
    if (ctx.limit !== null && (await countForLimit(c.env.DB, ctx.form.id, session.contactId)) >= ctx.limit) {
      return c.json({ error: 'limit_reached' }, 409);
    }
    submissionId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO submissions (id, event_id, form_id, code, kind, title, description, status,
         format, level, language, capacity, ceu_credits, client_session_id,
         submitter_contact_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, 'form', ?, ?)`,
    )
      .bind(
        submissionId,
        ctx.event.id,
        ctx.form.id,
        await nextCode(c.env.DB, ctx.event.id),
        ctx.form.collection_type === 'sessions' ? 'session' : 'abstract',
        (columns.title as string) ?? 'Untitled draft',
        (columns.description as string) ?? null,
        (columns.format as string) ?? null,
        (columns.level as string) ?? null,
        (columns.language as string) ?? null,
        (columns.capacity as number) ?? null,
        (columns.ceu_credits as number) ?? null,
        (columns.client_session_id as string) ?? null,
        session.contactId,
        ts,
        ts,
      )
      .run();
  } else {
    await c.env.DB.prepare(
      `UPDATE submissions SET title = ?, description = ?, format = ?, level = ?, language = ?,
         capacity = ?, ceu_credits = ?, client_session_id = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        (columns.title as string) ?? 'Untitled draft',
        (columns.description as string) ?? null,
        (columns.format as string) ?? null,
        (columns.level as string) ?? null,
        (columns.language as string) ?? null,
        (columns.capacity as number) ?? null,
        (columns.ceu_credits as number) ?? null,
        (columns.client_session_id as string) ?? null,
        ts,
        submissionId,
      )
      .run();
  }
  await replaceAnswers(c.env.DB, submissionId, answers);
  return c.json({ submission_id: submissionId });
});

// ---------------------------------------------------------------------------
// POST /submit/:slug/:formId/submit — the authoritative submit
// ---------------------------------------------------------------------------

interface ParticipantInput {
  email: string;
  first_name: string;
  last_name: string;
  mobile_phone: string;
  biography: string;
  role: string;
}

const PARTICIPANT_ROLES = new Set(['speaker', 'co-speaker', 'moderator', 'panelist']);

function parseParticipants(raw: unknown): ParticipantInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === 'object')
    .map((p) => ({
      email: typeof p.email === 'string' ? p.email.trim().toLowerCase() : '',
      first_name: typeof p.first_name === 'string' ? p.first_name.trim() : '',
      last_name: typeof p.last_name === 'string' ? p.last_name.trim() : '',
      mobile_phone: typeof p.mobile_phone === 'string' ? p.mobile_phone.trim() : '',
      biography: typeof p.biography === 'string' ? p.biography : '',
      role: typeof p.role === 'string' && PARTICIPANT_ROLES.has(p.role) ? p.role : 'speaker',
    }))
    .filter((p) => p.email !== '');
}

submitRoutes.post('/:slug/:formId/submit', async (c) => {
  const ctx = await loadContext(c.env.DB, c.req.param('slug'), c.req.param('formId'));
  if (!ctx) return c.notFound();
  if (ctx.closed) return c.json({ error: 'form_closed' }, 409);
  const session = await requireSubmitter(c, ctx.event.id);
  if (!session) return c.json({ error: 'unauthenticated' }, 401);

  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const abstractQuestions = ctx.questions.filter((q) => q.section === 'abstract');

  // Authoritative pass: hidden answers discarded, then required/max validated.
  const answers = discardHiddenAnswers(abstractQuestions, parseAnswers(body.answers));
  const validation = validateAnswers(abstractQuestions, answers);
  if (validation.length > 0) {
    return c.json({ error: 'validation_failed', errors: validation }, 400);
  }

  // Participants: the signed-in submitter is always participant 1 / primary.
  let participants = parseParticipants(body.participants);
  const submitterContact = await db
    .prepare('SELECT email, first_name, last_name, mobile_phone, biography FROM contacts WHERE id = ?')
    .bind(session.contactId)
    .first<{ email: string; first_name: string | null; last_name: string | null; mobile_phone: string | null; biography: string | null }>();
  if (!submitterContact) return c.json({ error: 'unauthenticated' }, 401);
  if (ctx.form.collect_participants === 1) {
    const submitterIndex = participants.findIndex((p) => p.email === submitterContact.email);
    if (submitterIndex > 0) {
      participants = [participants[submitterIndex]!, ...participants.filter((_, i) => i !== submitterIndex)];
    } else if (submitterIndex === -1) {
      participants = [
        {
          email: submitterContact.email,
          first_name: submitterContact.first_name ?? '',
          last_name: submitterContact.last_name ?? '',
          mobile_phone: submitterContact.mobile_phone ?? '',
          biography: submitterContact.biography ?? '',
          role: 'speaker',
        },
        ...participants,
      ];
    }
    const roleConfig = parseParticipantRoles(ctx.form.participant_roles);
    const allowedRoles = new Set(roleConfig.map((cfg) => cfg.role));
    const seenEmails = new Set<string>();
    for (const participant of participants) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(participant.email)) {
        return c.json({ error: 'participants_invalid', detail: 'every participant needs a valid email' }, 400);
      }
      if (seenEmails.has(participant.email)) {
        return c.json({ error: 'participants_invalid', detail: `duplicate participant ${participant.email}` }, 400);
      }
      seenEmails.add(participant.email);
      if (!participant.first_name || !participant.last_name) {
        return c.json({ error: 'participants_invalid', detail: 'first and last name are required' }, 400);
      }
      if (participant.first_name.length > 255 || participant.last_name.length > 255 || participant.biography.length > 5000) {
        return c.json({ error: 'participants_invalid', detail: 'participant profile exceeds its character limit' }, 400);
      }
      if (!allowedRoles.has(participant.role as typeof roleConfig[number]['role'])) {
        return c.json({ error: 'participants_invalid', detail: `role ${participant.role} is not enabled for this form` }, 400);
      }
    }
    for (const cfg of roleConfig) {
      const count = participants.filter((p) => p.role === cfg.role).length;
      if (count < cfg.min) return c.json({ error: 'participants_invalid', detail: `at least ${cfg.min} ${cfg.role}` }, 400);
      if (cfg.max !== null && count > cfg.max) return c.json({ error: 'participants_invalid', detail: `at most ${cfg.max} ${cfg.role}` }, 400);
    }
  } else {
    participants = [];
  }

  // Draft being promoted, if any (it does not count against the limit).
  let submissionId = typeof body.submission_id === 'string' ? body.submission_id : null;
  if (submissionId) {
    const owned = await db
      .prepare(`SELECT id FROM submissions WHERE id = ? AND form_id = ? AND submitter_contact_id = ? AND status = 'draft'`)
      .bind(submissionId, ctx.form.id, session.contactId)
      .first();
    if (!owned) submissionId = null;
  }
  if (!submissionId && ctx.limit !== null) {
    if ((await countForLimit(db, ctx.form.id, session.contactId)) >= ctx.limit) {
      return c.json({ error: 'limit_reached' }, 409);
    }
  }

  // Routing (docs/04 §4) — answers keyed by question id.
  let routingConfig: RoutingConfig | null = null;
  try {
    routingConfig = ctx.form.routing_rules ? (JSON.parse(ctx.form.routing_rules) as RoutingConfig) : null;
  } catch {
    routingConfig = null;
  }
  const routing = applyRouting(routingConfig, answers);

  // Resolve configured references inside this event. Routing JSON is editable
  // input, so foreign tenant IDs must not be allowed to cross-link records.
  let trackId: string | null = null;
  if (routing.set_track_id) {
    const row = await db
      .prepare('SELECT id FROM tracks WHERE id = ? AND event_id = ?')
      .bind(routing.set_track_id, ctx.event.id)
      .first<{ id: string }>();
    trackId = row?.id ?? null;
  }
  if (!trackId) {
    const trackName = trackAnswer(abstractQuestions, answers);
    if (trackName) {
      const row = await db
        .prepare('SELECT id FROM tracks WHERE event_id = ? AND name = ?')
        .bind(ctx.event.id, trackName)
        .first<{ id: string }>();
      trackId = row?.id ?? null;
    }
  }

  let evaluationPlanId: string | null = null;
  if (routing.assign_evaluation_plan_id) {
    const row = await db
      .prepare('SELECT id FROM evaluation_plans WHERE id = ? AND event_id = ?')
      .bind(routing.assign_evaluation_plan_id, ctx.event.id)
      .first<{ id: string }>();
    evaluationPlanId = row?.id ?? null;
  }

  // Tags: the tags answer (names) plus event-scoped routing tag ids.
  const tagIds = new Set<string>();
  if (routing.add_tag_ids.length > 0) {
    const placeholders = routing.add_tag_ids.map(() => '?').join(', ');
    const { results } = await db
      .prepare(`SELECT id FROM tags WHERE event_id = ? AND id IN (${placeholders})`)
      .bind(ctx.event.id, ...routing.add_tag_ids)
      .all<{ id: string }>();
    for (const row of results) tagIds.add(row.id);
  }
  const tagNames = tagAnswers(abstractQuestions, answers);
  if (tagNames.length > 0) {
    const placeholders = tagNames.map(() => '?').join(', ');
    const { results } = await db
      .prepare(`SELECT id FROM tags WHERE event_id = ? AND name IN (${placeholders})`)
      .bind(ctx.event.id, ...tagNames)
      .all<{ id: string }>();
    for (const row of results) tagIds.add(row.id);
  }

  const routableStatuses = new Set(['pending', 'accept_queue', 'decline_queue']);
  const status = routing.set_status && routableStatuses.has(routing.set_status)
    ? routing.set_status
    : 'pending';
  const columns = systemColumns(abstractQuestions, answers);
  const ts = new Date().toISOString();
  const title = (columns.title as string) ?? 'Untitled';
  let code: string;

  if (submissionId) {
    const existing = await db
      .prepare('SELECT code FROM submissions WHERE id = ?')
      .bind(submissionId)
      .first<{ code: string }>();
    code = existing?.code ?? (await nextCode(db, ctx.event.id));
    await db
      .prepare(
        `UPDATE submissions SET title = ?, description = ?, status = ?, format = ?, level = ?, language = ?,
           capacity = ?, ceu_credits = ?, client_session_id = ?, track_id = ?, evaluation_plan_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        title,
        (columns.description as string) ?? null,
        status,
        (columns.format as string) ?? null,
        (columns.level as string) ?? null,
        (columns.language as string) ?? null,
        (columns.capacity as number) ?? null,
        (columns.ceu_credits as number) ?? null,
        (columns.client_session_id as string) ?? null,
        trackId,
        evaluationPlanId,
        ts,
        submissionId,
      )
      .run();
  } else {
    submissionId = crypto.randomUUID();
    code = await nextCode(db, ctx.event.id);
    await db
      .prepare(
        `INSERT INTO submissions (id, event_id, form_id, code, kind, title, description, status,
           format, level, language, capacity, ceu_credits, client_session_id, track_id,
           evaluation_plan_id, submitter_contact_id, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'form', ?, ?)`,
      )
      .bind(
        submissionId,
        ctx.event.id,
        ctx.form.id,
        code,
        ctx.form.collection_type === 'sessions' ? 'session' : 'abstract',
        title,
        (columns.description as string) ?? null,
        status,
        (columns.format as string) ?? null,
        (columns.level as string) ?? null,
        (columns.language as string) ?? null,
        (columns.capacity as number) ?? null,
        (columns.ceu_credits as number) ?? null,
        (columns.client_session_id as string) ?? null,
        trackId,
        evaluationPlanId,
        session.contactId,
        ts,
        ts,
      )
      .run();
  }

  await replaceAnswers(db, submissionId, answers);

  // Tags
  const tagStatements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM submission_tags WHERE submission_id = ?').bind(submissionId),
  ];
  for (const tagId of tagIds) {
    tagStatements.push(
      db.prepare('INSERT OR IGNORE INTO submission_tags (submission_id, tag_id) VALUES (?, ?)').bind(submissionId, tagId),
    );
  }
  await db.batch(tagStatements);

  // Participants: upsert contacts by email, then replace the participant rows.
  const kdb = createDb(db);
  const participantStatements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM submission_participants WHERE submission_id = ?').bind(submissionId),
  ];
  let position = 1;
  for (const p of participants) {
    const existingContact = await kdb.contacts.getByEmail(ctx.event.id, p.email);
    const contact = existingContact ?? await kdb.contacts.upsertByEmail(ctx.event.id, p.email);
    // A submitter may initialise a new co-speaker record, but must not
    // overwrite another existing speaker's self-managed profile by knowing
    // only their email address.
    const updates: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of [
      ['first_name', p.first_name],
      ['last_name', p.last_name],
      ['mobile_phone', p.mobile_phone],
      ['biography', p.biography],
    ] as const) {
      if (value) {
        updates.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (updates.length > 0 && (!existingContact || contact.id === session.contactId)) {
      await db
        .prepare(`UPDATE contacts SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`)
        .bind(...params, ts, contact.id)
        .run();
    }
    participantStatements.push(
      db
        .prepare(
          `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact, confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          submissionId,
          contact.id,
          p.role,
          position,
          contact.id === session.contactId ? 1 : 0,
          contact.id === session.contactId ? ts : null,
        ),
    );
    position += 1;
  }
  if (ctx.form.collect_participants !== 1) {
    // Still record the submitter as the speaker so the anchor filter works.
    participantStatements.push(
      db
        .prepare(
          `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact, confirmed_at)
           VALUES (?, ?, ?, 'speaker', 1, 1, ?)`,
        )
        .bind(crypto.randomUUID(), submissionId, session.contactId, ts),
    );
  }
  await db.batch(participantStatements);

  // Confirmation email (must-have, docs/04 §2.6) through the template
  // pipeline: message_log row, outbox retry, immediate attempt — idempotent
  // on the submission id so a double-submit cannot double-send.
  if (ctx.form.confirmation_email_enabled === 1) {
    await sendTemplated(c, {
      templateKey: 'submission_confirmation',
      eventId: ctx.event.id,
      contactId: session.contactId,
      toEmail: submitterContact.email,
      entityId: submissionId,
      context: {
        event: { name: ctx.event.name },
        submission: { title, code },
        portal_url: `${c.env.APP_URL}/portal/${ctx.event.slug}`,
      },
    });
  }

  return c.json({
    ok: true,
    code,
    submission_id: submissionId,
    portal_url: `/portal/${ctx.event.slug}`,
    auto_redirect: ctx.form.auto_redirect_to_portal === 1,
    success_message: sanitizeRichHtml(ctx.form.success_message),
    routing: {
      evaluation_plan_id: evaluationPlanId,
      applied_rule_ids: routing.applied_rule_ids,
      used_fallback: routing.used_fallback,
    },
  });
});
