// Per-submission comment threads (workplan 7). Mirrors fileVersions.ts: the
// organiser detail panel and the reviewer scoring screen must show the same
// thread, so the queries live in one place.
//
// Append-only by design: no update, no delete. A changed opinion is a new
// comment. kind='rationale' rows are the reviewer's per-review comment folded
// into the thread at score-save time (carrying plan_id/assignment_id so score
// and rationale can still be joined); kind='discussion' is everything else.

import { reviewWindowState } from './reviewWindow';

export interface SubmissionCommentRow {
  id: string;
  submission_id: string;
  plan_id: string | null;
  assignment_id: string | null;
  author_contact_id: string | null;
  author_role: string;
  author_name: string | null;
  kind: string;
  body: string;
  created_at: string;
}

/** The whole thread for one submission, oldest first. */
export async function loadThread(db: D1Database, submissionId: string): Promise<SubmissionCommentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, submission_id, plan_id, assignment_id, author_contact_id,
              author_role, author_name, kind, body, created_at
       FROM submission_comments
       WHERE submission_id = ?
       ORDER BY created_at, id`,
    )
    .bind(submissionId)
    .all<SubmissionCommentRow>();
  return results;
}

export const MAX_COMMENT_CHARS = 2000;

/**
 * Append a comment. Returns null when the body is empty after trimming;
 * callers surface that as a field error rather than a 500.
 */
export async function addComment(
  db: D1Database,
  opts: {
    eventId: string;
    submissionId: string;
    planId?: string | null;
    assignmentId?: string | null;
    authorContactId: string | null;
    authorRole: string;
    authorName: string | null;
    kind?: 'rationale' | 'discussion';
    body: string;
  },
): Promise<string | null> {
  const body = opts.body.trim().slice(0, MAX_COMMENT_CHARS);
  if (body === '') return null;
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO submission_comments
         (id, event_id, submission_id, plan_id, assignment_id, author_contact_id,
          author_role, author_name, kind, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      opts.eventId,
      opts.submissionId,
      opts.planId ?? null,
      opts.assignmentId ?? null,
      opts.authorContactId,
      opts.authorRole,
      opts.authorName,
      opts.kind ?? 'discussion',
      body,
      new Date().toISOString(),
    )
    .run();
  return id;
}

/**
 * The reviewer anchoring gate (workplan D3): a reviewer sees the thread on a
 * submission once their own review is submitted, or once the round has closed.
 * Concretely: they hold an assignment on this submission with
 * status='complete', or every plan they are assigned to for it has closed —
 * the same ABS-01 window derivation the queue and score-save use
 * (reviewWindowState), plus plan status='closed', which also blocks further
 * scoring. No assignment at all → no thread.
 */
export async function canReviewerSeeThread(
  db: D1Database,
  contactId: string,
  submissionId: string,
): Promise<boolean> {
  const { results } = await db
    .prepare(
      `SELECT a.status, p.status AS plan_status, p.opens_at, p.closes_at
       FROM review_assignments a
       JOIN evaluation_plans p ON p.id = a.plan_id
       WHERE a.reviewer_contact_id = ? AND a.submission_id = ?`,
    )
    .bind(contactId, submissionId)
    .all<{ status: string; plan_status: string; opens_at: string | null; closes_at: string | null }>();
  if (results.length === 0) return false;
  if (results.some((r) => r.status === 'complete')) return true;
  return results.every(
    (r) => r.plan_status === 'closed' || reviewWindowState(r).reason === 'closed',
  );
}

/**
 * Reviewer-identity redaction for the reviewer-facing discussion thread
 * (workplan 13, plan.anonymise_submitters). The flag's original purpose is
 * hiding the *submitter's* identity from reviewers, but a rationale/
 * discussion thread with real reviewer names defeats that intent from the
 * other side — a reviewer can infer who scored what from who is arguing for
 * it. When the plan anonymises, every kind='rationale' or author_role=
 * 'reviewer' row gets a stable per-thread pseudonym ("Reviewer 1", "Reviewer
 * 2", …) instead of author_name, assigned by first appearance in the thread
 * so the same reviewer keeps the same label across the whole conversation.
 * author_contact_id is cleared alongside it — leaving it in place would make
 * the pseudonym cosmetic for any client that can resolve contact ids.
 * Organiser-authored rows (author_role admin/owner) are never touched: the
 * flag hides submitters and reviewers from each other, not the organisers
 * running the round.
 */
export function pseudonymiseReviewerAuthors(thread: SubmissionCommentRow[]): SubmissionCommentRow[] {
  const labels = new Map<string, string>();
  const labelFor = (contactId: string | null): string => {
    const key = contactId ?? '\0anonymous';
    let label = labels.get(key);
    if (!label) {
      label = `Reviewer ${labels.size + 1}`;
      labels.set(key, label);
    }
    return label;
  };
  return thread.map((row) => {
    if (row.kind !== 'rationale' && row.author_role !== 'reviewer') return row;
    return { ...row, author_name: labelFor(row.author_contact_id), author_contact_id: null };
  });
}

/** Display name for a comment author, denormalised onto the row at write time. */
export async function loadAuthorName(db: D1Database, contactId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT NULLIF(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')), '') AS name
       FROM contacts WHERE id = ?`,
    )
    .bind(contactId)
    .first<{ name: string | null }>();
  return row?.name ?? null;
}

/**
 * Append the reviewer's rationale as a thread comment at score-save time.
 * Suppresses the no-op case: only appends when the trimmed text differs from
 * that assignment's most recent rationale, so re-saving an unchanged score
 * form does not grow the thread.
 */
export async function appendRationale(
  db: D1Database,
  opts: {
    eventId: string;
    submissionId: string;
    planId: string;
    assignmentId: string;
    authorContactId: string;
    authorName: string | null;
    body: string;
  },
): Promise<string | null> {
  const body = opts.body.trim().slice(0, MAX_COMMENT_CHARS);
  if (body === '') return null;
  const latest = await db
    .prepare(
      `SELECT body FROM submission_comments
       WHERE assignment_id = ? AND kind = 'rationale'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(opts.assignmentId)
    .first<{ body: string }>();
  if (latest && latest.body === body) return null;
  return addComment(db, {
    eventId: opts.eventId,
    submissionId: opts.submissionId,
    planId: opts.planId,
    assignmentId: opts.assignmentId,
    authorContactId: opts.authorContactId,
    authorRole: 'reviewer',
    authorName: opts.authorName,
    kind: 'rationale',
    body,
  });
}
