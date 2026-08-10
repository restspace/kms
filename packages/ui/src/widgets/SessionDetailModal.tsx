import { useEffect } from 'react'
import type { PublicRoom, PublicSession, PublicTrack } from '../publicData'
import { toParagraphs } from './richText'
import { fmtDayLong, fmtTimeRange } from './time'

/**
 * Session drill-down (EMB-01): the sessions list and the schedule itinerary
 * both render session cards with a truncated description and no way to open
 * the full thing short of the agenda grid. This modal is the shared
 * "session detail" surface for both — full description, speakers,
 * date/time and room — built the same way GalleryWidget's speaker modal
 * shares `SpeakerDetailBody` with SpeakerDetailWidget: one component, two
 * callers, so the two surfaces can't drift.
 */
export function SessionDetailModal({
  session,
  roomName,
  trackName,
  tz,
  onClose,
}: {
  session: PublicSession
  roomName: string | null
  trackName: string | null
  tz: string
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const descriptionParagraphs = session.description ? toParagraphs(session.description) : []
  const speakers = session.speaker_details.length > 0 ? session.speaker_details : null

  return (
    <div className="session-modal-backdrop" onClick={onClose}>
      <style dangerouslySetInnerHTML={{ __html: sessionModalCss }} />
      <div
        className="session-modal"
        role="dialog"
        aria-modal="true"
        aria-label={session.title}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="session-modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h2 className="session-modal-title">{session.title}</h2>
        <p className="muted session-modal-meta">
          {fmtDayLong(session.day)} · {fmtTimeRange(session.starts_at, session.ends_at, tz)}
          {roomName ? ` · ${roomName}` : ''}
        </p>
        {(session.format || trackName) && (
          <p className="muted session-modal-tags">
            {[session.format, trackName].filter(Boolean).join(' · ')}
          </p>
        )}
        {descriptionParagraphs.length > 0 ? (
          <div className="session-modal-desc">
            {descriptionParagraphs.map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
        ) : (
          <p className="muted">No description provided.</p>
        )}
        {speakers ? (
          <>
            <h3>{speakers.length === 1 ? 'Speaker' : 'Speakers'}</h3>
            <ul className="event-widget-list session-modal-speakers">
              {speakers.map((sp) => (
                <li key={sp.id}>
                  <div className="session-modal-speaker-name">{sp.name}</div>
                  {(sp.title || sp.company) && (
                    <div className="muted session-modal-speaker-role">
                      {[sp.title, sp.company].filter(Boolean).join(' · ')}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        ) : (
          session.speakers.length > 0 && (
            <>
              <h3>{session.speakers.length === 1 ? 'Speaker' : 'Speakers'}</h3>
              <p>{session.speakers.join(', ')}</p>
            </>
          )
        )}
      </div>
    </div>
  )
}

/** Resolve a session's room/track display names from the feed's lookup tables. */
export function roomAndTrackNames(
  session: PublicSession,
  rooms: Map<string, PublicRoom>,
  tracks: Map<string, PublicTrack>,
): { roomName: string | null; trackName: string | null } {
  return {
    roomName: session.room_id ? rooms.get(session.room_id)?.name ?? null : null,
    trackName: session.track_id ? tracks.get(session.track_id)?.name ?? null : null,
  }
}

const sessionModalCss = `
.session-modal-backdrop { position: fixed; inset: 0; background: color-mix(in srgb, black 55%, transparent); display: flex; align-items: center; justify-content: center; padding: 1.5rem; z-index: 100; }
.session-modal { position: relative; background: var(--bg); color: var(--fg); border-radius: 12px; padding: 1.5rem; max-width: 560px; width: 100%; max-height: 85vh; overflow-y: auto; box-shadow: 0 12px 40px rgba(0,0,0,.3); }
.session-modal-close { position: absolute; top: .6rem; right: .6rem; width: 2rem; height: 2rem; border-radius: 999px; border: none; background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg); font-size: 1.2rem; line-height: 1; cursor: pointer; }
.session-modal-close:hover { background: color-mix(in srgb, var(--fg) 14%, transparent); }
.session-modal-title { margin: 0 .5rem .3rem 0; font-size: 1.3rem; }
.session-modal-meta { margin: 0 0 .25rem; font-size: .9rem; }
.session-modal-tags { margin: 0 0 .75rem; font-size: .85rem; }
.session-modal-desc { line-height: 1.6; margin: .75rem 0; }
.session-modal-desc p { margin: 0 0 .75rem; }
.session-modal-desc p:last-child { margin-bottom: 0; }
.session-modal-speakers li { padding: .5rem 0; }
.session-modal-speaker-name { font-weight: 600; }
.session-modal-speaker-role { margin-top: .1rem; font-size: .85rem; }
`
