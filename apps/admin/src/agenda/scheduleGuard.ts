import type { Conflict } from '@kms/core'

/**
 * Room double-booking guard (eval #22).
 *
 * Before this, an overlapping drop rendered a red ghost and a passive
 * `ROOM_DOUBLE_BOOKED` conflict — the write still went through, and the
 * agenda could still be published with two sessions split-width in the same
 * room/slot. The pure decision logic lives here (not inline in
 * AgendaSection.tsx) so it can be unit tested without a DOM, following the
 * *.logic.test.ts idiom used by mutationQueue/TimeGrid/timeUtils.
 *
 * The rule: any `error`-severity conflict (ROOM_DOUBLE_BOOKED chief among
 * them) blocks the write by default; an explicit "schedule anyway" override
 * is required to proceed. `warning`-severity conflicts (e.g. a speaker travel
 * gap) stay passive, exactly as before — this only tightens the hard case.
 */

export interface SchedulePatchLike {
  starts_at: string | null
  room_id: string | null
}

/**
 * A patch that does not claim both a time *and* a room cannot double-book
 * anything — clearing a schedule, or a day-only "pencil" drop with no room,
 * skips the conflict check entirely rather than prompting for no reason.
 */
export function patchNeedsGuard(patch: SchedulePatchLike): boolean {
  return patch.starts_at !== null && patch.room_id !== null
}

/** The subset of hits that should actually block the write. */
export function blockingConflicts(hits: Conflict[]): Conflict[] {
  return hits.filter((c) => c.severity === 'error')
}

/** True when `hits` contains at least one blocking (error-severity) conflict. */
export function hasBlockingConflict(hits: Conflict[]): boolean {
  return blockingConflicts(hits).length > 0
}

/** The "schedule anyway" confirm body for a single drop/move/add. */
export function conflictConfirmMessage(hits: Conflict[]): string {
  const errors = blockingConflicts(hits)
  return `Scheduling here creates a conflict:\n\n${errors.map((c) => `• ${c.message}`).join('\n')}\n\nSchedule anyway?`
}

/** How many conflicts to name before collapsing the rest into "…and N more". */
const LISTED_CONFLICT_LIMIT = 6

/**
 * The publish-confirm body naming every unresolved (non-ignored,
 * error-severity) conflict — publishing over an unresolved double-booking
 * used to be silent; this makes it an explicit, listed acknowledgement.
 *
 * Deliberately typed on the minimal shape rather than `Conflict`: the
 * server's `AgendaConflictRow` (api.ts) widens `code` to `string` and adds
 * `ignored`, so it is not structurally a `Conflict` — but every caller here
 * only ever reads `.message`.
 */
export function publishConflictMessage(unresolved: Array<{ message: string }>): string {
  const listed = unresolved.slice(0, LISTED_CONFLICT_LIMIT).map((c) => `• ${c.message}`)
  if (unresolved.length > LISTED_CONFLICT_LIMIT) {
    listed.push(`…and ${unresolved.length - LISTED_CONFLICT_LIMIT} more`)
  }
  return `${unresolved.length} unresolved scheduling conflict${unresolved.length === 1 ? '' : 's'} (e.g. a double-booked room) will go public as-is:\n\n${listed.join('\n')}\n\nPublish anyway?`
}
