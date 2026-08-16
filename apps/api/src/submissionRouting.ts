// Category-based routing, shared between the paths that can change a
// submission's routing inputs (docs/04 §4).
//
// Routing used to run in exactly one place — the public submit handler — and
// nothing re-ran it afterwards. That left an invariant that only held at the
// instant of submission: a speaker could edit the very answer a rule keyed off
// (portal.ts's edit route rewrites the whole answer set), or an organiser could
// change the track from the Workspace, and the routed track, evaluation plan
// and tags would silently keep pointing where the FIRST version of the answers
// sent them.
//
// This module closes that two ways:
//
//   1. Re-routing. While a submission is still in play, any write that changes
//      a routing input re-runs the rules and applies the difference.
//   2. Freezing. Once the submission is past the point where re-routing is
//      meaningful (a decision is queued or made), the inputs themselves stop
//      being editable — see isRoutingFrozen. Together these mean the routed
//      values always match what the rules say about the current answers.
//
// Re-routing is provenance-aware: it only overwrites values routing itself put
// there. An organiser who moved a submission to a different evaluation plan, or
// added a tag by hand, has made a decision that a later edit by the speaker
// must not quietly undo. `submissions.routing_state` (migration 0046) records
// what routing last wrote, which is what makes that distinction possible.

import {
  applyRouting,
  routingInputQuestionIds,
  type Answers,
  type AnswerValue,
  type RoutingActions,
  type RoutingConfig,
  type RoutingOutcome,
} from '@kms/core';
import { loadQuestions } from './routes/formsAdmin';

type Db = D1Database;

// ---------------------------------------------------------------------------
// The freeze
// ---------------------------------------------------------------------------

/**
 * Statuses at which a submission's routing inputs stop being editable.
 *
 * Deliberately a superset of portal.ts's EDIT_LOCKED_STATUSES: that set locks
 * the whole record and stays as it is (a speaker may keep an accepted proposal
 * accurate — docs/manual/submission-lifecycle.md). This one is narrower in
 * effect and wider in reach: it freezes only the handful of answers that decide
 * routing, from the moment a decision is queued. Past that point re-routing
 * would reshuffle a decision batch and churn review data for no benefit, so the
 * invariant is held by making the inputs immutable instead.
 */
const ROUTING_FROZEN_STATUSES: ReadonlySet<string> = new Set([
  'accept_queue',
  'decline_queue',
  'accepted',
  'declined',
  'withdrawn',
]);

export function isRoutingFrozen(status: string | null | undefined): boolean {
  return status ? ROUTING_FROZEN_STATUSES.has(status) : false;
}

/** The reason shown to whoever hit the freeze — one sentence, both surfaces. */
export const ROUTING_FROZEN_REASON =
  'This answer decides how the proposal was routed, and can no longer change now that a decision is under way.';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** submission_forms.routing_rules is organiser-supplied json; never throw on it. */
export function parseRoutingConfig(json: string | null | undefined): RoutingConfig | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as RoutingConfig;
  } catch {
    return null;
  }
}

/** `assign_track_ids` rides on the routing action object as an optional extra
 *  (RoutingActions is frozen); read it off the matched rules by hand. */
type MultiTrackActions = RoutingActions & { assign_track_ids?: unknown };

