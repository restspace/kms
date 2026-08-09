import { useEffect, useMemo, useState } from 'react'
import { fetchSpeakers, type PublicSpeaker, type SpeakersFeed } from '../publicData'

export interface SpeakersWidgetProps {
  eventSlug: string
}

/** "Ada Lovelace" -> "AL"; falls back to the first two letters if there's only one name part. */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]
  if (!first) return '?'
  if (parts.length === 1) return first.slice(0, 2).toUpperCase()
  const last = parts[parts.length - 1] ?? first
  return (first.charAt(0) + last.charAt(0)).toUpperCase()
}

/** Headshot when one loads, an initials tile otherwise — shared by the directory, detail, and gallery widgets. */
export function SpeakerAvatar({
  speaker,
  size = 72,
}: {
  speaker: Pick<PublicSpeaker, 'name' | 'headshot_url'>
  size?: number
}) {
  const [broken, setBroken] = useState(false)
  const style = { width: size, height: size }
  if (speaker.headshot_url && !broken) {
    return (
      <img
        className="speaker-avatar"
        style={style}
        src={speaker.headshot_url}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
      />
    )
  }
  return (
    <div className="speaker-avatar speaker-avatar-fallback" style={style} aria-hidden="true">
      {initialsFor(speaker.name)}
    </div>
  )
}

/**
 * Public speaker directory (EMB-04: surname-alphabetical card grid — the
 * feed already arrives sorted that way, see landing.tsx's speakers.json
 * handler — with headshot/name/title/company; EMB-05: client-side name
 * search). Each card links through to /e/:slug/speakers/:id
 * (SpeakerDetailWidget).
 */
export function SpeakersWidget({ eventSlug }: SpeakersWidgetProps) {
  const [feed, setFeed] = useState<SpeakersFeed | null | undefined>(undefined)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchSpeakers(eventSlug).then((data) => {
      if (!cancelled) setFeed(data)
    })
    return () => {
      cancelled = true
    }
  }, [eventSlug])

  const filtered = useMemo(() => {
    if (!feed) return []
    const q = query.trim().toLowerCase()
    if (!q) return feed.speakers
    return feed.speakers.filter((s) => s.name.toLowerCase().includes(q))
  }, [feed, query])

  if (feed === undefined) return <p className="muted">Loading speakers…</p>
  if (feed === null) return <p className="event-widget-empty">The speaker directory isn't published yet — check back soon.</p>
  if (feed.speakers.length === 0) return <p className="event-widget-empty">No speakers are published yet.</p>

  return (
    <div className="speakers-widget">
      <style dangerouslySetInnerHTML={{ __html: speakersWidgetCss }} />
      <input
        type="search"
        className="speakers-search"
        placeholder="Search speakers by name…"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        aria-label="Search speakers by name"
      />
      <p className="muted speakers-count">
        {filtered.length} speaker{filtered.length === 1 ? '' : 's'}
      </p>
      {filtered.length === 0 ? (
        <p className="event-widget-empty">No speakers match “{query}”.</p>
      ) : (
        <ul className="speakers-grid">
          {filtered.map((s) => (
            <li key={s.id} className="speaker-card">
              <a className="speaker-card-link" href={`/e/${eventSlug}/speakers/${s.id}`}>
                <SpeakerAvatar speaker={s} />
                <div className="speaker-card-body">
                  <strong className="speaker-card-name">{s.name}</strong>
                  {(s.title || s.company) && (
                    <span className="muted speaker-card-role">{[s.title, s.company].filter(Boolean).join(' · ')}</span>
                  )}
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const speakersWidgetCss = `
.speakers-search { width: 100%; max-width: 360px; padding: .5rem .75rem; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font-size: .95rem; margin-bottom: .5rem; }
.speakers-count { margin: 0 0 .75rem; font-size: .85rem; }
.speakers-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: .85rem; }
.speaker-card { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.speaker-card-link { display: flex; align-items: center; gap: .75rem; padding: .85rem; color: inherit; text-decoration: none; }
.speaker-card-link:hover { background: color-mix(in srgb, var(--fg) 5%, transparent); }
.speaker-avatar { border-radius: 999px; object-fit: cover; flex-shrink: 0; }
.speaker-avatar-fallback { display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); font-weight: 600; font-size: .95rem; }
.speaker-card-body { display: flex; flex-direction: column; gap: .2rem; min-width: 0; }
.speaker-card-name { font-size: 1rem; }
.speaker-card-role { font-size: .82rem; }
`
