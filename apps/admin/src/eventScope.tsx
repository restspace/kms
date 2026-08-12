import { createContext, useContext } from 'react'
import type { Me, MeEvent } from './api'
import { useRoute } from './router'

/**
 * Event scope (workspace redesign): the SPA holds *two* related notions of
 * "event" and one dropdown drives both.
 *
 *  - `filter`  — the workspace query dimension. `'all'` spans every event the
 *                signed-in staff email can reach; an id narrows to one. Lives
 *                in the URL (`?ev=`), never touches the session cookie.
 *  - `currentEvent` — the event the per-event surfaces (Forms, Evaluation,
 *                Agenda, Settings, and the Dashboard's three event boards)
 *                are bound to. That binding is
 *                server-side, in the session cookie, so changing it means
 *                awaiting `switchEvent`; the sections are remounted by key
 *                afterwards rather than reloading the page.
 *
 * Picking "All events" only moves the filter — the current event stays put, so
 * the per-event screens keep showing something coherent. That is exactly why
 * they carry an "Event: …" subtitle.
 */

export type EventFilter = 'all' | string

export interface EventScopeValue {
  me: Me
  /** Workspace filter: `'all'` or an accessible event id. */
  filter: EventFilter
  /** Event bound to the session cookie — what per-event surfaces show. */
  currentEventId: string
  currentEvent: MeEvent & { timezone: string }
  /** All events reachable by this staff email in the organisation. */
  events: MeEvent[]
  /** Move the filter (and, for a concrete event, the session's current event). */
  setFilter: (next: EventFilter) => void
  /** Re-read /app/api/me (after creating an event, for example). */
  refreshMe: () => Promise<void>
  /** True while a switchEvent round-trip is in flight. */
  switching: boolean
}

const EventScopeContext = createContext<EventScopeValue | null>(null)

export const EventScopeProvider = EventScopeContext.Provider

/** Throws outside a provider — every admin surface renders inside one. */
export function useEventScope(): EventScopeValue {
  const value = useContext(EventScopeContext)
  if (!value) throw new Error('useEventScope must be used inside <EventScopeProvider>')
  return value
}

/** Non-throwing variant for components that may render standalone in tests. */
export function useEventScopeOptional(): EventScopeValue | null {
  return useContext(EventScopeContext)
}

/** Label for a filter value, used by the sidebar and the tab-header chip. */
export function eventFilterLabel(scope: EventScopeValue): string {
  if (scope.filter === 'all') return 'All events'
  return scope.events.find((e) => e.id === scope.filter)?.name ?? scope.currentEvent.name
}

/**
 * The single event control in the sidebar. "All events" is always present, so
 * unlike the old switcher this is never disabled for a one-event organisation.
 */
export function EventFilterSelect({ scope }: { scope: EventScopeValue }) {
  const options = scope.events.length > 0 ? scope.events : [scope.currentEvent]
  return (
    <select
      aria-label="Event filter"
      value={scope.filter}
      disabled={scope.switching}
      onChange={(e) => scope.setFilter((e.target as HTMLSelectElement).value)}
    >
      <option value="all">All events</option>
      {options.map((e) => (
        <option key={e.id} value={e.id}>{e.name}</option>
      ))}
    </select>
  )
}

/** Compact read-out of the active filter, shown in the workspace tab header. */
export function EventFilterChip({ scope }: { scope: EventScopeValue }) {
  const isAll = scope.filter === 'all'
  return (
    <span
      className={`event-filter-chip ${isAll ? 'all' : ''}`}
      role="status"
      title={
        isAll
          ? 'Workspace tabs are showing every event you can access'
          : 'Workspace tabs are narrowed to this event'
      }
    >
      <span className="event-filter-chip-label">Event</span>
      {eventFilterLabel(scope)}
    </span>
  )
}

/**
 * "Event: <name>" line for the per-event surfaces, so it stays unambiguous
 * which event they show while the workspace filter says "All events".
 *
 * CRM-12: the Dashboard is no longer one of them — on "All events" it renders
 * the org-wide board and names the organisation in its own header, so the note
 * is suppressed there rather than captioning an org roll-up with one event's
 * name. Every other per-event surface (Forms, Evaluation, Embeds, Settings)
 * still gets it, and the hint now speaks for the screen it is attached to.
 */
export function EventScopeNote({ scope }: { scope: EventScopeValue }) {
  const route = useRoute()
  if (scope.filter === 'all' && route.v === 'dashboard') return null
  return (
    <div className="section-event-note">
      Event: <strong>{scope.currentEvent.name}</strong>
      {scope.filter === 'all' && (
        <span className="section-event-note-hint">
          — the workspace filter spans all events; this screen is bound to one, and shows the current one
        </span>
      )}
    </div>
  )
}
