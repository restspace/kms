// Hand-rolled pushState mini-router for the admin SPA (sweep item 12).
//
// The whole app lives on /app; every addressable piece of state is a query
// parameter, so a URL can be copied, bookmarked, reloaded and stepped through
// with the browser's Back button:
//
//   /app?v=workspace&ev=all&tab=submissions&rec=<id>&q=graph&flt=<b64>
//   /app?v=agenda&ev=<eventId>&mode=week&day=2026-05-12
//   /app?v=forms&form=<formId>&fstep=abstract
//
// Navigation intents (changing view / tab / record / form) push a history
// entry; parameter tweaks (event filter, search, filters, agenda mode/day,
// builder step) replace the current one, so Back never has to walk through a
// hundred keystrokes.
//
// Deliberately dependency-free and DOM-light: the parse/serialise half is pure
// and unit-tested in router.logic.test.ts; only `navigate`/`useRoute` touch
// window.

import { useEffect, useState } from 'react'

export const VIEW_KEYS = [
  'dashboard',
  'workspace',
  'forms',
  'evaluation',
  'review',
  'agenda',
  'greenroom',
  'pipeline',
  'embeds',
  'settings',
  'help',
] as const

export type ViewKey = (typeof VIEW_KEYS)[number]

export const DEFAULT_VIEW: ViewKey = 'dashboard'

/**
 * Sentinel `rec` value meaning "open the create form", not "load this
 * record". Consumed once the target tab's create action is registered (see
 * `registerSpeakerTabActions` in App.tsx), which then clears it from the URL
 * — the generic rec-restore effect must never try to fetch it as a real id.
 */
export const NEW_SPEAKER_REC = '__new__'

/**
 * Sentinel `taskRule` value meaning "open the automatic-task create form"
 * (see `AutomaticTaskRuleForm` in App.tsx) — the Settings → Automatic tasks
 * card's "+ Add" button. A real task id instead means "edit this rule".
 */
export const NEW_TASK_RULE = '__new__'

/** Every URL-addressable bit of app state. `null` means "not in the URL". */
export interface RouteState {
  /** Which top-level section is showing. */
  v: ViewKey
  /** Workspace event filter: 'all' or an event id. */
  ev: string
  /** Active workspace tab config key. */
  tab: string | null
  /** Selected workspace record id (opens its detail tab on restore). */
  rec: string | null
  /** Free-text search for the active workspace tab. */
  q: string | null
  /** Extra workspace filters, base64url of a stable JSON serialisation. */
  flt: Record<string, unknown> | null
  /** Agenda view mode ('day' | 'week' | …). */
  mode: string | null
  /** Agenda focused day (YYYY-MM-DD). */
  day: string | null
  /** Open form id in the Forms builder. */
  form: string | null
  /** Form-builder step key. */
  fstep: string | null
  /** Manual page slug shown by the Help section (defaults to its index). */
  page: string | null
  /**
   * Automatic-task rule id open in the Workspace → Tasks tab's rule editor
   * (see `AutomaticTaskRuleForm`), or `NEW_TASK_RULE` to create one. Set by
   * Settings → Automatic tasks' Add/Edit buttons; cleared (and `sec` set)
   * when the editor bounces back to Settings on Save or Cancel.
   */
  taskRule: string | null
  /**
   * Settings-page section anchor id to scroll to on load/return — set when
   * deep-linking into a Settings card, or when `taskRule`'s editor bounces
   * back. Consumed once by SettingsSection, then cleared.
   */
  sec: string | null
}

export type RoutePatch = Partial<RouteState>

export const DEFAULT_ROUTE: RouteState = {
  v: DEFAULT_VIEW,
  ev: 'all',
  tab: null,
  rec: null,
  q: null,
  flt: null,
  mode: null,
  day: null,
  form: null,
  fstep: null,
  page: null,
  taskRule: null,
  sec: null,
}

/**
 * Parameters whose change is a *navigation*: the user expects Back to undo it.
 * Everything else refines the current screen and replaces the entry.
 */
export const PUSH_KEYS: ReadonlyArray<keyof RouteState> = ['v', 'tab', 'rec', 'form', 'page', 'taskRule']

/** Custom event name fired after a programmatic navigation. */
const ROUTE_EVENT = 'kms:routechange'

// ---------------------------------------------------------------------------
// base64url helpers (unicode-safe, no Buffer, no DOM)
// ---------------------------------------------------------------------------

