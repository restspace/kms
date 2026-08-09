import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROUTE,
  PUSH_KEYS,
  applyPatch,
  decodeFilters,
  encodeFilters,
  parseRoute,
  routeToSearch,
  shouldPush,
  stableStringify,
  type RouteState,
} from './router'

/**
 * Pure half of the mini-router (sweep item 12). Runs in the `unit` project —
 * no DOM, no history, just parse/serialise and the push-vs-replace table.
 */

describe('parseRoute', () => {
  it('returns defaults for an empty search', () => {
    expect(parseRoute('')).toEqual(DEFAULT_ROUTE)
    expect(parseRoute('?')).toEqual(DEFAULT_ROUTE)
    expect(parseRoute(null)).toEqual(DEFAULT_ROUTE)
    expect(parseRoute(undefined)).toEqual(DEFAULT_ROUTE)
  })

  it('accepts a search string with or without the leading ?', () => {
    expect(parseRoute('?v=agenda').v).toBe('agenda')
    expect(parseRoute('v=agenda').v).toBe('agenda')
  })

  it('falls back to the default view for an unknown v', () => {
    expect(parseRoute('?v=wat').v).toBe('dashboard')
    expect(parseRoute('?v=').v).toBe('dashboard')
    expect(parseRoute('?v=%20%20').v).toBe('dashboard')
  })

  it('defaults ev to all and keeps a concrete event id', () => {
    expect(parseRoute('').ev).toBe('all')
    expect(parseRoute('?ev=evt_123').ev).toBe('evt_123')
  })

  it('treats blank optional params as absent', () => {
    const route = parseRoute('?tab=&rec=&q=&mode=&day=&form=&fstep=')
    expect(route.tab).toBeNull()
    expect(route.rec).toBeNull()
    expect(route.q).toBeNull()
    expect(route.mode).toBeNull()
    expect(route.day).toBeNull()
    expect(route.form).toBeNull()
    expect(route.fstep).toBeNull()
  })

  it('never throws on junk input', () => {
    for (const junk of ['?%%%', '?flt=@@@@', '?a=1&a=2&&&=x', '?flt=' + 'z'.repeat(50), '?v=1&ev=&tab=%E2']) {
      expect(() => parseRoute(junk)).not.toThrow()
    }
    expect(parseRoute('?flt=@@@@').flt).toBeNull()
  })
})

describe('flt encoding', () => {
  it('round-trips a filter object', () => {
    const filters = { status: 'accepted', track_id: 'trk_1', overdue: true, n: 3 }
    const token = encodeFilters(filters)
    expect(token).toBeTruthy()
    expect(decodeFilters(token)).toEqual(filters)
  })

  it('produces base64url — no +, / or = padding', () => {
    const token = encodeFilters({ q: '???>>>~~~ ünïcode ✓', other: 'a/b+c' })
    expect(token).not.toMatch(/[+/=]/)
    expect(decodeFilters(token)).toEqual({ q: '???>>>~~~ ünïcode ✓', other: 'a/b+c' })
  })

  it('encodes stably regardless of key order', () => {
    expect(encodeFilters({ a: 1, b: 2 })).toBe(encodeFilters({ b: 2, a: 1 }))
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  })

  it('treats empty and missing filters as absent', () => {
    expect(encodeFilters(null)).toBeNull()
    expect(encodeFilters(undefined)).toBeNull()
    expect(encodeFilters({})).toBeNull()
    expect(decodeFilters(null)).toBeNull()
    expect(decodeFilters('')).toBeNull()
  })

  it('rejects malformed or non-object payloads', () => {
    expect(decodeFilters('not-base64!!')).toBeNull()
    expect(decodeFilters(encodeFilters({ a: 1 })!.slice(0, 3))).toBeNull()
    // A valid base64url encoding of a JSON array is still not a filter map.
    const arrayToken = btoa(encodeURIComponent('[1,2]')).replace(/=+$/, '')
    expect(decodeFilters(arrayToken)).toBeNull()
  })
})

