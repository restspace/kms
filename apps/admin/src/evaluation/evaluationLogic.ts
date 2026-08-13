// Pure helpers factored out of EvaluationSection.tsx so the payload-building
// logic for ABS-01 (scale editor), ABS-05 (assign-to-selected) and ABS-06
// (reviewer cap) is unit-testable without rendering the component tree.

/**
 * ABS-01: the scale editor's min/max inputs each save independently on blur.
 * Returns the PUT patch to send, or null when the field is unchanged/unparseable
 * (nothing to save).
 */
export function buildScalePatch(
  field: 'scoring_scale_min' | 'scoring_scale_max',
  rawValue: string,
  current: number,
): Record<string, number> | null {
  const next = Number(rawValue)
  if (!Number.isFinite(next) || next === current) return null
  return { [field]: next }
}

/**
 * ABS-05: the Assign request body. `onlySelected` scopes to the ticked
 * submissions via `submission_ids` — server-side support already existed,
 * this is just the client building the right request.
 */
export function buildAssignBody(
  base: { reviewer_contact_ids: string[]; strategy: 'all' | 'round_robin'; per_submission: number },
  onlySelected: boolean,
  picked: ReadonlySet<string> | string[],
): Record<string, unknown> {
  const ids = Array.isArray(picked) ? picked : [...picked]
  return onlySelected && ids.length > 0 ? { ...base, submission_ids: ids } : { ...base }
}

/**
 * ABS-06: the reviewer cap input's onBlur. Empty string clears the cap
 * (null); otherwise a whole number. Returns undefined when the value is
 * unchanged from what is already stored, so callers can skip the request.
 */
export function parseCapInput(rawValue: string, current: number | null): number | null | undefined {
  const trimmed = rawValue.trim()
  const next = trimmed === '' ? null : Number(trimmed)
  if (next === current) return undefined
  return next
}

/** What a round-timing `datetime-local` blur should do next (eval defect #24). */
export type DateBlurOutcome =
  | { action: 'save'; next: string | null }
  | { action: 'invalid' }
  | { action: 'noop' }

/**
 * The round card's "Reviews open"/"Reviews close" fields used to save on
 * every blur regardless of whether the input actually held a complete date —
 * `datetime-local` reports an empty `.value` both when the user genuinely
 * cleared the field AND when they are mid-way through typing one (year typed,
 * month not yet), so blurring mid-edit silently committed `null` and wiped
 * the round's date. `badInput` (from the input's `ValidityState`) is what
 * tells those two cases apart — true only for the partial-typing case — so
 * callers pass it through instead of trusting `.value` alone.
 *
 * `parseValue` converts a datetime-local string to the ISO the API stores
 * (or null for an intentional clear); it is injected so this stays a pure
 * function testable without a real `<input>`.
 */
export function resolveDateInputBlur(
  rawValue: string,
  badInput: boolean,
  current: string | null,
  parseValue: (value: string) => string | null,
): DateBlurOutcome {
  if (badInput) return { action: 'invalid' }
  const next = parseValue(rawValue)
  return next === current ? { action: 'noop' } : { action: 'save', next }
}