export function routingTrackIds(config: RoutingConfig | null, routing: RoutingOutcome): string[] {
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

// ---------------------------------------------------------------------------
// Resolving a routing outcome to real, in-event ids
// ---------------------------------------------------------------------------

/** Statuses a routing rule is allowed to set. Anything else falls back to
 *  'pending' — and set_status only ever applies at first submit (see below). */
const ROUTABLE_STATUSES: ReadonlySet<string> = new Set(['pending', 'accept_queue', 'decline_queue']);

export interface RoutingTargets {
  /** set_track_id, if it names a track in this event. */
  primaryTrackId: string | null;
  /** primaryTrackId first, then any valid assign_track_ids, de-duped. */
  trackIds: string[];
  planId: string | null;
  tagIds: string[];
  /** Honoured at first submit only. */
  status: string;
}

/**
 * Resolve a routing outcome against this event's tracks, plans and tags.
 * Routing json is editable input, so every id is checked to belong to the event
 * before it can cross-link a record.
 */
export async function resolveRoutingTargets(
  db: Db,
  eventId: string,
  config: RoutingConfig | null,
  routing: RoutingOutcome,
): Promise<RoutingTargets> {
  const trackCandidates: string[] = [];
  const pushCandidate = (id: string | undefined) => {
    if (id && !trackCandidates.includes(id)) trackCandidates.push(id);
  };
  pushCandidate(routing.set_track_id);
  for (const id of routingTrackIds(config, routing)) pushCandidate(id);

  const trackIds: string[] = [];
  if (trackCandidates.length > 0) {
    const placeholders = trackCandidates.map(() => '?').join(', ');
    const { results } = await db
      .prepare(`SELECT id FROM tracks WHERE event_id = ? AND id IN (${placeholders})`)
      .bind(eventId, ...trackCandidates)
      .all<{ id: string }>();
    const valid = new Set(results.map((r) => r.id));
    for (const id of trackCandidates) if (valid.has(id) && !trackIds.includes(id)) trackIds.push(id);
  }

  let planId: string | null = null;
  if (routing.assign_evaluation_plan_id) {
    const row = await db
      .prepare('SELECT id FROM evaluation_plans WHERE id = ? AND event_id = ?')
      .bind(routing.assign_evaluation_plan_id, eventId)
      .first<{ id: string }>();
    planId = row?.id ?? null;
  }

  const tagIds: string[] = [];
  if (routing.add_tag_ids.length > 0) {
    const placeholders = routing.add_tag_ids.map(() => '?').join(', ');
    const { results } = await db
      .prepare(`SELECT id FROM tags WHERE event_id = ? AND id IN (${placeholders})`)
      .bind(eventId, ...routing.add_tag_ids)
      .all<{ id: string }>();
    const valid = new Set(results.map((r) => r.id));
    for (const id of routing.add_tag_ids) if (valid.has(id) && !tagIds.includes(id)) tagIds.push(id);
  }

  return {
    primaryTrackId: routing.set_track_id && trackIds.includes(routing.set_track_id) ? routing.set_track_id : null,
    trackIds,
    planId,
    tagIds,
    status: routing.set_status && ROUTABLE_STATUSES.has(routing.set_status) ? routing.set_status : 'pending',
  };
}

// ---------------------------------------------------------------------------
// Provenance (submissions.routing_state, migration 0046)
// ---------------------------------------------------------------------------

export interface RoutingState {
  applied_rule_ids: string[];
  used_fallback: boolean;
  at: string;
  /** Exactly what routing wrote — the baseline a re-route compares against. */
  set: {
    /** The primary track routing asserted, if any. */
    track_id: string | null;
    /** Every track routing put in submission_tracks (primary + assign_track_ids). */
    track_ids: string[];
    evaluation_plan_id: string | null;
    tag_ids: string[];
    status: string;
  };
}

/** Null for a submission that predates migration 0046, or one never routed. */
export function parseRoutingState(json: string | null | undefined): RoutingState | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<RoutingState>;
    if (!parsed || typeof parsed !== 'object' || !parsed.set) return null;
    return {
      applied_rule_ids: Array.isArray(parsed.applied_rule_ids) ? parsed.applied_rule_ids.map(String) : [],
      used_fallback: parsed.used_fallback === true,
      at: typeof parsed.at === 'string' ? parsed.at : '',
      set: {
        track_id: parsed.set.track_id ?? null,
        track_ids: Array.isArray(parsed.set.track_ids) ? parsed.set.track_ids.map(String) : [],
        evaluation_plan_id: parsed.set.evaluation_plan_id ?? null,
        tag_ids: Array.isArray(parsed.set.tag_ids) ? parsed.set.tag_ids.map(String) : [],
        status: typeof parsed.set.status === 'string' ? parsed.set.status : 'pending',
      },
    };
  } catch {
    return null;
  }
}

