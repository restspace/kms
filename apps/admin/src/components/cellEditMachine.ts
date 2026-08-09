/**
 * Pure state-transition helpers backing DataList's failure-aware inline cell
 * edits. Kept free of React so the transitions can be unit-tested directly:
 * optimistic apply -> resolve merge, reject rollback, pending blocks re-edit,
 * error clears on next interaction.
 */

export type CellEditStatus = 'pending' | 'error';

export interface CellEditEntry {
  status: CellEditStatus;
  /** Value the cell held before the optimistic edit, restored on rollback. */
  previousValue: unknown;
}

export type CellEditMap = Map<string, CellEditEntry>;

/** Builds the map key identifying a single row+field cell. */
export const cellKey = (rowId: string, field: string): string => `${rowId}:${field}`;

/** A cell can accept a new edit unless a previous write to it is still in flight. */
export const canEditCell = (map: CellEditMap, key: string): boolean => {
  const entry = map.get(key);
  return !entry || entry.status !== 'pending';
};

/** Marks a cell pending, remembering the value to restore on rollback. */
export const beginPendingEdit = (map: CellEditMap, key: string, previousValue: unknown): CellEditMap => {
  const next = new Map(map);
  next.set(key, { status: 'pending', previousValue });
  return next;
};

/** Clears a cell's status once its write resolves successfully. */
export const resolveEdit = (map: CellEditMap, key: string): CellEditMap => {
  if (!map.has(key)) {
    return map;
  }
  const next = new Map(map);
  next.delete(key);
  return next;
};

/** Marks a cell errored after its write rejects; the caller rolls the row back. */
export const rejectEdit = (map: CellEditMap, key: string): CellEditMap => {
  const next = new Map(map);
  const entry = next.get(key);
  next.set(key, { status: 'error', previousValue: entry?.previousValue });
  return next;
};

/** Clears a stale error marker; called on the next interaction with a cell. */
export const clearCellStatus = (map: CellEditMap, key: string): CellEditMap => {
  if (!map.has(key)) {
    return map;
  }
  const next = new Map(map);
  next.delete(key);
  return next;
};

/** Applies an optimistic local edit to one field of one row. Pure — no side effects. */
export function applyCellEdit<T extends Record<string, any>>(
  items: T[],
  index: number,
  field: string,
  value: unknown
): T[] {
  const current = items[index];
  if (!current) {
    return items;
  }
  const next = items.slice();
  next[index] = { ...current, [field]: value } as T;
  return next;
}

/**
 * Restores a field to its pre-edit value after a failed write. Guarded by
 * `expectedId` so a row that has moved or disappeared by the time the write
 * settles is never clobbered.
 */
export function applyCellRollback<T extends Record<string, any>>(
  items: T[],
  index: number,
  field: string,
  previousValue: unknown,
  expectedId: string,
  getItemId: (item: T) => string
): T[] {
  const current = items[index];
  if (!current || getItemId(current) !== expectedId) {
    return items;
  }
  const next = items.slice();
  next[index] = { ...current, [field]: previousValue } as T;
  return next;
}

/**
 * Merges server-returned fields (or a full replacement row) into a row after
 * a successful write. Server values win over the optimistic local ones.
 * Guarded by `expectedId` for the same reason as `applyCellRollback`.
 */
export function applyCellMerge<T extends Record<string, any>>(
  items: T[],
  index: number,
  expectedId: string,
  patch: Partial<T> | T | Record<string, unknown>,
  getItemId: (item: T) => string
): T[] {
  const current = items[index];
  if (!current || getItemId(current) !== expectedId) {
    return items;
  }
  const next = items.slice();
  next[index] = { ...current, ...patch } as T;
  return next;
}