/** Stable JSON: object keys sorted, so equal filters give equal strings. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

export function encodeFilters(filters: Record<string, unknown> | null | undefined): string | null {
  if (!filters) return null
  const keys = Object.keys(filters).filter((k) => filters[k] !== undefined)
  if (keys.length === 0) return null
  // encodeURIComponent first keeps btoa within latin-1 for any unicode value.
  const b64 = btoa(encodeURIComponent(stableStringify(filters)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeFilters(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null
  try {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const parsed: unknown = JSON.parse(decodeURIComponent(atob(padded)))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    return Object.keys(record).length > 0 ? record : null
  } catch {
    // Hand-edited or truncated URLs must never crash the shell.
    return null
  }
}

// ---------------------------------------------------------------------------
// parse / serialise
// ---------------------------------------------------------------------------

const isViewKey = (value: string): value is ViewKey => (VIEW_KEYS as readonly string[]).includes(value)

const text = (params: URLSearchParams, key: string): string | null => {
  const raw = params.get(key)
  if (raw === null) return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Parse a `location.search` string (with or without the leading `?`). */
export function parseRoute(search: string | null | undefined): RouteState {
  const params = new URLSearchParams((search ?? '').replace(/^\?/, ''))
  const v = text(params, 'v')
  const ev = text(params, 'ev')
  return {
    v: v && isViewKey(v) ? v : DEFAULT_VIEW,
    ev: ev ?? 'all',
    tab: text(params, 'tab'),
    rec: text(params, 'rec'),
    q: text(params, 'q'),
    flt: decodeFilters(text(params, 'flt')),
    mode: text(params, 'mode'),
    day: text(params, 'day'),
    form: text(params, 'form'),
    fstep: text(params, 'fstep'),
    page: text(params, 'page'),
    taskRule: text(params, 'taskRule'),
    sec: text(params, 'sec'),
  }
}

/**
 * Serialise back to a `?a=b` string. Emission order is fixed so the same state
 * always produces byte-identical URLs (cheap change detection, stable history).
 */
export function routeToSearch(state: RouteState): string {
  const params = new URLSearchParams()
  params.set('v', isViewKey(state.v) ? state.v : DEFAULT_VIEW)
  params.set('ev', state.ev && state.ev.trim() ? state.ev.trim() : 'all')
  const optional: Array<[string, string | null]> = [
    ['tab', state.tab],
    ['rec', state.rec],
    ['q', state.q],
    ['flt', encodeFilters(state.flt)],
    ['mode', state.mode],
    ['day', state.day],
    ['form', state.form],
    ['fstep', state.fstep],
    ['page', state.page],
    ['taskRule', state.taskRule],
    ['sec', state.sec],
  ]
  for (const [key, value] of optional) {
    if (value !== null && value !== undefined && String(value).trim().length > 0) {
      params.set(key, String(value).trim())
    }
  }
  return `?${params.toString()}`
}

/** Merge a patch onto a route, normalising through parse/serialise. */
export function applyPatch(state: RouteState, patch: RoutePatch): RouteState {
  return parseRoute(routeToSearch({ ...state, ...patch }))
}

/**
 * Decision table for history mode. Pure so it can be unit-tested: a patch that
 * touches any navigation parameter pushes; everything else replaces. An
 * explicit `replace` always wins.
 */
export function shouldPush(patch: RoutePatch, options?: { replace?: boolean }): boolean {
  if (options?.replace) return false
  return Object.keys(patch).some((key) => PUSH_KEYS.includes(key as keyof RouteState))
}

// ---------------------------------------------------------------------------
// window-facing half
// ---------------------------------------------------------------------------

/** Current route read from the address bar (defaults outside the browser). */
export function currentRoute(): RouteState {
  if (typeof window === 'undefined') return { ...DEFAULT_ROUTE }
  return parseRoute(window.location.search)
}

/**
 * Apply a patch to the URL. Pushes a history entry for navigation intents and
 * replaces for parameter tweaks (override with `{ replace: true }`). A no-op
 * patch writes nothing, so repeated reports from sections stay free.
 */
export function navigate(patch: RoutePatch, options?: { replace?: boolean }): void {
  if (typeof window === 'undefined') return
  const next = applyPatch(currentRoute(), patch)
  const search = routeToSearch(next)
  if (search === window.location.search) return
  const url = `${window.location.pathname}${search}`
  if (shouldPush(patch, options)) window.history.pushState(null, '', url)
  else window.history.replaceState(null, '', url)
  window.dispatchEvent(new CustomEvent(ROUTE_EVENT))
}

/**
 * Subscribe to the address bar. useState + explicit subscription rather than
 * useSyncExternalStore, which preact/compat only partially implements.
 */
export function useRoute(): RouteState {
  const [route, setRoute] = useState<RouteState>(currentRoute)
  useEffect(() => {
    const sync = () => {
      const next = currentRoute()
      // Compare serialised form: parseRoute allocates a fresh object each call.
      setRoute((prev) => (routeToSearch(prev) === routeToSearch(next) ? prev : next))
    }
    window.addEventListener('popstate', sync)
    window.addEventListener(ROUTE_EVENT, sync)
    sync()
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener(ROUTE_EVENT, sync)
    }
  }, [])
  return route
}
