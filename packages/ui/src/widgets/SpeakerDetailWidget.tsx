import { useEffect, useState } from 'react'
import { fetchSpeakers, type PublicSpeaker } from '../publicData'
import { SpeakerAvatar } from './SpeakersWidget'
// Biographies can carry organiser/portal-authored HTML (the admin detail panel
// strips it the same way) — this page renders text nodes, so tags would show.
import { toParagraphs } from './richText'
import { fmtDayLong, fmtTimeRange } from './time'

export interface SpeakerDetailWidgetProps {
  eventSlug: string
  speakerId: string
}

/**
 * Bio + session list shared by the speaker detail page and the gallery's
 * detail modal (EMB-05/EMB-13), so the two surfaces never drift: bio through
 * `toParagraphs` (paragraphing preserved, markup stripped — same treatment
 * session descriptions get elsewhere), and each session shown with its
 * event-local date/time and room, not just a bare title.
 */
export function SpeakerDetailBody({ speaker, tz }: { speaker: PublicSpeaker; tz: string }) {
  const bioParagraphs = speaker.bio ? toParagraphs(speaker.bio) : []
  return (
    <>
      {bioParagraphs.length > 0 && (
        <div className="speaker-detail-bio">
          {bioParagraphs.map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
      )}
      {speaker.sessions.length > 0 && (
        <>
          <h3>Sessions</h3>
          <ul className="event-widget-list speaker-detail-sessions">
            {speaker.sessions.map((s) => (
              <li key={s.id}>
                <div className="speaker-detail-session-title">{s.title}</div>
                {s.starts_at && s.ends_at && s.day && (
                  <div className="muted speaker-detail-session-meta">
                    {fmtDayLong(s.day)} · {fmtTimeRange(s.starts_at, s.ends_at, tz)}
                    {s.room ? ` · ${s.room}` : ''}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

/**
 * Public speaker detail page (EMB-05): headshot, name, title/company, bio,
 * and this speaker's session list, with a link back to the directory.
 * Reuses /e/:slug/speakers.json (there is no per-speaker endpoint) and finds
 * the one row client-side.
 */
export function SpeakerDetailWidget({ eventSlug, speakerId }: SpeakerDetailWidgetProps) {
  const [speaker, setSpeaker] = useState<PublicSpeaker | null | undefined>(undefined)
  const [tz, setTz] = useState('UTC')

  useEffect(() => {
    let cancelled = false
    fetchSpeakers(eventSlug).then((data) => {
      if (cancelled) return
      setSpeaker(data?.speakers.find((s) => s.id === speakerId) ?? null)
      if (data?.event.timezone) setTz(data.event.timezone)
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
      <SpeakerDetailBody speaker={speaker} tz={tz} />
    </article>
  )
}

export const speakerDetailCss = `
.speaker-detail-back { display: inline-block; margin-bottom: 1rem; color: var(--text-muted); text-decoration: none; font-size: .9rem; }
.speaker-detail-back:hover { color: var(--text); }
.speaker-detail-head { display: flex; align-items: center; gap: 1.1rem; margin-bottom: 1rem; }
.speaker-detail-name { margin: 0 0 .2rem; }
.speaker-detail-bio { line-height: 1.6; margin: 1rem 0; }
.speaker-detail-bio p { margin: 0 0 .75rem; }
.speaker-detail-bio p:last-child { margin-bottom: 0; }
.speaker-detail-sessions li { padding: .6rem 0; }
.speaker-detail-session-title { font-weight: 600; }
.speaker-detail-session-meta { margin-top: .15rem; font-size: .85rem; }
`