export function serialiseRoutingState(
  routing: RoutingOutcome,
  set: RoutingState['set'],
  at: string,
): string {
  const state: RoutingState = {
    applied_rule_ids: routing.applied_rule_ids,
    used_fallback: routing.used_fallback,
    at,
    set,
  };
  return JSON.stringify(state);
}

// ---------------------------------------------------------------------------
// Re-routing an existing submission
// ---------------------------------------------------------------------------

export interface RerouteSubject {
  id: string;
  event_id: string;
  status: string;
  track_id: string | null;
  evaluation_plan_id: string | null;
  routing_state: string | null;
}

export interface RerouteResult {
  statements: D1PreparedStatement[];
  /** Rules that fired this time — for the "Routed by" line and for tests. */
  appliedRuleIds: string[];
  usedFallback: boolean;
  /** Values a manual override kept routing from changing, for logging/UI. */
  skipped: Array<'track' | 'evaluation_plan'>;
}

/**
 * Re-run routing over a submission's current answers and return the statements
 * that bring its routed values back in line — to be appended to the caller's
 * own `db.batch`, so the edit and the routing it implies commit together.
 *
 * Provenance rules (see the module header):
 *   track / plan — overwritten only where the stored value still equals what
 *     routing last set. A plan additionally yields to an explicit
 *     evaluation_plan_submissions row, which is the organiser's own membership
 *     decision (evaluation.ts unions the two).
 *   tags — a per-tag delta, never the whole-set replace the submit path does:
 *     drop only tags routing added and no longer wants, add the new ones, and
 *     leave anything an organiser attached by hand alone.
 *   status — never. set_status applies at first submit only; after that the
 *     accept/decline workflow owns it.
 *
 * A submission with no provenance (NULL routing_state — anything predating
 * migration 0046) is treated as entirely organiser-owned: tags may be added,
 * but its track and plan are never re-pointed.
 */
