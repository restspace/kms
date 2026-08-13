// Speaker sourcing pipeline (spec-gap CRM-07/08) — the org-wide kanban board
// that tracks prospects from research through confirmed/declined. Mounted at
// /app/api/crm inside the admin guard; every route is writer-only for the
// same reason GET /dashboard/org is: an org-wide sourcing surface is a
// writer's tool, and a reviewer seat has no business on it.
//
// Stage history is written HERE, not trusted from the client: any stage
// change through PATCH records a pipeline_activity row, so drag-and-drop and
// the Move-to menu produce identical timelines (CRM-08's timestamped record).

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createDb } from '@kms/db';
import type { AccessEnv } from '../access';
import { isWriter, requireEventAccess } from '../access';
import { bumpEventRevision } from '../revision';
import { loadAuthorName } from '../submissionComments';

type ApiEnv = AccessEnv;

/** Fixed stage vocabulary, board order. Open stages first, terminals last —
 * the spec's expected lifecycle (CRM-07: open-to-won/lost). */
export const PIPELINE_STAGES = [
  'identified',
  'researching',
  'contacted',
  'interested',
  'confirmed',
  'declined',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

const isStage = (v: unknown): v is PipelineStage =>
  typeof v === 'string' && (PIPELINE_STAGES as readonly string[]).includes(v);

const MAX_NOTE_CHARS = 2000;
const MAX_RATIONALE_CHARS = 1000;

export const crmRoutes = new Hono<ApiEnv>();

crmRoutes.use('*', async (c, next) => {
  if (!isWriter(c.get('session').role)) return c.json({ error: 'forbidden' }, 403);
  await next();
});

/** The organisation owning the session's event — cards are org rows. */
async function orgId(c: Context<ApiEnv>): Promise<string | null> {
  const row = await c.env.DB.prepare('SELECT org_id FROM events WHERE id = ?')
    .bind(c.get('session').eventId)
    .first<{ org_id: string }>();
  return row?.org_id ?? null;
}

interface CardRow {
  id: string;
  contact_id: string;
  stage: PipelineStage;
  score: number | null;
  rationale: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  company: string | null;
  job_title: string | null;
}

// Company/job title live on event_contacts (0015); each card shows the
// contact's most recent non-blank membership value — the same "latest
// membership by added_at" rule the org directory and org dashboard use.
const CARD_SELECT = `
  SELECT pc.id, pc.contact_id, pc.stage, pc.score, pc.rationale, pc.position,
         pc.created_at, pc.updated_at,
         c.first_name, c.last_name, c.email,
         (SELECT ec.company FROM event_contacts ec
            JOIN events e ON e.id = ec.event_id
           WHERE ec.contact_id = c.id AND e.org_id = c.org_id
             AND ec.company IS NOT NULL AND TRIM(ec.company) != ''
           ORDER BY ec.added_at DESC LIMIT 1) AS company,
         (SELECT ec.job_title FROM event_contacts ec
            JOIN events e ON e.id = ec.event_id
           WHERE ec.contact_id = c.id AND e.org_id = c.org_id
             AND ec.job_title IS NOT NULL AND TRIM(ec.job_title) != ''
           ORDER BY ec.added_at DESC LIMIT 1) AS job_title
    FROM pipeline_cards pc
    JOIN contacts c ON c.id = pc.contact_id`;

async function loadCard(db: D1Database, org: string, id: string): Promise<CardRow | null> {
  return db
    .prepare(`${CARD_SELECT} WHERE pc.org_id = ? AND pc.id = ?`)
    .bind(org, id)
    .first<CardRow>();
}

async function logActivity(
  c: Context<ApiEnv>,
  cardId: string,
  entry: { kind: 'enrolled' | 'stage_change' | 'note'; from_stage?: string; to_stage?: string; body?: string },
): Promise<Record<string, unknown>> {
  const session = c.get('session');
  const author = (await loadAuthorName(c.env.DB, session.contactId)) ?? session.email;
  const row = {
    id: crypto.randomUUID(),
    card_id: cardId,
    kind: entry.kind,
    from_stage: entry.from_stage ?? null,
    to_stage: entry.to_stage ?? null,
    body: entry.body ?? null,
    author_name: author,
    created_at: new Date().toISOString(),
  };
  await c.env.DB.prepare(
    `INSERT INTO pipeline_activity (id, card_id, kind, from_stage, to_stage, body, author_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(row.id, row.card_id, row.kind, row.from_stage, row.to_stage, row.body, row.author_name, row.created_at)
    .run();
  return row;
}

// GET /crm/pipeline — the whole board. Stages travel with the payload so the
// SPA renders columns from the server's vocabulary, not a copy of it.
crmRoutes.get('/pipeline', async (c) => {
  const org = await orgId(c);
  if (!org) return c.json({ error: 'not_found' }, 404);
  const { results } = await c.env.DB.prepare(
    `${CARD_SELECT} WHERE pc.org_id = ? ORDER BY pc.position, pc.created_at`,
  )
    .bind(org)
    .all<CardRow>();
  return c.json({ stages: PIPELINE_STAGES, cards: results });
});

// POST /crm/pipeline/cards { contact_id, stage?, score?, rationale? } — enroll
// a directory contact. One card per contact org-wide: re-enrolling answers 409
// with the existing card id so the UI can jump to it.
crmRoutes.post('/pipeline/cards', async (c) => {
  const org = await orgId(c);
  if (!org) return c.json({ error: 'not_found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const contactId = typeof body.contact_id === 'string' ? body.contact_id : '';
  if (!contactId) return c.json({ error: 'contact_required' }, 400);
  const stage = body.stage === undefined ? PIPELINE_STAGES[0] : body.stage;
  if (!isStage(stage)) return c.json({ error: 'invalid_stage' }, 400);
  let score: number | null = null;
  if (body.score !== undefined && body.score !== null && body.score !== '') {
    const n = Number(body.score);
    if (!Number.isInteger(n) || n < 0 || n > 100) return c.json({ error: 'invalid_score' }, 400);
    score = n;
  }
  const rationale =
    typeof body.rationale === 'string' && body.rationale.trim()
      ? body.rationale.trim().slice(0, MAX_RATIONALE_CHARS)
      : null;

  // Same guard as POST /contacts/:id/attach: another org's person (or a merge
  // tombstone, which the directory no longer lists) reads as absent.
  const contact = await c.env.DB.prepare(
    'SELECT id FROM contacts WHERE org_id = ? AND id = ? AND merged_into IS NULL',
  )
    .bind(org, contactId)
    .first();
  if (!contact) return c.json({ error: 'not_found' }, 404);

  const existing = await c.env.DB.prepare(
    'SELECT id FROM pipeline_cards WHERE org_id = ? AND contact_id = ?',
  )
    .bind(org, contactId)
    .first<{ id: string }>();
  if (existing) return c.json({ error: 'already_enrolled', existing_id: existing.id }, 409);

  const tail = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM pipeline_cards WHERE org_id = ? AND stage = ?',
  )
    .bind(org, stage)
    .first<{ next: number }>();

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO pipeline_cards (id, org_id, contact_id, stage, score, rationale, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, org, contactId, stage, score, rationale, tail?.next ?? 1, now, now)
    .run();
  await logActivity(c, id, { kind: 'enrolled', to_stage: stage });

  return c.json(await loadCard(c.env.DB, org, id), 201);
});

// POST /crm/pipeline/enroll-submissions { ids } — workplan 15 W4: the road
// into the board for the near-miss cohort. Scoped to the session's event like
// every other bulk action over submission ids (bulk-status, send-decisions).
//
// One card per person, not per talk (D8): the board is a people board, so a
// speaker who near-missed in two seasons is one card whose rationale reads as
// two lines — which is the true signal, a stronger lead. Enrolment therefore
// never moves a card that has already progressed past `identified`, and never
// lowers a score somebody already earned here.
crmRoutes.post('/pipeline/enroll-submissions', async (c) => {
  const org = await orgId(c);
  if (!org) return c.json({ error: 'not_found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === 'string').slice(0, 200)
    : [];
  if (ids.length === 0) return c.json({ error: 'ids_required' }, 400);

  const placeholders = ids.map(() => '?').join(', ');
  // `rating` is the submissions grid's normalised 1-5 expression verbatim
  // (adminApi.ts): the number the organiser was looking at when they picked
  // these rows has to be the number that rides onto the card. The speaker is
  // the primary contact, else the first listed participant — the same
  // "primary, falling back" rule the on-accept task owner uses. Season comes
  // off the event, not the clock: a batch decided in January belongs to the
  // event it declined for.
  const { results } = await c.env.DB.prepare(
    `SELECT s.id, s.code, s.title, s.status,
            (SELECT ROUND(AVG(plan_avg), 2) FROM (
               SELECT 1 + (AVG(r.weighted_total) - p.scoring_scale_min) * 4.0
                        / (p.scoring_scale_max - p.scoring_scale_min) AS plan_avg
               FROM reviews r JOIN evaluation_plans p ON p.id = r.plan_id
               WHERE r.submission_id = s.id AND r.weighted_total IS NOT NULL
               GROUP BY r.plan_id)) AS rating,
            (SELECT sp.contact_id FROM submission_participants sp
              WHERE sp.submission_id = s.id
              ORDER BY sp.is_primary_contact DESC, sp.position LIMIT 1) AS speaker_id,
            strftime('%Y', COALESCE(ev.starts_at, s.created_at)) AS season
       FROM submissions s
       JOIN events ev ON ev.id = s.event_id
      WHERE s.event_id = ? AND s.id IN (${placeholders})`,
  )
    .bind(c.get('session').eventId, ...ids)
    .all<{
      id: string; code: string; title: string; status: string;
      rating: number | null; speaker_id: string | null; season: string | null;
    }>();

  let created = 0;
  let updated = 0;
  let skippedNoSpeaker = 0;
  const now = new Date().toISOString();
  for (const row of results) {
    if (!row.speaker_id) {
      // A submission nobody is attached to has no person to enroll — the
      // caller is told rather than left to wonder why the count is short.
      skippedNoSpeaker += 1;
      continue;
    }
    // "SESS-104 — Evals in anger (rated 4.6, declined 2026)": code and title
    // so the card reads as a talk somebody remembers, rating and season so a
    // reader a year later knows how close it came.
    const outcome = row.status === 'decline_queue' ? 'declined' : row.status;
    const facts = [
      ...(row.rating === null ? [] : [`rated ${row.rating.toFixed(1)}`]),
      [outcome, row.season].filter(Boolean).join(' '),
    ].join(', ');
    const line = `${row.code} — ${row.title} (${facts})`;
    // 1-5 display scale onto the card's 0-100 prospect score: the floor of the
    // scale is the floor of the score, so a 1.0 reads as 0 rather than 20.
    const score = row.rating === null ? null : Math.max(0, Math.min(100, Math.round(((row.rating - 1) / 4) * 100)));

    const existing = await c.env.DB.prepare(
      'SELECT id, stage, score, rationale FROM pipeline_cards WHERE org_id = ? AND contact_id = ?',
    )
      .bind(org, row.speaker_id)
      .first<{ id: string; stage: PipelineStage; score: number | null; rationale: string | null }>();

    if (existing) {
      const rationale = (existing.rationale ? `${existing.rationale}\n${line}` : line).slice(
        0,
        MAX_RATIONALE_CHARS,
      );
      await c.env.DB.prepare(
        'UPDATE pipeline_cards SET score = ?, rationale = ?, updated_at = ? WHERE id = ?',
      )
        .bind(score === null ? existing.score : Math.max(score, existing.score ?? 0), rationale, now, existing.id)
        .run();
      await logActivity(c, existing.id, { kind: 'enrolled', to_stage: existing.stage });
      updated += 1;
      continue;
    }

    const tail = await c.env.DB.prepare(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM pipeline_cards WHERE org_id = ? AND stage = ?',
    )
      .bind(org, PIPELINE_STAGES[0])
      .first<{ next: number }>();
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO pipeline_cards (id, org_id, contact_id, stage, score, rationale, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, org, row.speaker_id, PIPELINE_STAGES[0], score, line.slice(0, MAX_RATIONALE_CHARS), tail?.next ?? 1, now, now)
      .run();
    // Same call the hand-enrolment path makes, so the timeline cannot tell a
    // routed card from one somebody typed in.
    await logActivity(c, id, { kind: 'enrolled', to_stage: PIPELINE_STAGES[0] });
    created += 1;
  }

  return c.json({
    ok: true,
    enrolled: created + updated,
    created,
    updated,
    skipped_no_speaker: skippedNoSpeaker,
  });
});

// GET /crm/pipeline/cards/:id — card detail: contact summary plus the full
// activity feed, newest first (CRM-08's notes + stage history in one list).
crmRoutes.get('/pipeline/cards/:id', async (c) => {
  const org = await orgId(c);
  if (!org) return c.json({ error: 'not_found' }, 404);
  const card = await loadCard(c.env.DB, org, c.req.param('id'));
  if (!card) return c.json({ error: 'not_found' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, from_stage, to_stage, body, author_name, created_at
       FROM pipeline_activity WHERE card_id = ?
      -- rowid breaks same-millisecond ties in true insertion order; UUID ids
      -- would shuffle two writes that share a timestamp.
      ORDER BY created_at DESC, rowid DESC`,
  )
    .bind(card.id)
    .all();
  return c.json({ ...card, activity: results });
});

