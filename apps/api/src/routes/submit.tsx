// Public CFP submission flow (docs/04 §5): the SSR'd wizard page plus the
// draft-autosave and submit endpoints behind it. The server is authoritative:
// visibility is re-evaluated, hidden answers discarded, limits and the close
// date enforced here regardless of what the client showed.
//
// Every write path is ONE `db.batch` (sweep item P0-1). D1 has no interactive
// transactions, but a batch *is* an implicit transaction: either the
// submission, its answers, participants, tags, tracks, confirmation token and
// queued emails all land, or none of them do. Nothing is validated after the
// first write — the complete request is normalised up front.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { renderToString } from 'preact-render-to-string';
import {
  ALL_PARTICIPANT_ROLES,
  applyRouting,
  discardHiddenAnswers,
  isValidEmailShape,
  MAX_PARTICIPANTS_PER_SUBMISSION,
  parseParticipantRoles,
  sanitizeRichHtml,
  validateAnswers,
  type Answers,
  type QuestionDef,
  type RoutingActions,
  type RoutingConfig,
  type RoutingOutcome,
} from '@kms/core';
import { createDb } from '@kms/db';
import { Page, SubmitPage, type SubmitBootstrap, type SubmitViewer } from '@kms/ui';
import type { AppEnv } from '../env';
import { attemptImmediate, prepareTemplated, sendTemplated, type PreparedEmail } from '../mailer';
import { bumpEventRevision } from '../revision';
import { isSubmissionCodeCollision, nextSessionCodeSql, peekNextSessionCode } from '../sessionCode';
import { createSessionToken, getSession, setSessionCookie, type SessionPayload } from '../session';
import { CONFIRM_TTL_SECONDS, mintToken, sha256hex } from '../tokens';
import { requestMagicLink } from './auth';
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
  notify_admins_on_create: string | null;
  notify_admins_on_update: string | null;
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

/** No limit configured: bind a sentinel so the guard SQL stays one shape. */
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * Whether a form is closed to new submissions and edits right now. Shared
 * with the portal edit routes (portal.ts) so "closed" means exactly one
 * thing everywhere: explicit status='closed', or close_at in the past.
 * close_at is a full ISO instant (set via the admin's tz-aware datetime
 * picker — apps/admin/src/utils/dates.ts localInputToIso), never a bare
 * date, so this comparison needs no timezone handling of its own.
 */
export function isFormClosed(form: { status: string; close_at: string | null }): boolean {
  return form.status === 'closed' || (form.close_at !== null && new Date(form.close_at).getTime() < Date.now());
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
  const questions = (await loadQuestions(db, form.id, event.id)) as unknown as QuestionDef[];
  const closed = isFormClosed(form);
  return {
    event,
    form,
    questions,
    limit: form.submission_limit ?? event.default_submission_limit ?? null,
    closed,
  };
}

/** Shared limit_reached body: names exactly what counts so a blocked
 * submitter (or an agent reading the response) knows withdrawing frees a
 * slot instead of assuming the cap is stuck. The cap is per FORM (docs/02
 * §9: "Submissions per submitter per form <= submission_limit"; docs/04
 * §2.5's "Event max" chip is only the fallback value a form inherits when it
 * sets no override of its own) — this is called out explicitly so a
 * submitter already at one form's limit does not read a 409 on a *different*
 * form as the same account-wide cap they just hit. */
const LIMIT_REACHED_MESSAGE =
  'Submission limit reached for this form. Active submissions and saved drafts count toward the limit; withdrawn submissions do not — withdraw one to free up a slot.';
const limitReachedBody = () => ({ error: 'limit_reached', message: LIMIT_REACHED_MESSAGE });

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

/** Track names picked in the answers. A multiselect track question yields every
 *  selected value (Swyx multi-track gap) — all of them are resolved.
 *
 *  The organizer's form builder "Create Field" flow (formsAdmin.ts) mints a
 *  synthetic `custom_<label>_<id4>` field_key for any field created inline
 *  while adding a question, so an organizer-authored "Track" question on a
 *  custom-built form never has field_key === 'track' — the exact-match
 *  lookup silently resolved to no track at all (same root cause the 'level'
 *  system column mapping above hit). Mirrors the admin's own label-based
 *  fallback for that bug (workspace/extras.tsx's `levelAnswer` lookup): the
 *  canonical field_key match is tried first, then any question whose label
 *  reads as a track field, in question order. The value shape is unchanged
 *  either way — a track name (or names, for multiselect) resolved against
 *  this event's tracks by name just below in the submit handler. */
function trackAnswers(questions: QuestionDef[], answers: Answers): string[] {
  const byFieldKey = questions.find((x) => x.field_key === 'track');
  const byLabel = questions.filter(
    (x) => x.field_key !== 'track' && typeof x.label === 'string' && x.label.trim().toLowerCase().includes('track'),
  );
  const candidates = byFieldKey ? [byFieldKey, ...byLabel] : byLabel;
  for (const q of candidates) {
    // A dropdown/radio/multiselect question's *submitted* answer is the
    // option's `value` (SubmitPage.tsx's <option value={o.value}>), which the
    // form builder's typed-choices flow sets equal to the label — but not
    // every option list is built that way (an imported/organizer-authored
    // question can give an option a machine value like an id or slug distinct
    // from its display text). What a submitter actually picked, and what
    // tracks.name needs to be matched against, is the LABEL they saw and
    // clicked, not the value the answer happens to be keyed by. Resolve raw
    // answer values through the question's own options first; only a value
    // with no matching option (free text, or options===null) is used as-is.
    const resolveLabel = (raw: string): string => {
      const opt = q.options?.find((o) => o.value === raw);
      return opt ? opt.label : raw;
    };
    const v = answers[q.id];
    if (Array.isArray(v)) {
      const names = v.map(String).filter((s) => s !== '').map(resolveLabel);
      if (names.length > 0) return names;
      continue;
    }
    if (typeof v === 'string' && v !== '') return [resolveLabel(v)];
  }
  return [];
}

/** The canonical Track question, whose options are derived from the event's
 *  tracks (`loadQuestions`) rather than stored on the question. Its submitted
 *  values are therefore track ids. */
function trackBoundQuestion(questions: QuestionDef[]): QuestionDef | undefined {
  return questions.find((x) => x.field_key === 'track');
}

/** Raw submitted values for the track-bound question — track ids, resolved by
 *  identity in the submit handler before the (still supported) name match. */
function trackAnswerValues(questions: QuestionDef[], answers: Answers): string[] {
  const q = trackBoundQuestion(questions);
  if (!q) return [];
  const v = answers[q.id];
  if (Array.isArray(v)) return v.map(String).filter((s) => s !== '');
  return typeof v === 'string' && v !== '' ? [v] : [];
}