export async function rerouteStatements(
  db: Db,
  submission: RerouteSubject,
  config: RoutingConfig | null,
  /** ALREADY in the stored display-label shape (submit.tsx storableAnswers) —
   *  rules match the same text the answers persist as, and taking them that way
   *  keeps this module out of an import cycle with the submit route. */
  storedAnswers: Answers,
  now: string,
): Promise<RerouteResult> {
  const routing = applyRouting(config, storedAnswers);
  const targets = await resolveRoutingTargets(db, submission.event_id, config, routing);
  const prev = parseRoutingState(submission.routing_state);
  const statements: D1PreparedStatement[] = [];
  const skipped: RerouteResult['skipped'] = [];

  // --- track ---------------------------------------------------------------
  // Routing only ever ASSERTS a track; it never clears one. When the rules no
  // longer name a track, the value the caller's own write put there stands —
  // which is the same precedence the submit path uses (`routedTrackId ??
  // answer-derived track`), just spread across two statements. Clearing here
  // would instead wipe a track the speaker had picked by answer.
  //
  // `prev` absent => no baseline to prove routing owns the current value, so a
  // pre-0046 submission is never re-pointed.
  let nextTrackId = submission.track_id ?? null;
  if (targets.primaryTrackId !== null && targets.primaryTrackId !== (prev?.set.track_id ?? null)) {
    const trackOwned = prev !== null && (submission.track_id ?? null) === (prev.set.track_id ?? null);
    if (trackOwned) {
      nextTrackId = targets.primaryTrackId;
      statements.push(
        db
          .prepare('UPDATE submissions SET track_id = ?, updated_at = ? WHERE id = ? AND event_id = ?')
          .bind(nextTrackId, now, submission.id, submission.event_id),
      );
    } else {
      skipped.push('track');
    }
  }

  // submission_tracks (the authoritative multi-track set) as a per-row delta,
  // for the same reason the tags below are: the submit path can DELETE the
  // whole set and rebuild it because it owns every row, but here an
  // answer-derived or organiser-added track would not survive that.
  const nextTrackIds = new Set(
    skipped.includes('track') ? (prev?.set.track_ids ?? []) : [...(nextTrackId ? [nextTrackId] : []), ...targets.trackIds],
  );
  for (const trackId of prev?.set.track_ids ?? []) {
    if (nextTrackIds.has(trackId)) continue;
    statements.push(
      db
        .prepare('DELETE FROM submission_tracks WHERE submission_id = ? AND track_id = ?')
        .bind(submission.id, trackId),
    );
  }
  for (const trackId of nextTrackIds) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO submission_tracks (submission_id, track_id)
           SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ?1)`,
        )
        .bind(submission.id, trackId),
    );
  }

  // --- evaluation plan -----------------------------------------------------
  let nextPlanId = submission.evaluation_plan_id ?? null;
  if (targets.planId !== (prev?.set.evaluation_plan_id ?? null)) {
    const explicit = await db
      .prepare('SELECT 1 AS hit FROM evaluation_plan_submissions WHERE submission_id = ? LIMIT 1')
      .bind(submission.id)
      .first<{ hit: number }>();
    const planOwned =
      prev !== null &&
      !explicit &&
      (submission.evaluation_plan_id ?? null) === (prev.set.evaluation_plan_id ?? null);
    if (planOwned) {
      nextPlanId = targets.planId;
      statements.push(
        db
          .prepare('UPDATE submissions SET evaluation_plan_id = ?, updated_at = ? WHERE id = ? AND event_id = ?')
          .bind(nextPlanId, now, submission.id, submission.event_id),
      );
    } else {
      skipped.push('evaluation_plan');
    }
  }

  // --- tags ----------------------------------------------------------------
  const { results: currentTagRows } = await db
    .prepare('SELECT tag_id FROM submission_tags WHERE submission_id = ?')
    .bind(submission.id)
    .all<{ tag_id: string }>();
  const currentTags = new Set(currentTagRows.map((r) => r.tag_id));
  const nextTags = new Set(targets.tagIds);
  // Only tags routing itself added are candidates for removal.
  for (const tagId of prev?.set.tag_ids ?? []) {
    if (!nextTags.has(tagId) && currentTags.has(tagId)) {
      statements.push(
        db
          .prepare('DELETE FROM submission_tags WHERE submission_id = ? AND tag_id = ?')
          .bind(submission.id, tagId),
      );
    }
  }
  for (const tagId of nextTags) {
    if (currentTags.has(tagId)) continue;
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO submission_tags (submission_id, tag_id)
           SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ?1)`,
        )
        .bind(submission.id, tagId),
    );
  }

  // --- provenance ----------------------------------------------------------
  // Records what routing WOULD have set, including the values a manual
  // override kept it from writing: the next re-route then compares against the
  // organiser's value and leaves it alone again, rather than treating the stale
  // baseline as proof the value is still routing's to move.
  statements.push(
    db
      .prepare('UPDATE submissions SET routing_state = ? WHERE id = ? AND event_id = ?')
      .bind(
        serialiseRoutingState(
          routing,
          {
            // What routing ASSERTS, which is not always what the row now holds:
            // where a manual override won, the baseline records routing's value
            // so the next re-route compares the organiser's value against it,
            // finds them different, and leaves the override alone again. Using
            // the row's value here would hand routing ownership of a decision
            // it did not make. Where routing asserts no track at all it has no
            // opinion, so the previous baseline carries forward.
            track_id: targets.primaryTrackId ?? prev?.set.track_id ?? null,
            track_ids: [...nextTrackIds],
            evaluation_plan_id: targets.planId,
            tag_ids: [...nextTags],
            // Never re-routed; carry the submit-time value forward for the record.
            status: prev?.set.status ?? submission.status,
          },
          now,
        ),
        submission.id,
        submission.event_id,
      ),
  );

  return { statements, appliedRuleIds: routing.applied_rule_ids, usedFallback: routing.used_fallback, skipped };
}

// ---------------------------------------------------------------------------
// Read side: what the Workspace needs to show
// ---------------------------------------------------------------------------

