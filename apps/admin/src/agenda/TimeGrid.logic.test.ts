// Overlap/lane assignment for the Day/Week time grid (docs/07 §2), ported
// from packages/ui/src/widgets/AgendaWidget.tsx's `assignLanes`. Before this,
// TimeGrid.tsx rendered every session in a column at the CSS default
// `left:3px; right:3px` (full width), so two sessions double-booked into the
// same room/slot rendered fully stacked — the later one covering the
// earlier one's title entirely.

import { describe, expect, it } from 'vitest'
import type { AgendaSessionRow } from '../api'
import { assignLanes, type LanedSession } from './TimeGrid'

const laned = (id: string, startMin: number, endMin: number): LanedSession => ({
  session: { id } as AgendaSessionRow,
  startMin,
  endMin,
  lane: 0,
  lanes: 1,
})

describe('assignLanes', () => {
  it('leaves non-overlapping sessions in a single, full-width lane', () => {
    const items = [laned('a', 0, 30), laned('b', 30, 60), laned('c', 60, 90)]
    assignLanes(items)
    for (const item of items) {
      expect(item.lane).toBe(0)
      expect(item.lanes).toBe(1)
    }
  })

  it('splits two overlapping sessions into side-by-side lanes', () => {
    const items = [laned('a', 0, 60), laned('b', 30, 90)]
    assignLanes(items)
    expect(items[0]).toMatchObject({ lane: 0, lanes: 2 })
    expect(items[1]).toMatchObject({ lane: 1, lanes: 2 })
  })

  it('gives an entire transitively-overlapping cluster the same lane count', () => {
    // a: 0-60, b: 30-90, c: 80-120 — a/b overlap, b/c overlap, a/c do not.
    // All three still belong to one cluster (chained by b) and so share its
    // lane count — here 2, the most that are ever concurrent at once — even
    // though a and c themselves never overlap.
    const items = [laned('a', 0, 60), laned('b', 30, 90), laned('c', 80, 120)]
    assignLanes(items)
    expect(items.map((i) => i.lanes)).toEqual([2, 2, 2])
    // b sits between a and c in time, so it must land in a different lane
    // from both — a and c are free to share a lane since they never overlap.
    expect(items[1].lane).not.toBe(items[0].lane)
    expect(items[1].lane).not.toBe(items[2].lane)
  })

  it('reuses a freed lane once its previous occupant ends', () => {
    // a: 0-30, b: 0-60 overlap a, c: 40-70 only overlaps b — c should reuse
    // a's lane (freed at 30) rather than opening a third.
    const items = [laned('a', 0, 30), laned('b', 0, 60), laned('c', 40, 70)]
    assignLanes(items)
    const byId = Object.fromEntries(items.map((i) => [i.session.id, i]))
    expect(byId.a.lane).toBe(0)
    expect(byId.b.lane).toBe(1)
    expect(byId.c.lane).toBe(0)
    expect(byId.a.lanes).toBe(2)
    expect(byId.c.lanes).toBe(2)
  })

  it('treats back-to-back (touching, not overlapping) sessions as separate clusters at full width', () => {
    const items = [laned('a', 0, 30), laned('b', 30, 60)]
    assignLanes(items)
    expect(items[0]).toMatchObject({ lane: 0, lanes: 1 })
    expect(items[1]).toMatchObject({ lane: 0, lanes: 1 })
  })
})