/** Incoming answers with any track picked *by name* swapped for its track id.
 *
 *  The derived Track options are keyed by id, and `validateAnswers` checks a
 *  choice answer against the option values — so a submission that still sends
 *  a track name would be rejected. Names arrive from two real places: a draft
 *  saved before the options were derived, and any client posting the API
 *  directly against the older shape. Accepting both keeps those working while
 *  the id remains what the pipeline resolves against. */
function normaliseTrackAnswers(questions: QuestionDef[], answers: Answers): Answers {
  const q = trackBoundQuestion(questions);
  const options = q?.options;
  if (!q || !options || answers[q.id] === undefined) return answers;
  const byLabel = new Map(options.map((o) => [o.label.trim().toLowerCase(), o.value]));
  const toId = (raw: unknown) =>
    typeof raw === 'string' && !options.some((o) => o.value === raw)
      ? byLabel.get(raw.trim().toLowerCase()) ?? raw
      : raw;
  const v = answers[q.id];
  return { ...answers, [q.id]: Array.isArray(v) ? v.map(toId) : toId(v) } as Answers;
}

/** Answers as they should be stored. A track-bound question submits a track
 *  id, but `submission_answers` is read straight back out as display text by
 *  the portal, the organiser detail panel and the exports — so the id is
 *  swapped for the track name it stands for. Storing the name also keeps every
 *  answer row readable if the track is later deleted, and keeps existing rows
 *  (which always held names) the same shape. Nothing else is rewritten. */
function storableAnswers(questions: QuestionDef[], answers: Answers): Answers {
  const q = trackBoundQuestion(questions);
  if (!q || !q.options || answers[q.id] === undefined) return answers;
  const label = (raw: string) => q.options?.find((o) => o.value === raw)?.label ?? raw;
  const v = answers[q.id];
  const swapped = Array.isArray(v)
    ? v.map((entry) => (typeof entry === 'string' ? label(entry) : entry))
    : typeof v === 'string'
      ? label(v)
      : v;
  return { ...answers, [q.id]: swapped };
}

function tagAnswers(questions: QuestionDef[], answers: Answers): string[] {
  const q = questions.find((x) => x.field_key === 'tags');
  const v = q ? answers[q.id] : undefined;
  return Array.isArray(v) ? v.map(String) : typeof v === 'string' && v !== '' ? [v] : [];
}

/**
 * Answer rows for one submission, as statements for the caller's batch. The
 * inserts are guarded on the parent row so a batch whose conditional create
 * inserted nothing (quota reached) fails cleanly on `changes === 0` rather
 * than on a foreign-key error.
 */