describe('routeToSearch', () => {
  it('always emits v and ev and omits empty optionals', () => {
    expect(routeToSearch(DEFAULT_ROUTE)).toBe('?v=dashboard&ev=all')
  })

  it('emits parameters in a stable order', () => {
    const state: RouteState = {
      ...DEFAULT_ROUTE,
      v: 'workspace',
      ev: 'evt_1',
      tab: 'submissions',
      rec: 'sub_9',
      q: 'graph',
    }
    expect(routeToSearch(state)).toBe('?v=workspace&ev=evt_1&tab=submissions&rec=sub_9&q=graph')
  })

  it('normalises a blank ev back to all and an unknown view to the default', () => {
    expect(routeToSearch({ ...DEFAULT_ROUTE, ev: '   ' })).toBe('?v=dashboard&ev=all')
    expect(routeToSearch({ ...DEFAULT_ROUTE, v: 'nope' as RouteState['v'] })).toBe('?v=dashboard&ev=all')
  })
})

describe('parse/serialise round-trips', () => {
  const cases: RouteState[] = [
    DEFAULT_ROUTE,
    { ...DEFAULT_ROUTE, v: 'workspace', tab: 'speakers' },
    { ...DEFAULT_ROUTE, v: 'agenda', ev: 'evt_42', mode: 'week', day: '2026-05-12' },
    { ...DEFAULT_ROUTE, v: 'forms', form: 'frm_7', fstep: 'abstract' },
    {
      v: 'workspace',
      ev: 'evt_42',
      tab: 'submissions',
      rec: 'sub_1',
      q: 'a b & c=d',
      flt: { status: 'accept_queue', track_id: 't1' },
      mode: 'day',
      day: '2026-05-12',
      form: 'frm_1',
      fstep: 'settings',
    },
  ]

  it('survives state → search → state for every parameter', () => {
    for (const state of cases) {
      expect(parseRoute(routeToSearch(state))).toEqual(state)
    }
  })

  it('is idempotent at the string level', () => {
    for (const state of cases) {
      const once = routeToSearch(state)
      expect(routeToSearch(parseRoute(once))).toBe(once)
    }
  })
})

describe('applyPatch', () => {
  it('merges and normalises', () => {
    const next = applyPatch(DEFAULT_ROUTE, { v: 'workspace', tab: 'tasks' })
    expect(next.v).toBe('workspace')
    expect(next.tab).toBe('tasks')
    expect(next.ev).toBe('all')
  })

  it('clears a parameter with null', () => {
    const start = applyPatch(DEFAULT_ROUTE, { tab: 'tasks', rec: 'r1' })
    expect(applyPatch(start, { rec: null }).rec).toBeNull()
  })
})

describe('shouldPush decision table', () => {
  const table: Array<[string, Parameters<typeof shouldPush>[0], Parameters<typeof shouldPush>[1], boolean]> = [
    ['view change pushes', { v: 'agenda' }, undefined, true],
    ['tab change pushes', { tab: 'tasks' }, undefined, true],
    ['record change pushes', { rec: 'r1' }, undefined, true],
    ['form change pushes', { form: 'f1' }, undefined, true],
    ['event filter replaces', { ev: 'evt_1' }, undefined, false],
    ['search replaces', { q: 'abc' }, undefined, false],
    ['filters replace', { flt: { status: 'pending' } }, undefined, false],
    ['agenda mode replaces', { mode: 'week' }, undefined, false],
    ['agenda day replaces', { day: '2026-05-12' }, undefined, false],
    ['builder step replaces', { fstep: 'welcome' }, undefined, false],
    ['empty patch replaces', {}, undefined, false],
    ['mixed patch pushes on the navigation key', { v: 'workspace', q: 'x' }, undefined, true],
    ['explicit replace always wins', { v: 'workspace' }, { replace: true }, false],
  ]

  it.each(table)('%s', (_label, patch, options, expected) => {
    expect(shouldPush(patch, options)).toBe(expected)
  })

  it('lists exactly the navigation parameters', () => {
    expect([...PUSH_KEYS]).toEqual(['v', 'tab', 'rec', 'form'])
  })
})