export interface RoutingSummary {
  /** Rules that fired, as "<question> is <value>" — why it landed where it did. */
  applied: string[];
  used_fallback: boolean;
  /** The organiser may not change the track: it is a frozen routing input. */
  locked_track: boolean;
  /** One sentence for the UI when locked_track is true. */
  locked_reason: string | null;
}

const CONDITION_VERB: Record<string, string> = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'includes',
  not_contains: 'does not include',
  is_any_of: 'is any of',
  is_empty: 'is empty',
  is_not_empty: 'is answered',
  gt: 'is greater than',
  lt: 'is less than',
};

/**
 * The routing story for one submission, for the Workspace detail panel and its
 * edit form. Rebuilds the human-readable rule list from the stored provenance
 * (0046) plus the form's current rules — docs/manual/submission-lifecycle.md
 * has always told organisers this is visible; now it is.
 */
export async function routingSummary(
  db: Db,
  eventId: string,
  submission: { id: string; form_id: string | null; status: string; routing_state: string | null },
): Promise<RoutingSummary> {
  const empty: RoutingSummary = { applied: [], used_fallback: false, locked_track: false, locked_reason: null };
  if (!submission.form_id) return empty;
  const formRow = await db
    .prepare('SELECT routing_rules FROM submission_forms WHERE id = ? AND event_id = ?')
    .bind(submission.form_id, eventId)
    .first<{ routing_rules: string | null }>();
  const config = parseRoutingConfig(formRow?.routing_rules ?? null);
  if (!config) return empty;

  const questions = await loadQuestions(db, submission.form_id, eventId);
  const labelOf = (questionId: string) => questions.find((q) => q.id === questionId)?.label ?? 'An answer';
  const state = parseRoutingState(submission.routing_state);
  const applied: string[] = [];
  for (const ruleId of state?.applied_rule_ids ?? []) {
    const rule = config.rules?.find((r) => r.id === ruleId);
    if (!rule) continue;
    const verb = CONDITION_VERB[rule.when.op] ?? rule.when.op;
    const value = Array.isArray(rule.when.value) ? rule.when.value.join(', ') : rule.when.value;
    applied.push(
      value === undefined || value === null || value === ''
        ? `${labelOf(rule.when.question_id)} ${verb}`
        : `${labelOf(rule.when.question_id)} ${verb} “${String(value)}”`,
    );
  }

  const trackQuestion = questions.find((q) => q.field_key === 'track');
  const lockedTrack =
    !!trackQuestion && isRoutingFrozen(submission.status) && routingInputQuestionIds(config).includes(trackQuestion.id);

  return {
    applied,
    used_fallback: state?.used_fallback ?? false,
    locked_track: lockedTrack,
    locked_reason: lockedTrack ? ROUTING_FROZEN_REASON : null,
  };
}

// ---------------------------------------------------------------------------
// The organiser-side track change
// ---------------------------------------------------------------------------

/** Stored answers, in the display-label shape they were written in. */
export async function loadStoredAnswers(db: Db, submissionId: string): Promise<Answers> {
  const { results } = await db
    .prepare('SELECT question_id, value_json FROM submission_answers WHERE submission_id = ?')
    .bind(submissionId)
    .all<{ question_id: string; value_json: string | null }>();
  const answers: Answers = {};
  for (const row of results) {
    if (row.value_json === null) continue;
    try {
      answers[row.question_id] = JSON.parse(row.value_json) as AnswerValue;
    } catch {
      // A non-json legacy value is still an answer; take it verbatim.
      answers[row.question_id] = row.value_json;
    }
  }
  return answers;
}

interface TrackChangeRow {
  id: string;
  event_id: string;
  form_id: string | null;
  status: string;
  track_id: string | null;
  evaluation_plan_id: string | null;
  routing_state: string | null;
}

/**
 * An organiser changing a submission's track from the Workspace.
 *
 * `submissions.track_id` used to be written on its own, leaving the Track
 * question's stored ANSWER — the thing routing actually reads — saying
 * something else, and `submission_tracks` (the authoritative multi-track set)
 * saying a third thing. The routing invariant cannot hold while the input and
 * the output disagree, so the three move together here, and routing re-runs
 * over the result: changing the track can therefore also move the evaluation
 * plan and tags, subject to the same provenance rules as any other re-route.
 *
 * Returns `locked` when the Track answer is one the routing rules key off and
 * the submission is past re-routing — at which point the caller must reject
 * rather than write, since neither changing the input nor leaving it
 * inconsistent is allowed.
 */