function answerStatements(db: D1Database, submissionId: string, answers: Answers): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM submission_answers WHERE submission_id = ?').bind(submissionId),
  ];
  for (const [qid, value] of Object.entries(answers)) {
    if (value === undefined) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO submission_answers (submission_id, question_id, value_json)
           SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ?1)`,
        )
        .bind(submissionId, qid, JSON.stringify(value)),
    );
  }
  return statements;
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
    // Identity from contacts, biography from this event's profile row (0015).
    // LEFT JOIN, not JOIN: the contact id comes from a verified session, so a
    // person who has no membership row here yet still gets their name
    // prefilled — they simply have no bio *for this event* to prefill with.
    const contact = await c.env.DB.prepare(
      `SELECT c.email, c.first_name, c.last_name, c.mobile_phone, ec.biography
         FROM contacts c
         LEFT JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
        WHERE c.id = ?`,
    )
      .bind(event.id, session.contactId)
      .first<{ email: string; first_name: string | null; last_name: string | null; mobile_phone: string | null; biography: string | null }>();
    if (contact) {
      const [count, draft] = await Promise.all([
        countForLimit(c.env.DB, form.id, session.contactId),
        c.env.DB.prepare(
          `SELECT id, title FROM submissions
           WHERE form_id = ? AND submitter_contact_id = ? AND status = 'draft'
           ORDER BY updated_at DESC LIMIT 1`,
        )
          .bind(form.id, session.contactId)
          .first<{ id: string; title: string | null }>(),
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
        // title falls back the same way the draft endpoint's own default does,
        // so the resume-vs-new prompt never shows a blank title.
        draft: draft && draftAnswers ? { id: draft.id, title: draft.title || 'Untitled draft', answers: draftAnswers } : null,
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
// POST /submit/:slug/:formId/account — the Account step (docs/04 §5 step 2).
//
// The magic-link round trip (/auth/request) is the only sign-in path the
// portal exposes, and on a deployment with no working email provider that
// is a dead end for anyone who is not one of the two seeded demo addresses
// (docs/12's carve-out). This endpoint gives a genuinely new speaker a
// working account without an email round trip:
//
//   - unrecognised email  -> a contact row is created and the caller is
//     signed in immediately (session cookie set in the response), so the
//     wizard can proceed to the Submission step with no further round trip.
//     A magic-link email is still queued best-effort for a return visit —
//     queueing is fire-and-forget and never blocks or fails the response.
//   - already-registered email -> never silently bind the caller to
//     somebody else's identity. Falls back to the existing sign-in
//     mechanism (requestMagicLink: a real email, or the demo inline link
//     for the two seeded addresses) exactly as /auth/request would.
//
// The existence check and the insert are one atomic, race-free statement
// (INSERT ... ON CONFLICT DO NOTHING RETURNING id) — two concurrent calls
// for the same brand-new email can only ever produce one "created" winner,
// mirroring the atomicity discipline the submit batch below uses.
// ---------------------------------------------------------------------------

submitRoutes.post('/:slug/:formId/account', async (c) => {
  const ctx = await loadContext(c.env.DB, c.req.param('slug'), c.req.param('formId'));
  if (!ctx) return c.notFound();
  if (ctx.closed) return c.json({ error: 'form_closed' }, 409);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const email = (typeof body.email === 'string' ? body.email : '').trim().toLowerCase();
  if (!isValidEmailShape(email)) {
    return c.json({ error: 'invalid_email' }, 400);
  }

  const db = c.env.DB;
  const ts = new Date().toISOString();
  const redirectTo = `/submit/${ctx.event.slug}/${ctx.form.id}`;

  // Dedupe scope is the ORGANISATION as of 0015, so "already registered" now
  // includes a person known from another event in the same org. The org id is
  // derived rather than carried on EventRow (contract: never assume one org).
  const inserted = await db
    .prepare(
      `INSERT INTO contacts (id, org_id, email, created_at, updated_at)
       VALUES (?1, (SELECT org_id FROM events WHERE id = ?2), ?3, ?4, ?4)
       ON CONFLICT (org_id, lower(email)) DO NOTHING
       RETURNING id`,
    )
    .bind(crypto.randomUUID(), ctx.event.id, email, ts)
    .first<{ id: string }>();

  if (!inserted) {
    // A contact already exists for this email (self-registered before, added
    // as a co-speaker by someone else, another event in this org, seeded demo
    // data — the reason is deliberately not distinguished). Offer the normal
    // sign-in path instead of auto-authenticating into a record that might not
    // belong to whoever is typing. Deliberately NOT attached to this event
    // either: an unauthenticated caller must not be able to add an org
    // sibling to this event's roster by typing their address.
    const { devLink } = await requestMagicLink(c, { email, event: ctx.event, redirectTo });
    return c.json({ ok: true, status: 'existing', dev_link: devLink });
  }

  // A contact that belongs to no event is a person who appears on no roster,
  // so creation and attachment are always one unit (contract). 'cfp' records
  // how they arrived; seeding is a no-op for an identity this new.
  await createDb(db).contacts.attachToEvent(ctx.event.id, inserted.id, 'cfp');

  // Brand-new contact: no event_users row exists yet, so the session's role
  // resolves to the same 'speaker' default the portal already applies.
  const sessionToken = await createSessionToken(
    { contactId: inserted.id, eventId: ctx.event.id, eventSlug: ctx.event.slug, email, role: 'speaker' },
    c.env.SESSION_SECRET,
  );
  setSessionCookie(c, sessionToken);

  // Best-effort magic link for a return visit — must never block or fail
  // the response the wizard is waiting on.
  try {
    const { raw, statement } = await mintToken(db, {
      contactId: inserted.id,
      eventId: ctx.event.id,
      purpose: 'portal-login',
      redirectTo,
    });
    await statement.run();
    await sendTemplated(c, {
      templateKey: 'magic_link',
      eventId: ctx.event.id,
      contactId: inserted.id,
      toEmail: email,
      entityId: await sha256hex(raw),
      context: { event: { name: ctx.event.name }, magic_link: `${c.env.APP_URL}/auth/callback?t=${raw}` },
    });
  } catch (err) {
    console.error('best-effort magic link on account creation failed:', err instanceof Error ? err.message : err);
  }

  return c.json({ ok: true, status: 'created' });
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

  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const abstractQuestions = ctx.questions.filter((q) => q.section === 'abstract');
  const answers = discardHiddenAnswers(
    abstractQuestions,
    normaliseTrackAnswers(abstractQuestions, parseAnswers(body.answers)),
  );
  const ts = new Date().toISOString();

  // ABS defect (data loss): the wizard used to resume the submitter's most
  // recent draft with no say from them, so starting a genuinely new
  // submission silently overwrote an unrelated one under the same code.
  // `force_new` is the explicit "Start a new submission" choice on the
  // Account step — it skips the reuse-the-existing-draft lookup below even
  // when the form only allows a single open draft; the submission-limit
  // check further down (shared with every other create path) still applies,
  // so a submitter cannot use it to evade their quota.
  const forceNew = body.force_new === true;

  let submissionId = typeof body.submission_id === 'string' ? body.submission_id : null;
  if (submissionId) {
    const owned = await db
      .prepare(
        `SELECT id FROM submissions WHERE id = ? AND form_id = ? AND submitter_contact_id = ? AND status = 'draft'`,
      )
      .bind(submissionId, ctx.form.id, session.contactId)
      .first();
    if (!owned) submissionId = null;
  }
  if (!submissionId && !forceNew) {
    // Without multiple-drafts, an existing open draft is reused, not duplicated.
    if (ctx.form.allow_multiple_drafts !== 1) {
      const existing = await db
        .prepare(
          `SELECT id FROM submissions WHERE form_id = ? AND submitter_contact_id = ? AND status = 'draft'
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .bind(ctx.form.id, session.contactId)
        .first<{ id: string }>();
      if (existing) submissionId = existing.id;
    }
  }

  const columns = systemColumns(abstractQuestions, answers);
  const isCreate = submissionId === null;
  if (!submissionId) {
    if (ctx.limit !== null && (await countForLimit(db, ctx.form.id, session.contactId)) >= ctx.limit) {
      return c.json(limitReachedBody(), 409);
    }
    submissionId = crypto.randomUUID();
  }

  // Same fused quota-check + code-allocation as the submit path, so a draft
  // can never mint a duplicate SESS-n either.
  const head = isCreate
    ? db
        .prepare(
          `INSERT INTO submissions (id, event_id, form_id, code, kind, title, description, status,
             format, level, language, capacity, ceu_credits, client_session_id,
             submitter_contact_id, source, created_at, updated_at)
           SELECT ?1, ?2, ?3, ${nextSessionCodeSql('?2')}, ?4, ?5, ?6, 'draft',
                  ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'form', ?14, ?14
           WHERE (SELECT COUNT(*) FROM submissions q
                  WHERE q.form_id = ?3 AND q.submitter_contact_id = ?13 AND q.status != 'withdrawn') < ?15`,
        )
        .bind(
          submissionId,
          ctx.event.id,
          ctx.form.id,
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
          ctx.limit ?? NO_LIMIT,
        )
    : db
        .prepare(
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
        );

  const results = await db.batch([head, ...answerStatements(db, submissionId, storableAnswers(abstractQuestions, answers))]);
  if (isCreate && results[0]?.meta.changes === 0) {
    return c.json(limitReachedBody(), 409);
  }
  await bumpEventRevision(c.env, ctx.event.id);
  return c.json({ submission_id: submissionId });
});

// ---------------------------------------------------------------------------
// POST /submit/:slug/:formId/submit — the authoritative submit
// ---------------------------------------------------------------------------

/**
 * A submission an identical retry should resolve to instead of inserting a
 * second row. D1 has no schema slot for an idempotency key on submissions
 * (migrations are frozen), so the identity of a retry is its *content*:
 * same form, same submitter, same title and description, within the window.
 */
interface ReplayRow {
  id: string;
  code: string;
  evaluation_plan_id: string | null;
}

/** A double-click is sub-second; a retried request after a dropped response is
 *  seconds. Two minutes is generous for both and far short of "I deliberately
 *  submitted a second proposal with the same title". */
const REPLAY_WINDOW_MS = 2 * 60 * 1000;

/** SQL predicate shared by the pre-check and the in-batch guard, so the fast
 *  path and the race path can never disagree about what a duplicate is. */
const DUPLICATE_PREDICATE = `form_id = ?1 AND submitter_contact_id = ?2
     AND status NOT IN ('draft', 'withdrawn')
     AND title = ?3 AND description IS ?4 AND created_at > ?5`;

