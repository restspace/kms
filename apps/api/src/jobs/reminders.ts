// Reminder sweeps (docs/08 §4), run from the cron tick just before the
// outbox sweep so anything queued here is delivered in the same minute.
// Every send's idempotency key embeds the offset (or overdue day index), so
// a sweep can run as often as it likes without double-sending.
//
// Workplan-13 W4b (D5): the sweep is now a *detector*. The selects and the
// offset arithmetic below are unchanged, but the render step stages a
// chase_drafts row (chase.ts stageChase) whose idem_key is exactly the send
// key queueTemplated would have used. In the default chase_mode='auto' the
// same stageChase call sends the staged draft through queueTemplated in this
// pass — today's behaviour byte for byte, OVERDUE_CAP and idempotency
// included. In chase_mode='assisted' the draft waits for a human.

import { stageChase, type ChaseStageArgs } from '../chase';
import type { Env } from '../env';

const DAY_MS = 86_400_000;
/** Overdue nudges stop after this many, per assignment (docs/08 §4). */
const OVERDUE_CAP = 3;

interface TaskReminderRow {
  assignment_id: string;
  task_id: string;
  task_title: string;
  due_at: string;
  reminder_offsets_days: string | null;
  contact_id: string;
  email: string;
  first_name: string | null;
  event_id: string;
  event_name: string;
  event_slug: string;
  chase_mode: string | null;
}

interface MaterialsReminderRow {
  submission_id: string;
  code: string;
  title: string;
  materials_state_at: string;
  contact_id: string;
  email: string;
  first_name: string | null;
  event_id: string;
  event_name: string;
  event_slug: string;
  chase_mode: string | null;
}

interface DraftReminderRow {
  submission_id: string;
  form_id: string;
  form_name: string;
  close_at: string;
  contact_id: string;
  email: string;
  first_name: string | null;
  event_id: string;
  event_name: string;
  event_slug: string;
  chase_mode: string | null;
}

/**
 * Compose the task_reminder chase args from a row + the pre-computed due
 * line — shared by the scheduled sweep and the manual "remind now" trigger
 * so the two never drift in template/context shape. `version` is the caller's
 * idempotency segment: the sweep's offset/overdue-day key for the scheduled
 * path, a date-stamped "manual" key for the on-demand one.
 */
function composeTaskReminder(env: Env, row: TaskReminderRow, version: string, dueLine: string): ChaseStageArgs {
  return {
    templateKey: 'task_reminder',
    subjectOf: 'task',
    subjectId: row.assignment_id,
    version,
    eventId: row.event_id,
    contactId: row.contact_id,
    toEmail: row.email,
    chaseMode: row.chase_mode,
    context: {
      event: { name: row.event_name },
      speaker: { first_name: row.first_name ?? 'there' },
      task: {
        title: row.task_title,
        due_line: dueLine,
        url: `${env.APP_URL}/portal/${row.event_slug}/tasks`,
      },
    },
  };
}

export async function sweepReminders(env: Env): Promise<void> {
  const now = Date.now();
  await sweepTaskReminders(env, now);
  await sweepDraftReminders(env, now);
  await sweepMaterialsReminders(env, now);
}

