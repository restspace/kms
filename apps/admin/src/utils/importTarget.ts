/**
 * Which event a workspace toolbar action writes into (D3).
 *
 * The sidebar's event picker is the workspace's source of truth: it lives in
 * the URL (`?ev=`) and is injected into every grid query *inside* the tab's
 * `dataSource` wrapper, so it never appears in the tab's own filter object.
 * Reading `filters.event_id` alone therefore reported "All events" even with a
 * single event selected, and the import wizard refused to open.
 *
 * Filters still win when they carry an `event_id` — a global filter anchored on
 * a row from the Events tab is a narrower, explicit choice than the sidebar's.
 */
export function resolveTargetEventId(
  eventFilterId: string | null | undefined,
  filters: Record<string, unknown> | null | undefined,
): string | null {
  const fromFilters = filters?.event_id
  if (typeof fromFilters === 'string' && fromFilters.trim()) return fromFilters.trim()
  if (typeof eventFilterId === 'string' && eventFilterId.trim()) return eventFilterId.trim()
  return null
}
