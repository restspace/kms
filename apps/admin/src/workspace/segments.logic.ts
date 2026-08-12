// CRM-09: the pure "what does saving this segment actually send" logic,
// pulled out of segments.tsx so it can be unit-tested without mounting the
// dialog. Checked rows win: any checkedIds means the organiser wants exactly
// those rows frozen (curated), not the live filter re-run later.

export interface SegmentSavePayload {
  name: string
  kind: 'dynamic' | 'curated'
  filters?: Record<string, unknown> | null
  member_ids?: string[] | null
}

/** Drops empty-string/null/undefined values from a live filters object — an
 * unset chip ("All") must not freeze into "must be blank" on replay. */
export function stripEmptyFilters(filters: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(filters)) {
    if (value === null || value === undefined || value === '') continue
    out[key] = value
  }
  return out
}

/**
 * Builds the POST /contact-segments body: curated (member_ids) when the
 * organiser has rows checked, else dynamic (the live filters, empty values
 * stripped).
 */
export function buildSegmentSavePayload(
  name: string,
  filters: Record<string, unknown>,
  checkedIds: string[],
): SegmentSavePayload {
  const trimmedName = name.trim()
  if (checkedIds.length > 0) {
    return { name: trimmedName, kind: 'curated', member_ids: [...checkedIds] }
  }
  return { name: trimmedName, kind: 'dynamic', filters: stripEmptyFilters(filters) }
}