// PATCH /crm/pipeline/cards/:id { stage?, position?, score?, rationale? } —
// move and edit. A stage change logs its transition; a same-stage reorder or
// a score/rationale edit does not.
crmRoutes.patch('/pipeline/cards/:id', async (c) => {
  const org = await orgId(c);
  if (!org) return c.json({ error: 'not_found' }, 404);
  const card = await loadCard(c.env.DB, org, c.req.param('id'));
  if (!card) return c.json({ error: 'not_found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  let stage = card.stage;
  if (body.stage !== undefined) {
    if (!isStage(body.stage)) return c.json({ error: 'invalid_stage' }, 400);
    stage = body.stage;
  }
  let score = card.score;
  if ('score' in body) {
    if (body.score === null || body.score === '') score = null;
    else {
      const n = Number(body.score);
      if (!Number.isInteger(n) || n < 0 || n > 100) return c.json({ error: 'invalid_score' }, 400);
      score = n;
    }
  }
  let rationale = card.rationale;
  if ('rationale' in body) {
    rationale =
      typeof body.rationale === 'string' && body.rationale.trim()
        ? body.rationale.trim().slice(0, MAX_RATIONALE_CHARS)
        : null;
  }

  let position = card.position;
  if (typeof body.position === 'number' && Number.isFinite(body.position)) {
    position = body.position;
  } else if (stage !== card.stage) {
    // Moved with no explicit slot → end of the target column.
    const tail = await c.env.DB.prepare(
      'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM pipeline_cards WHERE org_id = ? AND stage = ?',
    )
      .bind(org, stage)
      .first<{ next: number }>();
    position = tail?.next ?? 1;
  }

  await c.env.DB.prepare(
    'UPDATE pipeline_cards SET stage = ?, score = ?, rationale = ?, position = ?, updated_at = ? WHERE id = ?',
  )
    .bind(stage, score, rationale, position, new Date().toISOString(), card.id)
    .run();
  if (stage !== card.stage) {
    await logActivity(c, card.id, { kind: 'stage_change', from_stage: card.stage, to_stage: stage });
  }
  return c.json(await loadCard(c.env.DB, org, card.id));
});

// POST /crm/pipeline/cards/:id/notes { body } — internal note on the card.
crmRoutes.post('/pipeline/cards/:id/notes', async (c) => {
  const org = await orgId(c);
  if (!org) return c.json({ error: 'not_found' }, 404);
  const card = await loadCard(c.env.DB, org, c.req.param('id'));
  if (!card) return c.json({ error: 'not_found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) return c.json({ error: 'body_required' }, 400);
  if (text.length > MAX_NOTE_CHARS) return c.json({ error: 'body_too_long' }, 400);
  const row = await logActivity(c, card.id, { kind: 'note', body: text });
  return c.json(row, 201);
});

// DELETE /crm/pipeline/cards/:id — remove from the pipeline (activity rows
// cascade). The contact itself is untouched.
crmRoutes.delete('/pipeline/cards/:id', async (c) => {
  const org = await orgId(c);
  if (!org) return c.json({ error: 'not_found' }, 404);
  const res = await c.env.DB.prepare('DELETE FROM pipeline_cards WHERE org_id = ? AND id = ?')
    .bind(org, c.req.param('id'))
    .run();
  if (!res.meta.changes) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// POST /crm/pipeline/cards/:id/assign { event_id } — the CRM-10 handoff from
// a card: put the prospect on an event's roster without re-entry. Reuses the
// attach machinery (profile seeded from their most recent membership), guarded
// by a writer seat at the TARGET event, which need not be the session's.
crmRoutes.post('/pipeline/cards/:id/assign', async (c) => {
  const org = await orgId(c);
  if (!org) return c.json({ error: 'not_found' }, 404);
  const card = await loadCard(c.env.DB, org, c.req.param('id'));
  if (!card) return c.json({ error: 'not_found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const eventId = typeof body.event_id === 'string' ? body.event_id : '';
  if (!eventId) return c.json({ error: 'event_required' }, 400);
  const seat = await requireEventAccess(c, eventId);
  if (!seat || !isWriter(seat.role)) return c.json({ error: 'forbidden' }, 403);

  const already = await c.env.DB.prepare(
    'SELECT 1 AS ok FROM event_contacts WHERE event_id = ? AND contact_id = ?',
  )
    .bind(eventId, card.contact_id)
    .first();
  if (already) return c.json({ error: 'already_on_event' }, 409);

  await createDb(c.env.DB).contacts.attachToEvent(eventId, card.contact_id, 'admin');
  await bumpEventRevision(c.env, eventId);
  return c.json({ ok: true, event_id: eventId, contact_id: card.contact_id }, 201);
});