export async function trackChangeStatements(
  db: Db,
  eventId: string,
  submissionId: string,
  nextTrackId: string | null,
  now: string,
): Promise<{ locked: true } | { locked: false; statements: D1PreparedStatement[] }> {
  const submission = await db
    .prepare(
      `SELECT id, event_id, form_id, status, track_id, evaluation_plan_id, routing_state
       FROM submissions WHERE id = ? AND event_id = ?`,
    )
    .bind(submissionId, eventId)
    .first<TrackChangeRow>();
  // No row: the caller's own UPDATE will report not_found. Nothing to sync.
  if (!submission) return { locked: false, statements: [] };
  if ((submission.track_id ?? null) === nextTrackId) return { locked: false, statements: [] };

  const config = submission.form_id
    ? parseRoutingConfig(
        (
          await db
            .prepare('SELECT routing_rules FROM submission_forms WHERE id = ? AND event_id = ?')
            .bind(submission.form_id, eventId)
            .first<{ routing_rules: string | null }>()
        )?.routing_rules ?? null,
      )
    : null;

  const questions = submission.form_id ? await loadQuestions(db, submission.form_id, eventId) : [];
  const trackQuestion = questions.find((q) => q.field_key === 'track') ?? null;

  if (trackQuestion && isRoutingFrozen(submission.status) && routingInputQuestionIds(config).includes(trackQuestion.id)) {
    return { locked: true };
  }

  const statements: D1PreparedStatement[] = [];
  const answers = await loadStoredAnswers(db, submissionId);

  // 1. The Track answer, written as the track's NAME — the same display-label
  //    shape submit.tsx (storableAnswers) and the portal edit both store, so
  //    the organiser panel, exports and the routing rules all keep reading it
  //    the one way.
  const trackName = nextTrackId
    ? (
        await db
          .prepare('SELECT name FROM tracks WHERE id = ? AND event_id = ?')
          .bind(nextTrackId, eventId)
          .first<{ name: string }>()
      )?.name ?? null
    : null;
  if (trackQuestion) {
    statements.push(
      db
        .prepare('DELETE FROM submission_answers WHERE submission_id = ? AND question_id = ?')
        .bind(submissionId, trackQuestion.id),
    );
    if (trackName !== null) {
      statements.push(
        db
          .prepare('INSERT INTO submission_answers (submission_id, question_id, value_json) VALUES (?, ?, ?)')
          .bind(submissionId, trackQuestion.id, JSON.stringify(trackName)),
      );
      answers[trackQuestion.id] = trackName;
    } else {
      delete answers[trackQuestion.id];
    }
  }

  // 2. submission_tracks: swap the old primary for the new one, leaving any
  //    other track on the submission alone.
  if (submission.track_id) {
    statements.push(
      db
        .prepare('DELETE FROM submission_tracks WHERE submission_id = ? AND track_id = ?')
        .bind(submissionId, submission.track_id),
    );
  }
  if (nextTrackId) {
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO submission_tracks (submission_id, track_id)
           SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ?1)`,
        )
        .bind(submissionId, nextTrackId),
    );
  }

  // 3. Re-route from the updated answers. Skipped once frozen — reachable when
  //    the Track answer is not itself a routing input, so nothing routing reads
  //    has changed.
  if (!isRoutingFrozen(submission.status)) {
    const reroute = await rerouteStatements(
      db,
      {
        id: submission.id,
        event_id: submission.event_id,
        status: submission.status,
        // The organiser's new track is the baseline routing is asked about.
        track_id: nextTrackId,
        evaluation_plan_id: submission.evaluation_plan_id,
        routing_state: submission.routing_state,
      },
      config,
      answers,
      now,
    );
    statements.push(...reroute.statements);
  }

  return { locked: false, statements };
}
