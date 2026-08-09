// Opaque keyset cursors (sweep item P2-18, docs/10 §1). A cursor encodes the
// last row's [sortValue, id]; the WHERE tuple-comparison is emitted in
// expanded form because SQLite does not use indexes for row-value comparisons
// in every shape. Sort columns must be NOT NULL (or wrapped in COALESCE by
// the caller's select) for the ordering to be total.

export interface CursorPayload {
  /** last row's sort-column value */
  v: string | number;
  /** last row's id (tiebreaker; unique) */
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  const json = JSON.stringify([payload.v, payload.id]);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const b64 = cursor.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (cursor.length % 4)) % 4);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [v, id] = parsed as [unknown, unknown];
    if (typeof id !== 'string' || (typeof v !== 'string' && typeof v !== 'number')) return null;
    return { v, id };
  } catch {
    return null;
  }
}

export interface KeysetClause {
  /** e.g. "(s.title > ? OR (s.title = ? AND s.id > ?))" — append to WHERE */
  sql: string;
  /** bind values in order: [sortValue, sortValue, id] */
  binds: (string | number)[];
}

/**
 * Build the keyset WHERE fragment for one sort column + id tiebreaker.
 * `sortExpr` and `idExpr` are trusted SQL (whitelisted by the caller's
 * registry), never user input.
 */
export function keysetWhere(
  sortExpr: string,
  idExpr: string,
  direction: 'asc' | 'desc',
  cursor: CursorPayload,
): KeysetClause {
  const op = direction === 'desc' ? '<' : '>';
  return {
    sql: `(${sortExpr} ${op} ? OR (${sortExpr} = ? AND ${idExpr} ${op} ?))`,
    binds: [cursor.v, cursor.v, cursor.id],
  };
}
