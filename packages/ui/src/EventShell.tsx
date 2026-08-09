import type { ReactNode } from 'react'

export interface EventShellNavItem {
  key: 'sessions' | 'speakers' | 'agenda' | 'schedule' | 'gallery'
  label: string
  href: string
}

const NAV_ITEMS: EventShellNavItem[] = [
  { key: 'sessions', label: 'Sessions', href: 'sessions' },
  { key: 'speakers', label: 'Speakers', href: 'speakers' },
  { key: 'agenda', label: 'Agenda', href: 'agenda' },
  { key: 'schedule', label: 'Schedule', href: 'schedule' },
  { key: 'gallery', label: 'Gallery', href: 'gallery' },
]

export interface EventShellProps {
  eventName: string
  eventSlug: string
  /** Which nav tab is current; omit on pages that don't belong to the nav (e.g. a speaker detail page still highlights 'speakers'). */
  active?: EventShellNavItem['key']
  /**
   * Optional secondary row under the header — day tabs on the agenda/schedule
   * pages, filters on sessions/speakers. Left to each widget: the shell only
   * reserves the slot so widgets don't need to reimplement the header.
   */
  subnav?: ReactNode
  /**
   * Embed mode (lane W3-A): drop the event name + tab strip and render only
   * the widget, so an <iframe> on someone else's site doesn't repeat a header
   * their own page already has. Additive and optional — the standalone public
   * pages never pass it.
   */
  hideHeader?: boolean
  children: ReactNode
}

/**
 * Shared chrome for every public event page (docs: W2-D1 foundation lane).
 * Deliberately thin — event name, a tab strip across the five widget pages,
 * a subnav slot, and a content region. Widget lanes own everything inside
 * `children`; nothing here should need to change for a widget to ship.
 */
export function EventShell({ eventName, eventSlug, active, subnav, hideHeader, children }: EventShellProps) {
  const base = `/e/${eventSlug}/`
  if (hideHeader) {
    return (
      <div className="event-shell event-shell-bare">
        {subnav && <div className="event-shell-subnav">{subnav}</div>}
        <main className="event-shell-main">{children}</main>
      </div>
    )
  }
  return (
    <div className="event-shell">
      <header className="event-shell-header">
        <p className="muted event-shell-eyebrow">Event</p>
        <h1>{eventName}</h1>
        <nav className="event-shell-nav" aria-label="Event sections">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.key}
              href={base + item.href}
              className={item.key === active ? 'event-shell-nav-active' : undefined}
              aria-current={item.key === active ? 'page' : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
        {subnav && <div className="event-shell-subnav">{subnav}</div>}
      </header>
      <main className="event-shell-main">{children}</main>
    </div>
  )
}

/** Appended to Page's baseCss for event pages only (kept separate so the CFP wizard bundle doesn't ship it). */
export const eventShellCss = `
.event-shell-header { border-bottom: 1px solid var(--line); padding-bottom: 1rem; margin-bottom: 1.5rem; }
.event-shell-eyebrow { margin: 0 0 .15rem; text-transform: uppercase; letter-spacing: .06em; font-size: .75rem; }
.event-shell-header h1 { margin-bottom: .75rem; }
.event-shell-nav { display: flex; flex-wrap: wrap; gap: .25rem; }
.event-shell-nav a { padding: .4rem .8rem; border-radius: 8px; color: var(--muted); text-decoration: none; font-size: .92rem; }
.event-shell-nav a:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 6%, transparent); }
.event-shell-nav a.event-shell-nav-active { color: var(--accent); font-weight: 600; background: color-mix(in srgb, var(--accent) 12%, transparent); }
.event-shell-subnav { margin-top: .75rem; }
.event-shell-bare .event-shell-subnav { margin-top: 0; margin-bottom: .75rem; }
.event-shell-main { min-height: 40vh; }
.event-widget-list { list-style: none; margin: 0; padding: 0; }
.event-widget-list li { padding: .85rem 0; border-bottom: 1px solid var(--line); }
.event-widget-list li:last-child { border-bottom: none; }
.event-widget-empty { color: var(--muted); }
`
