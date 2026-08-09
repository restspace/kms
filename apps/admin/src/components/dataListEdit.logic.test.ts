import { describe, expect, it } from 'vitest'
import {
  applyCellEdit,
  applyCellMerge,
  applyCellRollback,
  beginPendingEdit,
  canEditCell,
  cellKey,
  clearCellStatus,
  rejectEdit,
  resolveEdit,
  type CellEditMap,
} from './cellEditMachine'

/**
 * Pure half of DataList's failure-aware inline cell edits (sweep item 8).
 * Runs in the `unit` project — no DOM, no react-window, just the row-array
 * and status-map transitions.
 */

interface Row {
  id: string
  status: string
}

const getItemId = (row: Row) => row.id

const rows = (): Row[] => [
  { id: 'a', status: 'pending' },
  { id: 'b', status: 'accepted' },
]

describe('applyCellEdit', () => {
  it('sets the field optimistically without mutating the source array', () => {
    const items = rows()
    const next = applyCellEdit(items, 0, 'status', 'accepted')
    expect(next[0].status).toBe('accepted')
    expect(items[0].status).toBe('pending')
    expect(next).not.toBe(items)
  })

  it('is a no-op when the index is out of range', () => {
    const items = rows()
    const next = applyCellEdit(items, 5, 'status', 'accepted')
    expect(next).toBe(items)
  })
})

describe('cell status map transitions', () => {
  it('optimistic -> resolve clears the pending marker (server merge applied separately)', () => {
    let map: CellEditMap = new Map()
    const key = cellKey('a', 'status')

    expect(canEditCell(map, key)).toBe(true)
    map = beginPendingEdit(map, key, 'pending')
    expect(canEditCell(map, key)).toBe(false)

    map = resolveEdit(map, key)
    expect(map.has(key)).toBe(false)
    expect(canEditCell(map, key)).toBe(true)
  })

  it('reject marks the cell errored and rollback restores the previous value', () => {
    let items = rows()
    let map: CellEditMap = new Map()
    const key = cellKey('a', 'status')

    items = applyCellEdit(items, 0, 'status', 'accepted')
    map = beginPendingEdit(map, key, 'pending')

    map = rejectEdit(map, key)
    items = applyCellRollback(items, 0, 'status', 'pending', 'a', getItemId)

    expect(items[0].status).toBe('pending')
    expect(map.get(key)?.status).toBe('error')
  })

  it('pending blocks re-edits to that cell but leaves other cells free', () => {
    let map: CellEditMap = new Map()
    const key = cellKey('a', 'status')
    const otherKey = cellKey('b', 'status')

    map = beginPendingEdit(map, key, 'pending')

    expect(canEditCell(map, key)).toBe(false)
    expect(canEditCell(map, otherKey)).toBe(true)
  })

  it('a fresh interaction clears a stale error marker', () => {
    let map: CellEditMap = new Map()
    const key = cellKey('a', 'status')

    map = beginPendingEdit(map, key, 'pending')
    map = rejectEdit(map, key)
    expect(map.get(key)?.status).toBe('error')

    map = clearCellStatus(map, key)
    expect(map.has(key)).toBe(false)
    expect(canEditCell(map, key)).toBe(true)
  })
})

describe('applyCellMerge', () => {
  it('merges server-returned fields onto the row, server wins over optimistic value', () => {
    let items = rows()
    items = applyCellEdit(items, 0, 'status', 'accepted')
    const merged = applyCellMerge(items, 0, 'a', { status: 'declined' }, getItemId)
    expect(merged[0].status).toBe('declined')
  })

  it('accepts a full replacement row (backward-compatible with the sync T | void contract)', () => {
    const items = rows()
    const merged = applyCellMerge(items, 0, 'a', { id: 'a', status: 'declined' }, getItemId)
    expect(merged[0]).toEqual({ id: 'a', status: 'declined' })
  })

  it('is a no-op when the row at the index has moved on (id mismatch)', () => {
    const items = rows()
    const merged = applyCellMerge(items, 0, 'z', { status: 'declined' }, getItemId)
    expect(merged).toBe(items)
  })
})

describe('applyCellRollback', () => {
  it('is a no-op when the row at the index has moved on (id mismatch)', () => {
    const items = rows()
    const rolledBack = applyCellRollback(items, 0, 'status', 'pending', 'z', getItemId)
    expect(rolledBack).toBe(items)
  })
})