async function sweepTaskReminders(env: Env, now: number): Promise<void> {
  // Incomplete assignments on tasks with a due date, speakers attached.
  const { results } = await env.DB.prepare(
    `SELECT ta.id AS assignment_id, t.id AS task_id, t.title AS task_title, t.due_at,
            t.reminder_offsets_days, c.id AS contact_id, c.email, c.first_name,
            e.id AS event_id, e.name AS event_name, e.slug AS event_slug, e.chase_mode
     FROM task_assignments ta
     JOIN tasks t ON t.id = ta.task_id
     JOIN contacts c ON c.id = ta.contact_id
     JOIN events e ON e.id = t.event_id
     WHERE ta.status != 'complete' AND t.due_at IS NOT NULL`,
  ).all<TaskReminderRow>();

  for (const row of results) {
    const due = new Date(row.due_at).getTime();
    if (Number.isNaN(due)) continue;

    let sendKey: string | null = null;
    let dueLine = '';
    if (now < due) {
      // Pre-due offsets: fire once each, as soon as the window opens.
      let offsets: number[] = [];
      try {
        offsets = row.reminder_offsets_days ? (JSON.parse(row.reminder_offsets_days) as number[]) : [];
      } catch { /* no offsets */ }
      const active = offsets
        .filter((d) => Number.isFinite(d) && now >= due - d * DAY_MS)
        .sort((a, b) => a - b)[0];
      if (active !== undefined) {
        sendKey = `off${active}`;
        const daysLeft = Math.ceil((due - now) / DAY_MS);
        dueLine = `, due in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
      }
    } else {
      // Overdue: one nudge per day, capped.
      const overdueDay = Math.floor((now - due) / DAY_MS);
      if (overdueDay < OVERDUE_CAP) {
        sendKey = `late${overdueDay}`;
        dueLine = ' — now overdue';
      }
    }
    if (!sendKey) continue;

    await stageChase(env.DB, composeTaskReminder(env, row, sendKey, dueLine));
  }
}

/**
 * On-demand counterpart to the scheduled sweep above (mirrors
 * evaluation.ts's `POST /evaluation/plans/:id/remind` for "Remind lagging"
 * reviewers, which deliverables reminders lacked an equivalent of). Sends the
 * task_reminder chase immediately for outstanding (not-complete) assignments,
 * optionally narrowed to one submission or one filtered set of assignment
 * ids — reusing `composeTaskReminder` so the manual send is byte-for-byte the
 * same template/context the sweep would have used, just staged under a
 * date-stamped "manual" idempotency key instead of the offset/overdue one.
 * That key is deliberately distinct from the sweep's: a manual nudge must not
 * dedupe against (or block) that day's scheduled reminder, and a second
 * manual click the same day is still a no-op rather than a re-send.
 */
export async function sendTaskReminderNow(
  env: Env,
  opts: { eventId: string; taskId?: string; submissionIds?: string[]; assignmentIds?: string[] },
): Promise<{ sent: number; assignment_ids: string[] }> {
  const filters: string[] = ['ta.status != \'complete\'', 't.event_id = ?'];
  const params: unknown[] = [opts.eventId];
  if (opts.taskId) {
    filters.push('ta.task_id = ?');
    params.push(opts.taskId);
  }
  if (opts.submissionIds && opts.submissionIds.length > 0) {
    filters.push(`ta.submission_id IN (${opts.submissionIds.map(() => '?').join(', ')})`);
    params.push(...opts.submissionIds);
  }
  if (opts.assignmentIds && opts.assignmentIds.length > 0) {
    filters.push(`ta.id IN (${opts.assignmentIds.map(() => '?').join(', ')})`);
    params.push(...opts.assignmentIds);
  }
  const { results } = await env.DB.prepare(
    `SELECT ta.id AS assignment_id, t.id AS task_id, t.title AS task_title, t.due_at,
            t.reminder_offsets_days, c.id AS contact_id, c.email, c.first_name,
            e.id AS event_id, e.name AS event_name, e.slug AS event_slug, e.chase_mode
     FROM task_assignments ta
     JOIN tasks t ON t.id = ta.task_id
     JOIN contacts c ON c.id = ta.contact_id
     JOIN events e ON e.id = t.event_id
     WHERE ${filters.join(' AND ')}`,
  )
    .bind(...params)
    .all<TaskReminderRow>();

  const day = new Date().toISOString().slice(0, 10);
  const sent: string[] = [];
  for (const row of results) {
    if (!row.email) continue;
    let dueLine = '';
    if (row.due_at) {
      const due = new Date(row.due_at).getTime();
      if (!Number.isNaN(due)) {
        const now = Date.now();
        dueLine = now < due
          ? `, due in ${Math.max(1, Math.ceil((due - now) / DAY_MS))} day(s)`
          : ' — now overdue';
      }
    }
    await stageChase(env.DB, composeTaskReminder(env, row, `manual-${day}`, dueLine));
    sent.push(row.assignment_id);
  }
  return { sent: sent.length, assignment_ids: sent };
}

/** Draft reminders at T-7d, T-2d and T-12h before a form's close date. */
const DRAFT_OFFSETS_MS: Array<{ key: string; ms: number }> = [
  { key: '7d', ms: 7 * DAY_MS },
  { key: '2d', ms: 2 * DAY_MS },
  { key: '12h', ms: DAY_MS / 2 },
];

async function sweepDraftReminders(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT s.id AS submission_id, f.id AS form_id, f.internal_name AS form_name, f.close_at,
            c.id AS contact_id, c.email, c.first_name,
            e.id AS event_id, e.name AS event_name, e.slug AS event_slug, e.chase_mode
     FROM submissions s
     JOIN submission_forms f ON f.id = s.form_id
     JOIN contacts c ON c.id = s.submitter_contact_id
     JOIN events e ON e.id = s.event_id
     WHERE s.status = 'draft' AND f.status = 'open' AND f.close_at IS NOT NULL`,
  ).all<DraftReminderRow>();

  for (const row of results) {
    const close = new Date(row.close_at).getTime();
    if (Number.isNaN(close) || now >= close) continue;
    // Narrowest open window wins so a draft created at T-1d gets the 12h
    // reminder only, not all three at once.
    const active = [...DRAFT_OFFSETS_MS].reverse().find((o) => now >= close - o.ms);
    if (!active) continue;

    const closeText = new Date(row.close_at).toLocaleString('en-US', {
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    await stageChase(env.DB, {
      templateKey: 'draft_reminder',
      subjectOf: 'draft_close',
      subjectId: row.submission_id,
      version: active.key,
      eventId: row.event_id,
      contactId: row.contact_id,
      toEmail: row.email,
      chaseMode: row.chase_mode,
      context: {
        event: { name: row.event_name },
        speaker: { first_name: row.first_name ?? 'there' },
        form: { name: row.form_name, close_at: closeText },
        submission_url: `${env.APP_URL}/submit/${row.event_slug}/${row.form_id}`,
      },
    });
  }
}

/**
 * Days since the revision was asked for. Unlike the two sweeps above there is
 * no due date to count back from — the offset the doc's archive describes is
 * "how long has this deck owed me a v2", so the arithmetic runs forward from
 * `materials_state_at`.
 */
const MATERIALS_OFFSETS_MS: Array<{ key: string; ms: number }> = [
  { key: '3d', ms: 3 * DAY_MS },
  { key: '7d', ms: 7 * DAY_MS },
  { key: '14d', ms: 14 * DAY_MS },
];

/**
 * Workplan 15 W5b (D9): the second chase. `revision_requested` re-arms *this*
 * detector rather than starting a parallel one — same stageChase seam, same
 * idem_key shape, same assisted inbox and rungs, so the no-double-nudge
 * guarantee is the one that already exists.
 *
 * The chase resolves the way the first one does: when a file lands. The state
 * itself is deliberately NOT cleared by the upload (a v2 still needs a human
 * to say it is good — fileVersions.ts keeps 'revision_requested' in place), so
 * "has a newer upload than the request" is what stops the sweep, not the flag.
 */
async function sweepMaterialsReminders(env: Env, now: number): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT s.id AS submission_id, s.code, s.title, s.materials_state_at,
            c.id AS contact_id, c.email, c.first_name,
            e.id AS event_id, e.name AS event_name, e.slug AS event_slug, e.chase_mode
     FROM submissions s
     JOIN contacts c ON c.id = COALESCE(
            s.submitter_contact_id,
            (SELECT sp.contact_id FROM submission_participants sp
              WHERE sp.submission_id = s.id ORDER BY sp.position LIMIT 1))
     JOIN events e ON e.id = s.event_id
     WHERE s.status = 'accepted' AND s.materials_state = 'revision_requested'
       AND s.materials_state_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM file_request_uploads u
                        WHERE u.submission_id = s.id AND u.is_current = 1
                          AND u.uploaded_at > s.materials_state_at)`,
  ).all<MaterialsReminderRow>();

  for (const row of results) {
    const asked = new Date(row.materials_state_at).getTime();
    if (Number.isNaN(asked)) continue;
    // Widest elapsed window wins, the mirror image of the draft sweep's
    // narrowest-open rule: a sweep that first runs a fortnight late nudges
    // once at 14d rather than firing all three offsets in one pass.
    const active = [...MATERIALS_OFFSETS_MS].reverse().find((o) => now >= asked + o.ms);
    if (!active) continue;

    await stageChase(env.DB, {
      templateKey: 'materials_revision',
      subjectOf: 'materials',
      subjectId: row.submission_id,
      version: active.key,
      eventId: row.event_id,
      contactId: row.contact_id,
      toEmail: row.email,
      chaseMode: row.chase_mode,
      context: {
        event: { name: row.event_name },
        speaker: { first_name: row.first_name ?? 'there' },
        submission: { code: row.code, title: row.title },
        portal_url: `${env.APP_URL}/portal/${row.event_slug}`,
      },
    });
  }
}
