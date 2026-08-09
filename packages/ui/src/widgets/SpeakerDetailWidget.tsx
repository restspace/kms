import { useEffect, useState } from 'react'
import { fetchSpeakers, type PublicSpeaker } from '../publicData'
import { SpeakerAvatar } from './SpeakersWidget'

export interface SpeakerDetailWidgetProps {
  eventSlug: string
  speakerId: string
}

/**
 * Public speaker detail page (EMB-05): headshot, name, title/company, bio,
 * and this speaker's session list, with a link back to the directory.
 * Reuses /e/:slug/speakers.json (there is no per-speaker endpoint) and finds
 * the one row client-side. Exported so GalleryWidget can render the same
 * body inside its detail modal (EMB-13) without duplicating markup.
 */
export function SpeakerDetailWidget({ eventSlug, speakerId }: SpeakerDetailWidgetProps) {
  const [speaker, setSpeaker] = useState<PublicSpeaker | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    fetchSpeakers(eventSlug).then((data) => {
      if (cancelled) return
      setSpeaker(data?.speakers.find((s) => s.id === speakerId) ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [eventSlug, speakerId])

  if (speaker === undefined) return <p className="muted">Loading speaker…</p>
  if (speaker === null) return <p className="event-widget-empty">Speaker not found.</p>

  return (
    <article className="speaker-detail">
      <style dangerouslySetInnerHTML={{ __html: speakerDetailCss }} />
      <a className="speaker-detail-back" href={`/e/${eventSlug}/speakers`}>
        ← Back to speakers
      </a>
      <div className="speaker-detail-head">
        <SpeakerAvatar speaker={speaker} size={104} />
        <div>
          <h2 className="speaker-detail-name">{speaker.name}</h2>
          {(speaker.title || speaker.company) && (
            <p className="muted">{[speaker.title, speaker.company].filter(Boolean).join(' · ')}</p>
          )}
        </div>
      </div>
      {speaker.bio && <p className="speaker-detail-bio">{speaker.bio}</p>}
      {speaker.sessions.length > 0 && (
        <>
          <h3>Sessions</h3>
          <ul className="event-widget-list">
            {speaker.sessions.map((s) => (
              <li key={s.id}>{s.title}</li>
            ))}
          </ul>
        </>
      )}
    </article>
  )
}

const speakerDetailCss = `
.speaker-detail-back { display: inline-block; margin-bottom: 1rem; color: var(--muted); text-decoration: none; font-size: .9rem; }
.speaker-detail-back:hover { color: var(--fg); }
.speaker-detail-head { display: flex; align-items: center; gap: 1.1rem; margin-bottom: 1rem; }
.speaker-detail-name { margin: 0 0 .2rem; }
.speaker-detail-bio { line-height: 1.6; margin: 1rem 0; }
`
