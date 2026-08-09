// Internal-only fields must never reach speaker-facing surfaces. The portal
// (and any future public/embed route) reads whole rows for convenience, so
// every such read passes through this boundary before templates see the data
// (manual-review-1.md "Portal redaction helper").

/** Keys that exist for organisers only. Extend as internal columns are added. */
const INTERNAL_KEYS: readonly string[] = ['notes'];

/**
 * Return a copy of `row` with internal-only keys removed. Null/undefined-safe
 * (portal lookups can miss) and a no-op on rows without the keys. Never
 * mutates its input.
 */
export function redactInternal<T extends object>(row: T | null | undefined): T | null {
  if (row === null || row === undefined) return null;
  const copy: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const key of INTERNAL_KEYS) delete copy[key];
  return copy as T;
}

/** Array counterpart of `redactInternal`; drops null/undefined entries. */
export function redactInternalAll<T extends object>(rows: ReadonlyArray<T | null | undefined>): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const redacted = redactInternal(row);
    if (redacted !== null) out.push(redacted);
  }
  return out;
}
