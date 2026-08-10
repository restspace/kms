import { useEffect, useMemo, useState } from 'react'
import { fetchSpeakers, type PublicSpeaker, type SpeakersFeed } from '../publicData'
import { SpeakerAvatar } from './SpeakersWidget'
import { SpeakerDetailBody, speakerDetailCss } from './SpeakerDetailWidget'

export interface GalleryWidgetProps {
  eventSlug: string
}

/**
 * Modal shown when a gallery tile is clicked (EMB-13): the same bio/session
 * body as SpeakerDetailWidget (`SpeakerDetailBody`, shared rather than
 * duplicated), layered over the gallery instead of navigating away from it.
 * Closes on Escape, backdrop click, or the close button; no route change, so
 * the grid's scroll position and search text survive.
 */
function SpeakerModal({ speaker, tz, onClose }: { speaker: PublicSpeaker; tz: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="gallery-modal-backdrop" onClick={onClose}>
      <div
        className="gallery-modal"
        role="dialog"
        aria-modal="true"
        aria-label={speaker.name}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="gallery-modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="speaker-detail-head">
          <SpeakerAvatar speaker={speaker} size={96} />
          <div>
            <h2 className="speaker-detail-name">{speaker.name}</h2>
            {(speaker.title || speaker.company) && (
              <p className="muted">{[speaker.title, speaker.company].filter(Boolean).join(' · ')}</p>
            )}
          </div>
        </div>
        <SpeakerDetailBody speaker={speaker} tz={tz} />
      </div>
    </div>
  )
}

/**
 * Public photo gallery (EMB-12: photo grid with name search and a
 * graceful photo-less fallback via SpeakerAvatar's initials tile; EMB-13:
 * clicking a tile opens a speaker-detail modal with a sessions sublist,
 * rather than navigating to /e/:slug/speakers/:id).
 */
export function GalleryWidget({ eventSlug }: GalleryWidgetProps) {
  const [feed, setFeed] = useState<SpeakersFeed | null | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [openSpeaker, setOpenSpeaker] = useState<PublicSpeaker | null>(null)

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

  if (feed === undefined) return <p className="muted">Loading gallery…</p>
  if (feed === null) return <p className="event-widget-empty">The speaker directory isn't published yet — check back soon.</p>
  if (feed.speakers.length === 0) return <p className="event-widget-empty">No photos are published yet.</p>

  return (
    <div className="gallery-widget">
      <style dangerouslySetInnerHTML={{ __html: galleryWidgetCss }} />
      <style dangerouslySetInnerHTML={{ __html: speakerDetailCss }} />
      <input
        type="search"
        className="speakers-search"
        placeholder="Search speakers by name…"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        aria-label="Search speakers by name"
      />
      {filtered.length === 0 ? (
        <p className="event-widget-empty">No speakers match “{query}”.</p>
      ) : (
        <ul className="gallery-grid">
          {filtered.map((s) => (
            <li key={s.id}>
              <button type="button" className="gallery-tile" onClick={() => setOpenSpeaker(s)}>
                <SpeakerAvatar speaker={s} size={120} />
                <span className="gallery-tile-name">{s.name}</span>
                {/* EMB-12: job title/company must show on the card itself, not only in the modal. */}
                {(s.title || s.company) && (
                  <span className="muted gallery-tile-role">{[s.title, s.company].filter(Boolean).join(' · ')}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {openSpeaker && (
        <SpeakerModal speaker={openSpeaker} tz={feed.event.timezone} onClose={() => setOpenSpeaker(null)} />
      )}
    </div>
  )
}

const galleryWidgetCss = `
.gallery-widget .speakers-search { width: 100%; max-width: 360px; padding: .5rem .75rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); font-size: .95rem; margin-bottom: .85rem; }
.gallery-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 1rem; }
.gallery-tile { display: flex; flex-direction: column; align-items: center; gap: .5rem; width: 100%; padding: .9rem .5rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); cursor: pointer; font: inherit; color: inherit; }
.gallery-tile:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.gallery-tile .speaker-avatar { border-radius: 999px; }
.gallery-tile-name { font-size: .9rem; text-align: center; }
.gallery-tile-role { font-size: .78rem; text-align: center; }
.gallery-modal-backdrop { position: fixed; inset: 0; background: color-mix(in srgb, black 55%, transparent); display: flex; align-items: center; justify-content: center; padding: 1.5rem; z-index: 100; }
.gallery-modal { position: relative; background: var(--surface); color: var(--text); border-radius: var(--radius); padding: 1.5rem; max-width: 480px; width: 100%; max-height: 85vh; overflow-y: auto; box-shadow: var(--shadow-overlay); }
.gallery-modal-close { position: absolute; top: .6rem; right: .6rem; width: 2rem; height: 2rem; border-radius: 999px; border: none; background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text); font-size: 1.2rem; line-height: 1; cursor: pointer; }
.gallery-modal-close:hover { background: color-mix(in srgb, var(--text) 14%, transparent); }
`
