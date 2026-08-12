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