async function findRecentDuplicate(
  db: D1Database,
  formId: string,
  contactId: string,
  title: string,
  description: string | null,
  cutoffIso: string,
): Promise<ReplayRow | null> {
  return db
    .prepare(
      `SELECT id, code, evaluation_plan_id FROM submissions
       WHERE ${DUPLICATE_PREDICATE}
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(formId, contactId, title, description, cutoffIso)
    .first<ReplayRow>();
}

/** Identity columns a participant section can write onto its contact row. */
const IDENTITY_FIELD_KEYS = ['first_name', 'last_name', 'email', 'mobile_phone', 'biography'] as const;
type IdentityKey = (typeof IDENTITY_FIELD_KEYS)[number];

// F14/ABS-11: canonical vocabulary now lives in @kms/core (ALL_PARTICIPANT_ROLES),
// shared with the admin add-participant endpoint (routes/evaluation.ts).
const PARTICIPANT_ROLES = new Set<string>(ALL_PARTICIPANT_ROLES);

interface ParticipantInput {
  role: string;
  is_primary_contact: boolean;
  /** every configured participant answer, keyed by question id */
  answers: Answers;
  identity: Record<IdentityKey, string>;
}

const emptyIdentity = (): Record<IdentityKey, string> => ({
  first_name: '',
  last_name: '',
  email: '',
  mobile_phone: '',
  biography: '',
});

/**
 * Accept the frozen participant payload `{ role, is_primary_contact, answers }`
 * (answers keyed by question id) and, until FE-5 lands, the legacy flat shape
 * `{ email, first_name, … }` — the legacy fields are lifted onto the matching
 * participant questions so both shapes take the same validation path.
 */
function normaliseParticipants(raw: unknown, participantQuestions: QuestionDef[]): ParticipantInput[] {
  if (!Array.isArray(raw)) return [];
  const questionByFieldKey = new Map<string, QuestionDef>();
  for (const q of participantQuestions) {
    if (q.field_key && !questionByFieldKey.has(q.field_key)) questionByFieldKey.set(q.field_key, q);
  }
  const out: ParticipantInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Record<string, unknown>;
    const modern = p.answers !== null && typeof p.answers === 'object';
    const answers = modern ? parseAnswers(p.answers) : {};
    const identity = emptyIdentity();
    if (!modern) {
      for (const key of IDENTITY_FIELD_KEYS) {
        const value = typeof p[key] === 'string' ? (p[key] as string) : '';
        if (!value) continue;
        identity[key] = value;
        const q = questionByFieldKey.get(key);
        if (q) answers[q.id] = value;
      }
    }
    out.push({
      role: typeof p.role === 'string' && PARTICIPANT_ROLES.has(p.role) ? p.role : 'speaker',
      is_primary_contact: p.is_primary_contact === true,
      answers,
      identity,
    });
  }
  return out;
}

/** Pull the identity columns back out of a validated participant answer map. */
function identityFromAnswers(
  participantQuestions: QuestionDef[],
  answers: Answers,
  fallback: Record<IdentityKey, string>,
): Record<IdentityKey, string> {
  const identity = { ...fallback };
  for (const q of participantQuestions) {
    const key = q.field_key as IdentityKey | undefined;
    if (!key || !IDENTITY_FIELD_KEYS.includes(key)) continue;
    const value = answers[q.id];
    if (typeof value === 'string') identity[key] = value.trim();
  }
  identity.email = identity.email.toLowerCase();
  return identity;
}

/** `assign_track_ids` rides on the routing action object as an optional extra
 *  (RoutingActions is frozen); read it off the matched rules by hand. */
type MultiTrackActions = RoutingActions & { assign_track_ids?: unknown };

function routingTrackIds(config: RoutingConfig | null, routing: RoutingOutcome): string[] {
  const out: string[] = [];
  const collect = (actions: MultiTrackActions | undefined) => {
    const list = actions?.assign_track_ids;
    if (!Array.isArray(list)) return;
    for (const value of list) {
      if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value);
    }
  };
  for (const rule of config?.rules ?? []) {
    if (routing.applied_rule_ids.includes(rule.id)) collect(rule.then as MultiTrackActions);
  }
  if (routing.used_fallback) collect(config?.fallback as MultiTrackActions | undefined);
  return out;
}

function parseIdList(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

interface Recipient {
  id: string;
  email: string;
  name: string;
}

/** Notification recipients must be *this event's* people (item 14): configured
 *  admin notifies additionally need a staff role, routing notifies only need a
 *  contact row with an address. Cross-event ids are silently dropped — since
 *  0015 that scoping comes from the join (event_users for staff, event_contacts
 *  for the roster) rather than from a column on `contacts`. */
async function resolveRecipients(
  db: D1Database,
  eventId: string,
  adminIds: string[],
  routingIds: string[],
): Promise<Recipient[]> {
  const byId = new Map<string, Recipient>();
  const nameExpr = `TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))`;
  if (adminIds.length > 0) {
    const placeholders = adminIds.map(() => '?').join(', ');
    const { results } = await db
      .prepare(
        `SELECT c.id, c.email, ${nameExpr} AS name FROM contacts c
         JOIN event_users eu ON eu.contact_id = c.id AND eu.event_id = ?
         WHERE c.id IN (${placeholders})
           AND eu.role IN ('owner', 'admin', 'reviewer')
           AND c.email IS NOT NULL AND c.email != ''`,
      )
      .bind(eventId, ...adminIds)
      .all<Recipient>();
    for (const row of results) byId.set(row.id, row);
  }
  if (routingIds.length > 0) {
    const placeholders = routingIds.map(() => '?').join(', ');
    const { results } = await db
      .prepare(
        `SELECT c.id, c.email, ${nameExpr} AS name FROM contacts c
         JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
         WHERE c.id IN (${placeholders}) AND c.email IS NOT NULL AND c.email != ''`,
      )
      .bind(eventId, ...routingIds)
      .all<Recipient>();
    for (const row of results) byId.set(row.id, row);
  }
  return [...byId.values()];
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
  const participantQuestions = ctx.questions.filter((q) => q.section === 'participant');

  // -------------------------------------------------------------------------
  // 1. Validate and normalise the COMPLETE request. Nothing below this block
  //    reads the database for a decision the batch depends on.
  // -------------------------------------------------------------------------

  // Authoritative pass: hidden answers discarded, then required/max validated.
  const answers = discardHiddenAnswers(
    abstractQuestions,
    normaliseTrackAnswers(abstractQuestions, parseAnswers(body.answers)),
  );
  const validation = validateAnswers(abstractQuestions, answers);
  if (validation.length > 0) {
    return c.json({ error: 'validation_failed', errors: validation }, 400);
  }

  // Same shape as the wizard prefill: identity org-wide, biography from this
  // event's profile row, LEFT JOIN so a missing membership row is a missing
  // bio rather than a failed authentication.
  const submitterContact = await db
    .prepare(
      `SELECT c.email, c.first_name, c.last_name, c.mobile_phone, ec.biography
         FROM contacts c
         LEFT JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
        WHERE c.id = ?`,
    )
    .bind(ctx.event.id, session.contactId)
    .first<{ email: string; first_name: string | null; last_name: string | null; mobile_phone: string | null; biography: string | null }>();
  if (!submitterContact) return c.json({ error: 'unauthenticated' }, 401);

  // Participants: the signed-in submitter is always participant 1 / primary.
  let participants = normaliseParticipants(body.participants, participantQuestions);
  if (ctx.form.collect_participants === 1) {
    if (participants.length > MAX_PARTICIPANTS_PER_SUBMISSION) {
      return c.json(
        { error: 'participants_invalid', detail: `at most ${MAX_PARTICIPANTS_PER_SUBMISSION} participants per submission` },
        400,
      );
    }

    // Per-participant conditional visibility + the shared validators, over the
    // configured participant questions (sweep item P1-7).
    const validated: ParticipantInput[] = [];
    for (const [index, p] of participants.entries()) {
      const kept = discardHiddenAnswers(participantQuestions, p.answers);
      const errors = validateAnswers(participantQuestions, kept);
      if (errors.length > 0) {
        return c.json(
          { error: 'validation_failed', errors: errors.map((e) => ({ ...e, participant_index: index })) },
          400,
        );
      }
      validated.push({ ...p, answers: kept, identity: identityFromAnswers(participantQuestions, kept, p.identity) });
    }
    participants = validated;

    const submitterIndex = participants.findIndex((p) => p.identity.email === submitterContact.email);
    if (submitterIndex > 0) {
      participants = [participants[submitterIndex]!, ...participants.filter((_, i) => i !== submitterIndex)];
    } else if (submitterIndex === -1) {
      const identity = emptyIdentity();
      identity.email = submitterContact.email;
      identity.first_name = submitterContact.first_name ?? '';
      identity.last_name = submitterContact.last_name ?? '';
      identity.mobile_phone = submitterContact.mobile_phone ?? '';
      identity.biography = submitterContact.biography ?? '';
      participants = [{ role: 'speaker', is_primary_contact: true, answers: {}, identity }, ...participants];
      if (participants.length > MAX_PARTICIPANTS_PER_SUBMISSION) {
        return c.json(
          { error: 'participants_invalid', detail: `at most ${MAX_PARTICIPANTS_PER_SUBMISSION} participants per submission` },
          400,
        );
      }
    }

    const roleConfig = parseParticipantRoles(ctx.form.participant_roles);
    const allowedRoles = new Set<string>(roleConfig.map((cfg) => cfg.role));
    const seenEmails = new Set<string>();
    for (const p of participants) {
      const { email, first_name, last_name, biography } = p.identity;
      if (!isValidEmailShape(email)) {
        return c.json({ error: 'participants_invalid', detail: 'every participant needs a valid email' }, 400);
      }
      if (seenEmails.has(email)) {
        return c.json({ error: 'participants_invalid', detail: `duplicate participant ${email}` }, 400);
      }
      seenEmails.add(email);
      if (!first_name || !last_name) {
        return c.json({ error: 'participants_invalid', detail: 'first and last name are required' }, 400);
      }
      if (first_name.length > 255 || last_name.length > 255 || biography.length > 5000) {
        return c.json({ error: 'participants_invalid', detail: 'participant profile exceeds its character limit' }, 400);
      }
      if (!allowedRoles.has(p.role)) {
        return c.json({ error: 'participants_invalid', detail: `role ${p.role} is not enabled for this form` }, 400);
      }
    }
    for (const cfg of roleConfig) {
      const count = participants.filter((p) => p.role === cfg.role).length;
      if (count < cfg.min) return c.json({ error: 'participants_invalid', detail: `at least ${cfg.min} ${cfg.role}` }, 400);
      if (cfg.max !== null && count > cfg.max) {
        return c.json({ error: 'participants_invalid', detail: `at most ${cfg.max} ${cfg.role}` }, 400);
      }
    }
  } else {
    participants = [];
  }

  // System columns are needed early: they are what a content-identical retry
  // is matched on.
  const columns = systemColumns(abstractQuestions, answers);
  const title = (columns.title as string) ?? 'Untitled';

  // Draft being promoted, if any (it does not count against the limit).
  // A retry of the *same* promote arrives with the same submission_id but the
  // draft is no longer a draft — that is a replay, not a second submission
  // (sweep acceptance: "an identical retry returns the same logical result
  // without a duplicate email").
  let submissionId = typeof body.submission_id === 'string' ? body.submission_id : null;
  let replayOf: ReplayRow | null = null;
  if (submissionId) {
    const owned = await db
      .prepare(
        `SELECT id, code, status, evaluation_plan_id FROM submissions
         WHERE id = ? AND form_id = ? AND submitter_contact_id = ?`,
      )
      .bind(submissionId, ctx.form.id, session.contactId)
      .first<ReplayRow & { status: string }>();
    if (!owned || owned.status === 'withdrawn') submissionId = null;
    else if (owned.status !== 'draft') {
      replayOf = { id: owned.id, code: owned.code, evaluation_plan_id: owned.evaluation_plan_id };
      submissionId = null;
    }
  }
  const isCreate = submissionId === null && replayOf === null;
  // Only the submitter's own draft reaches the update path here, and promoting
  // a draft is the submission's *first* appearance to organisers — so it
  // notifies as a create even though the row already existed. (Edits after
  // acceptance come through the portal's own route.)
  const notifyAsCreate = isCreate || submissionId !== null;

  // Retries that lost their submission_id (a dropped response, a double-click
  // on a fresh form) are caught by content: same form, same submitter, same
  // title and description, inside a short window. Different content always
  // means a different submission.
  const dupCutoff = new Date(Date.now() - REPLAY_WINDOW_MS).toISOString();
  const dupDescription = (columns.description as string) ?? null;
  if (isCreate) {
    replayOf = await findRecentDuplicate(db, ctx.form.id, session.contactId, title, dupDescription, dupCutoff);
  }

  // Friendly pre-check; the batch re-checks the same predicate atomically so a
  // racing request cannot squeeze past it.
  if (isCreate && replayOf === null && ctx.limit !== null) {
    if ((await countForLimit(db, ctx.form.id, session.contactId)) >= ctx.limit) {
      return c.json(limitReachedBody(), 409);
    }
  }

  // Routing (docs/04 §4) — answers keyed by question id.
  let routingConfig: RoutingConfig | null = null;
  try {
    routingConfig = ctx.form.routing_rules ? (JSON.parse(ctx.form.routing_rules) as RoutingConfig) : null;
  } catch {
    routingConfig = null;
  }
  // Routing (and the visibility rules the builder writes alongside it) compares
  // against what a submitter *saw*, not the wire value: a derived Track option
  // submits a track id, but every rule — including those authored before the
  // options were derived — names the track. `storableAnswers` is the same
  // label view the answers are persisted as, so a rule matches the same text
  // the organiser will later read on the submission.
  const routing = applyRouting(routingConfig, storableAnswers(abstractQuestions, answers));

  // A replay resolves to the row that already exists — same code, same portal
  // link, no second email (the confirmation is keyed on the submission id, so
  // even a re-render would be a duplicate in message_log).
  const replayResponse = (row: ReplayRow) =>
    c.json({
      ok: true,
      code: row.code,
      submission_id: row.id,
      portal_url: `/portal/${ctx.event.slug}`,
      auto_redirect: ctx.form.auto_redirect_to_portal === 1,
      success_message: sanitizeRichHtml(ctx.form.success_message),
      replayed: true,
      routing: {
        evaluation_plan_id: row.evaluation_plan_id,
        applied_rule_ids: routing.applied_rule_ids,
        used_fallback: routing.used_fallback,
      },
    });
  if (replayOf) return replayResponse(replayOf);

  // Resolve configured references inside this event. Routing JSON is editable
  // input, so foreign tenant IDs must not be allowed to cross-link records.
  const trackCandidates: string[] = [];
  const pushCandidate = (id: string | undefined) => {
    if (id && !trackCandidates.includes(id)) trackCandidates.push(id);
  };
  pushCandidate(routing.set_track_id);
  for (const id of routingTrackIds(routingConfig, routing)) pushCandidate(id);

  const resolvedTrackIds: string[] = [];
  if (trackCandidates.length > 0) {
    const placeholders = trackCandidates.map(() => '?').join(', ');
    const { results } = await db
      .prepare(`SELECT id FROM tracks WHERE event_id = ? AND id IN (${placeholders})`)
      .bind(ctx.event.id, ...trackCandidates)
      .all<{ id: string }>();
    const valid = new Set(results.map((r) => r.id));
    for (const id of trackCandidates) if (valid.has(id) && !resolvedTrackIds.includes(id)) resolvedTrackIds.push(id);
  }
  // A multiselect track question resolves EVERY selected value, not just one.
  const trackNames = trackAnswers(abstractQuestions, answers);
  // The canonical Track question's options are the event's tracks keyed by id
  // (loadQuestions), so its submitted values resolve by identity — no string
  // comparison, and immune to a rename between render and submit. The name
  // match below still runs for label-built "Track" questions and for answers
  // captured before options were derived.
  const trackPicks = trackAnswerValues(abstractQuestions, answers);
  if (trackNames.length > 0 || trackPicks.length > 0) {
    // Matched loosely (trimmed, case-insensitive) rather than by exact SQL
    // equality: the name a submitter picked can carry incidental whitespace
    // (a trailing space on an organizer-typed option) or case drift from the
    // track's canonical name without being a *different* track in any way
    // that matters — an exact-match lookup silently resolved those to no
    // track at all, same failure mode field_key === 'track' hit before the
    // label fallback (see trackAnswers above). Tracks per event number in
    // the tens at most, so fetching them all and matching in JS costs
    // nothing an IN-list lookup wouldn't already pay for.
    const { results } = await db
      .prepare(`SELECT id, name FROM tracks WHERE event_id = ?`)
      .bind(ctx.event.id)
      .all<{ id: string; name: string }>();
    const normalize = (s: string) => s.trim().toLowerCase();
    const byName = new Map(results.map((r) => [normalize(r.name), r.id]));
    const byId = new Set(results.map((r) => r.id));
    for (const raw of trackPicks) {
      if (byId.has(raw) && !resolvedTrackIds.includes(raw)) resolvedTrackIds.push(raw);
    }
    for (const name of trackNames) {
      const id = byName.get(normalize(name));
      if (id && !resolvedTrackIds.includes(id)) resolvedTrackIds.push(id);
    }
  }
  const routedTrackId = routing.set_track_id && resolvedTrackIds.includes(routing.set_track_id)
    ? routing.set_track_id
    : null;

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
  const status = routing.set_status && routableStatuses.has(routing.set_status) ? routing.set_status : 'pending';

  // Existing row state the update path needs (primary track is sticky).
  let existing: { code: string; track_id: string | null } | null = null;
  if (submissionId) {
    existing = await db
      .prepare('SELECT code, track_id FROM submissions WHERE id = ? AND event_id = ?')
      .bind(submissionId, ctx.event.id)
      .first<{ code: string; track_id: string | null }>();
  }
  // Primary-track semantics: an explicit routing set_track_id always wins,
  // then what THIS submission actually answered, and only then the row's
  // existing track.
  //
  // CFP defect (live-reproduced 2026-08-11): the previous order put
  // `existing?.track_id` ahead of the answer, described as "primary track is
  // sticky". That is wrong for the ordinary flow. The wizard's autosave
  // creates (or, without allow_multiple_drafts, *reuses*) a draft row, and the
  // draft path never writes track_id — so by the time Submit runs, `existing`
  // is whatever that row already carried. Reusing a seeded/older draft whose
  // track was "Agents" therefore pinned every subsequent submission to
  // "Agents" no matter which track the submitter picked, and re-submitting an
  // edited submission could never change its track at all. The submitter's own
  // answer is the authority; the existing value survives only when this
  // request resolved no track (an update that didn't touch the track question,
  // or a form with no track field), which is what "sticky" was meant to
  // protect.
  const primaryTrackId = routedTrackId ?? resolvedTrackIds[0] ?? existing?.track_id ?? null;
  const primaryTrackName = primaryTrackId
    ? (
        await db
          .prepare('SELECT name FROM tracks WHERE id = ? AND event_id = ?')
          .bind(primaryTrackId, ctx.event.id)
          .first<{ name: string }>()
      )?.name ?? null
    : null;

  const notifyIds = parseIdList(
    notifyAsCreate ? ctx.form.notify_admins_on_create : ctx.form.notify_admins_on_update,
  );
  const recipients = await resolveRecipients(db, ctx.event.id, notifyIds, routing.notify_contact_ids);
  const submitterName =
    `${submitterContact.first_name ?? ''} ${submitterContact.last_name ?? ''}`.trim() || submitterContact.email;

  // -------------------------------------------------------------------------
  // 2. Build the batch. Everything below is prepared, nothing is executed.
  // -------------------------------------------------------------------------

  const newId = submissionId ?? crypto.randomUUID();

  const buildBatch = async (
    code: string,
  ): Promise<{ statements: D1PreparedStatement[]; emails: PreparedEmail[] }> => {
    const ts = new Date().toISOString();
    const statements: D1PreparedStatement[] = [];
    const emails: PreparedEmail[] = [];

    if (isCreate) {
      // The one statement that decides whether this submission exists: the
      // quota check, the code allocation and the insert are a single
      // expression, so no concurrent create can interleave between them
      // (D1 is a single writer; UNIQUE (event_id, code) is the backstop).
      statements.push(
        db
          .prepare(
            `INSERT INTO submissions (id, event_id, form_id, code, kind, title, description, status,
               format, level, language, capacity, ceu_credits, client_session_id, track_id,
               evaluation_plan_id, submitter_contact_id, source, created_at, updated_at)
             SELECT ?1, ?2, ?3, ${nextSessionCodeSql('?2')}, ?4, ?5, ?6, ?7,
                    ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'form', ?17, ?17
             WHERE (SELECT COUNT(*) FROM submissions q
                    WHERE q.form_id = ?3 AND q.submitter_contact_id = ?16 AND q.status != 'withdrawn') < ?18
               AND ${nextSessionCodeSql('?2')} = ?19
               AND NOT EXISTS (SELECT 1 FROM submissions d
                               WHERE d.form_id = ?3 AND d.submitter_contact_id = ?16
                                 AND d.status NOT IN ('draft', 'withdrawn')
                                 AND d.title = ?5 AND d.description IS ?6 AND d.created_at > ?20)`,
          )
          .bind(
            newId,
            ctx.event.id,
            ctx.form.id,
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
            primaryTrackId,
            evaluationPlanId,
            session.contactId,
            ts,
            ctx.limit ?? NO_LIMIT,
            code,
            dupCutoff,
          ),
      );
    } else {
      statements.push(
        db
          .prepare(
            `UPDATE submissions SET title = ?2, description = ?3, status = ?4, format = ?5, level = ?6,
               language = ?7, capacity = ?8, ceu_credits = ?9, client_session_id = ?10, track_id = ?11,
               evaluation_plan_id = ?12, updated_at = ?13
             WHERE id = ?1 AND event_id = ?14`,
          )
          .bind(
            newId,
            title,
            (columns.description as string) ?? null,
            status,
            (columns.format as string) ?? null,
            (columns.level as string) ?? null,
            (columns.language as string) ?? null,
            (columns.capacity as number) ?? null,
            (columns.ceu_credits as number) ?? null,
            (columns.client_session_id as string) ?? null,
            primaryTrackId,
            evaluationPlanId,
            ts,
            ctx.event.id,
          ),
      );
    }

    statements.push(...answerStatements(db, newId, storableAnswers(abstractQuestions, answers)));

    // Tags
    statements.push(db.prepare('DELETE FROM submission_tags WHERE submission_id = ?').bind(newId));
    for (const tagId of tagIds) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO submission_tags (submission_id, tag_id)
             SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ?1)`,
          )
          .bind(newId, tagId),
      );
    }

    // Multi-track join (authoritative set; submissions.track_id stays primary).
    statements.push(db.prepare('DELETE FROM submission_tracks WHERE submission_id = ?').bind(newId));
    const trackSet = primaryTrackId ? [primaryTrackId, ...resolvedTrackIds] : resolvedTrackIds;
    for (const trackId of new Set(trackSet)) {
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO submission_tracks (submission_id, track_id)
             SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ?1)`,
          )
          .bind(newId, trackId),
      );
    }

    // Participants: contacts are upserted *inside* the transaction, then the
    // participant rows resolve their contact ids from the same batch.
    statements.push(db.prepare('DELETE FROM submission_participants WHERE submission_id = ?').bind(newId));
    let position = 1;
    for (const p of participants) {
      const own = p.identity.email === submitterContact.email;
      const orNull = (v: string) => (v === '' ? null : v);
      // A submitter may initialise a new co-speaker record, but must not
      // overwrite another existing speaker's self-managed profile by knowing
      // only their email address — hence the two COALESCE orders. Since 0015
      // the same rule has to hold across two tables: identity on `contacts`,
      // biography on this event's `event_contacts` row.
      const identityMerge = own
        ? `first_name = COALESCE(excluded.first_name, contacts.first_name),
           last_name = COALESCE(excluded.last_name, contacts.last_name),
           mobile_phone = COALESCE(excluded.mobile_phone, contacts.mobile_phone)`
        : `first_name = COALESCE(contacts.first_name, excluded.first_name),
           last_name = COALESCE(contacts.last_name, excluded.last_name),
           mobile_phone = COALESCE(contacts.mobile_phone, excluded.mobile_phone)`;
      // Same rule, applied twice: `seedBio` orders the typed biography against
      // the profile carried over from another event in the org, `bioMerge`
      // orders it against the one already stored for THIS event.
      const seedBio = own ? 'COALESCE(?3, prev.biography)' : 'COALESCE(prev.biography, ?3)';
      const bioMerge = own ? 'COALESCE(?3, biography)' : 'COALESCE(biography, ?3)';
      statements.push(
        db
          .prepare(
            `INSERT INTO contacts (id, org_id, email, first_name, last_name, mobile_phone, created_at, updated_at)
             VALUES (?1, (SELECT org_id FROM events WHERE id = ?2), ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT (org_id, lower(email)) DO UPDATE SET ${identityMerge}, updated_at = ?7`,
          )
          .bind(
            crypto.randomUUID(),
            ctx.event.id,
            p.identity.email,
            orNull(p.identity.first_name),
            orNull(p.identity.last_name),
            orNull(p.identity.mobile_phone),
            ts,
          ),
      );
      // Attach-and-seed, the SQL twin of db.contacts.attachToEvent (the helper
      // itself cannot be called here — every write in this endpoint is one
      // batch). A speaker returning from another event in the org is matched
      // by the statement above and picks their newest profile up here rather
      // than starting blank; the headshot is never seeded, it is an
      // event-scoped asset. `prev` excludes this event so the seed can never
      // read back the row being written.
      //
      // DO NOTHING, not DO UPDATE: the merge below has to compare the typed
      // biography against the stored one, and a seeded `excluded` would let
      // another event's bio win that comparison.
      statements.push(
        db
          .prepare(
            `INSERT INTO event_contacts
               (event_id, contact_id, biography, company, job_title, added_at, source)
             SELECT ?1, c.id, ${seedBio}, prev.company, prev.job_title, ?4, 'cfp'
               FROM contacts c
               JOIN events ev ON ev.id = ?1
               LEFT JOIN event_contacts prev
                 ON prev.contact_id = c.id
                AND prev.event_id = (SELECT p2.event_id FROM event_contacts p2
                                       JOIN events pe ON pe.id = p2.event_id
                                      WHERE p2.contact_id = c.id
                                        AND p2.event_id <> ?1
                                        AND pe.org_id = ev.org_id
                                      ORDER BY p2.added_at DESC LIMIT 1)
              WHERE c.org_id = ev.org_id AND lower(c.email) = ?2
             ON CONFLICT (event_id, contact_id) DO NOTHING`,
          )
          .bind(ctx.event.id, p.identity.email, orNull(p.identity.biography), ts),
      );
      // The profile half of the same two-COALESCE rule. The row is guaranteed
      // to exist by the statement above, so this is an UPDATE rather than a
      // second upsert.
      statements.push(
        db
          .prepare(
            `UPDATE event_contacts SET biography = ${bioMerge}
              WHERE event_id = ?1
                AND contact_id = (SELECT c.id FROM contacts c
                                   WHERE c.org_id = (SELECT org_id FROM events WHERE id = ?1)
                                     AND lower(c.email) = ?2)`,
          )
          .bind(ctx.event.id, p.identity.email, orNull(p.identity.biography)),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO submission_participants
               (id, submission_id, contact_id, role, position, is_primary_contact, confirmed_at, answers_json,
                title_at_time, org_at_time)
             SELECT ?1, ?2, c.id, ?3, ?4, ?5, ?6, ?7, ec.job_title, ec.company FROM contacts c
             JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?8
             WHERE c.org_id = (SELECT org_id FROM events WHERE id = ?8)
               AND lower(c.email) = ?9
               AND EXISTS (SELECT 1 FROM submissions s WHERE s.id = ?2)`,
          )
          .bind(
            crypto.randomUUID(),
            newId,
            p.role,
            position,
            own ? 1 : 0,
            own ? ts : null,
            JSON.stringify(p.answers),
            ctx.event.id,
            p.identity.email,
          ),
      );
      position += 1;
    }
    if (ctx.form.collect_participants !== 1) {
      // No participant list to attach anyone from, so the submitter's own
      // membership is asserted here: submitting to an event is exactly what
      // puts you on its roster, and a submission whose speaker has no
      // event_contacts row would be invisible to every roster-shaped query.
      statements.push(
        db
          .prepare(
            `INSERT INTO event_contacts (event_id, contact_id, added_at, source)
             VALUES (?1, ?2, ?3, 'cfp')
             ON CONFLICT (event_id, contact_id) DO NOTHING`,
          )
          .bind(ctx.event.id, session.contactId, ts),
      );
      // Still record the submitter as the speaker so the anchor filter works.
      statements.push(
        db
          .prepare(
            `INSERT INTO submission_participants
               (id, submission_id, contact_id, role, position, is_primary_contact, confirmed_at,
                title_at_time, org_at_time)
             SELECT ?1, ?2, ?3, 'speaker', 1, 1, ?4,
               (SELECT ec.job_title FROM event_contacts ec WHERE ec.contact_id = ?3 AND ec.event_id = ?5),
               (SELECT ec.company FROM event_contacts ec WHERE ec.contact_id = ?3 AND ec.event_id = ?5)
             WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ?2)`,
          )
          .bind(crypto.randomUUID(), newId, session.contactId, ts, ctx.event.id),
      );
    }

    // Confirmation email (must-have, docs/04 §2.6). Its {{portal_url}} is a
    // purpose-bound single-use magic link minted in the same transaction
    // (sweep item P0-3), so opening it in a fresh browser authenticates.
    // Version stays 1 so a double-submit cannot double-send.
    if (ctx.form.confirmation_email_enabled === 1) {
      const minted = await mintToken(db, {
        contactId: session.contactId,
        eventId: ctx.event.id,
        purpose: 'submission-confirm',
        ttlSeconds: CONFIRM_TTL_SECONDS,
        redirectTo: `/portal/${ctx.event.slug}`,
      });
      const prepared = await prepareTemplated(db, {
        templateKey: 'submission_confirmation',
        eventId: ctx.event.id,
        contactId: session.contactId,
        toEmail: submitterContact.email,
        entityId: newId,
        version: 1,
        context: {
          event: { name: ctx.event.name },
          submission: { title, code },
          portal_url: `${c.env.APP_URL}/auth/callback?t=${minted.raw}`,
        },
      });
      if (prepared) {
        statements.push(minted.statement, ...prepared.statements);
        emails.push(prepared);
      }
    }

    // Admin notifications (item 14). Create notifies once per submission;
    // each edit renotifies once, keyed on the new updated_at.
    if (recipients.length > 0) {
      const templateKey = notifyAsCreate ? 'submission_received_admin' : 'submission_updated_admin';
      const version = notifyAsCreate ? 1 : ts;
      for (const recipient of recipients) {
        const prepared = await prepareTemplated(db, {
          templateKey,
          eventId: ctx.event.id,
          contactId: recipient.id,
          toEmail: recipient.email,
          entityId: newId,
          version,
          context: {
            event: { name: ctx.event.name },
            submission: { title, code, track_line: primaryTrackName ? ` — ${primaryTrackName}` : '' },
            submitter: { name: submitterName, email: submitterContact.email },
            admin_url: `${c.env.APP_URL}/app?v=workspace&tab=submissions&rec=${newId}`,
          },
        });
        if (prepared) {
          statements.push(...prepared.statements);
          emails.push(prepared);
        }
      }
    }

    return { statements, emails };
  };

  // -------------------------------------------------------------------------
  // 3. Commit. One batch per attempt, with defensive retries on the code
  //    backstop; a rolled-back attempt leaves no token or email behind.
  // -------------------------------------------------------------------------

  let code = existing?.code ?? (await peekNextSessionCode(db, ctx.event.id));
  let emails: PreparedEmail[] = [];
  let committed = false;
  // The confirmation email quotes the code, so the code has to be known before
  // the batch is built; the batch re-asserts the allocator still agrees. A
  // racing create invalidates that assertion rather than mis-stating the code,
  // and we simply rebuild — a handful of attempts covers any realistic burst.
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !committed; attempt += 1) {
    const built = await buildBatch(code);
    let results: D1Result[] | null = null;
    try {
      results = await db.batch(built.statements);
    } catch (err) {
      if (!isCreate || !isSubmissionCodeCollision(err)) throw err;
    }
    if (results && (!isCreate || results[0]?.meta.changes !== 0)) {
      emails = built.emails;
      committed = true;
      break;
    }
    // Nothing was written. Either a racing twin of this request already
    // created the row, the quota closed underneath us, or another create took
    // the code this batch reserved — re-read and try again.
    if (isCreate) {
      const dup = await findRecentDuplicate(db, ctx.form.id, session.contactId, title, dupDescription, dupCutoff);
      if (dup) return replayResponse(dup);
    }
    if (isCreate && ctx.limit !== null && (await countForLimit(db, ctx.form.id, session.contactId)) >= ctx.limit) {
      return c.json(limitReachedBody(), 409);
    }
    code = await peekNextSessionCode(db, ctx.event.id);
  }
  if (!committed) {
    return c.json({ error: 'conflict', detail: 'submission could not be allocated a code — please retry' }, 409);
  }

  submissionId = newId;
  await bumpEventRevision(c.env, ctx.event.id);
  // Enqueue-after-commit: the rows are durable, now try the provider once.
  for (const prepared of emails) await attemptImmediate(c, prepared);

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
