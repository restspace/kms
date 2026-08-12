import { useEffect, useMemo, useState } from 'react'
import type { Me } from '../api'
import { embedDataAttrs, embedPageParams, type EmbedFieldToggles, type EmbedThemeInput } from './embedOptions.logic'
import './embeds.css'

/**
 * Embeds (rubric EMB-15) — a pure *generator*. Nothing on this screen is
 * persisted: an organiser picks a public surface, an output format and a few
 * options, and leaves with a snippet or a URL they paste into their own site.
 * Every option travels in the URL, so the same choice works from a CMS, a
 * newsletter or a calendar client with no server-side embed records to manage.
 *
 * The five widgets are the five public pages (apps/api/src/routes/landing.tsx);
 * the loader script is GET /embed.js and the feeds are agenda.json /
 * sessions.json / speakers.json / agenda.xml / sessions.xml / agenda.ics /
 * sessions.ics — sessions.* mirror the agenda.* payload under a URL that
 * says what the "Sessions list" widget actually is (EMB-15).
 */

type WidgetKey = 'sessions' | 'speakers' | 'agenda' | 'schedule' | 'gallery'
type FormatKey = 'script' | 'iframe' | 'json' | 'xml' | 'ics'

interface WidgetDef {
  key: WidgetKey
  label: string
  blurb: string
  /** Does the underlying page honour ?track= / ?day=? */
  filterable: boolean
  /** Which feed formats make sense for this surface. */
  feeds: FormatKey[]
}

const WIDGETS: WidgetDef[] = [
  {
    key: 'sessions',
    label: 'Sessions list',
    blurb: 'Searchable card grid of every published session, with track/format/room facets.',
    filterable: true,
    feeds: ['json', 'xml', 'ics'],
  },
  {
    key: 'speakers',
    label: 'Speakers list',
    blurb: 'The speaker directory — name, role, company, bio and their sessions.',
    filterable: false,
    feeds: ['json'],
  },
  {
    key: 'agenda',
    label: 'Agenda grid',
    blurb: 'Room-by-time grid for one day, with a detail panel per session.',
    filterable: true,
    feeds: ['json', 'xml', 'ics'],
  },
  {
    key: 'schedule',
    label: 'Schedule itinerary',
    blurb: 'Chronological day-by-day list with personal starring and .ics export.',
    filterable: true,
    feeds: ['json', 'xml', 'ics'],
  },
  {
    key: 'gallery',
    label: 'Speaker gallery',
    blurb: 'Headshot grid of the published speakers.',
    filterable: false,
    feeds: ['json'],
  },
]

const FORMATS: { key: FormatKey; label: string; blurb: string }[] = [
  { key: 'script', label: 'Styled embed (<script>)', blurb: 'One tag. Injects a responsive iframe that auto-sizes to its content.' },
  { key: 'iframe', label: 'Basic HTML (link + iframe)', blurb: 'Plain markup for CMSes that strip <script> tags.' },
  { key: 'json', label: 'JSON feed URL', blurb: 'The raw feed this page reads. Cacheable, CORS-free same-origin.' },
  { key: 'xml', label: 'XML feed URL', blurb: 'The same agenda as a well-formed XML document.' },
  { key: 'ics', label: 'iCal (.ics) URL', blurb: 'Subscribe/download the published agenda as a calendar.' },
]

const ALL = ''

interface FeedTrack {
  id: string
  name: string
}

/** Escape a value for an HTML attribute in the generated snippet. */
function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Readable URL form of a track name (eval defect: generated links carried the
 * opaque track UUID). Must stay in step with packages/ui trackSlug and
 * routes/embed.ts, which accept slug, name or UUID on the read side — old
 * UUID links keep working, new ones say what they filter.
 */
function trackSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function EmbedsSection({ me }: { me: Me }) {
  const slug = me.event.slug
  const origin = typeof window === 'undefined' ? '' : window.location.origin

/**
 * Prefill for the accent override picker. `<input type="color">` needs a
 * literal hex so this cannot read --accent, but it must stay in step with it:
 * an embed that does not override the accent inherits this exact value from
 * the token layer, so the picker should open showing what is already applied.
 */
const DEFAULT_EMBED_ACCENT = '#2c4a73'

/** Prefill for the muted-colour override picker — the token layer's --text-muted. */
const DEFAULT_EMBED_MUTED = '#6b6259'


  const [widget, setWidget] = useState<WidgetKey>('agenda')
  const [format, setFormat] = useState<FormatKey>('script')
  const [accent, setAccent] = useState(DEFAULT_EMBED_ACCENT)
  const [useAccent, setUseAccent] = useState(false)
  const [showHeader, setShowHeader] = useState(false)
  const [track, setTrack] = useState(ALL)
  const [day, setDay] = useState(ALL)
  const [height, setHeight] = useState('600')
  const [copied, setCopied] = useState<string | null>(null)

  // Content field-visibility toggles (workplan 14, F3/D6): default shown,
  // same as the public page itself when no ?show_*= is present at all.
  const [showAbstract, setShowAbstract] = useState(true)
  const [showSpeakers, setShowSpeakers] = useState(true)
  const [showRoom, setShowRoom] = useState(true)
  const [showTrack, setShowTrack] = useState(true)

  // Theme tokens (F3/D5) — a fixed allowlist, not free-form CSS. '' means "no
  // override", matching what the SSR validator (parsePageOptions) treats as
  // absent.
  const [font, setFont] = useState<EmbedThemeInput['font']>('')
  const [radius, setRadius] = useState('')
  const [spacing, setSpacing] = useState<EmbedThemeInput['spacing']>('')
  const [useMuted, setUseMuted] = useState(false)
  const [muted, setMuted] = useState(DEFAULT_EMBED_MUTED)

  // Track/day choices come from the public feed itself, so the picker can only
  // ever offer filters the published agenda actually contains.
  const [tracks, setTracks] = useState<FeedTrack[]>([])
  const [days, setDays] = useState<string[]>([])
  const [feedState, setFeedState] = useState<'loading' | 'ready' | 'unpublished'>('loading')

  useEffect(() => {
    let cancelled = false
    setFeedState('loading')
    fetch(`/e/${encodeURIComponent(slug)}/agenda.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { tracks?: FeedTrack[]; days?: string[] } | null) => {
        if (cancelled) return
        if (!data) {
          setFeedState('unpublished')
          return
        }
        setTracks(data.tracks ?? [])
        setDays(data.days ?? [])
        setFeedState('ready')
      })
      .catch(() => {
        if (!cancelled) setFeedState('unpublished')
      })
    return () => {
      cancelled = true
    }
  }, [slug])

  const def = WIDGETS.find((w) => w.key === widget) as WidgetDef
  const filterable = def.filterable

  // A format that doesn't apply to the chosen widget falls back to the embed.
  useEffect(() => {
    if (format === 'script' || format === 'iframe') return
    if (!def.feeds.includes(format)) setFormat('script')
  }, [widget, format, def])

  const effTrack = filterable ? track : ALL
  const effDay = filterable ? day : ALL

  const toggles: EmbedFieldToggles = { showAbstract, showSpeakers, showRoom, showTrack }
  const theme: EmbedThemeInput = { font, radius, spacing, useMuted, muted }

  /**
   * Query string for the public page (?embed / header / accent / filters /
   * field-visibility toggles / theme tokens) — one builder (embedOptions.logic)
   * shared with the <script> snippet below, so the two cannot express the
   * same choice two different ways (the EMB-15 defect this pattern already
   * fixed for track/day).
   */
  const pageQuery = useMemo(() => {
    const s = embedPageParams({ format, showHeader, useAccent, accent, track: effTrack, day: effDay, toggles, theme }).toString()
    return s ? `?${s}` : ''
  }, [format, showHeader, useAccent, accent, effTrack, effDay, showAbstract, showSpeakers, showRoom, showTrack, font, radius, spacing, useMuted, muted])

  const pageUrl = `${origin}/e/${encodeURIComponent(slug)}/${widget}${pageQuery}`

  /** Query string for the feed URLs — filters only, no presentation. */
  const feedQuery = useMemo(() => {
    const p = new URLSearchParams()
    if (effTrack) p.set('track', effTrack)
    if (effDay) p.set('day', effDay)
    const s = p.toString()
    return s ? `?${s}` : ''
  }, [effTrack, effDay])

  // EMB-15 (major defect): every JSON/XML/iCal feed used to point at the
  // agenda endpoints regardless of which widget was selected, so choosing
  // "Sessions list" handed out .../agenda.json instead of a sessions feed —
  // "Speakers list" was the only widget that got its own URL right. Each
  // widget now maps to the feed that actually describes it: sessions gets
  // its own sessions.json/.xml/.ics (apps/api/src/routes/landing.tsx),
  // speakers/gallery keep speakers.json (their only format), and
  // agenda/schedule keep the agenda feeds since both really are views over
  // the full published agenda, not a distinct payload.
  const feedUrl = useMemo(() => {
    const base = `${origin}/e/${encodeURIComponent(slug)}`
    if (widget === 'speakers' || widget === 'gallery') {
      return `${base}/speakers.json`
    }
    if (widget === 'sessions') {
      if (format === 'json') return `${base}/sessions.json`
      if (format === 'xml') return `${base}/sessions.xml${feedQuery}`
      if (format === 'ics') return `${base}/sessions.ics`
      return pageUrl
    }
    if (format === 'json') return `${base}/agenda.json`
    if (format === 'xml') return `${base}/agenda.xml${feedQuery}`
    if (format === 'ics') return `${base}/agenda.ics`
    return pageUrl
  }, [origin, slug, widget, format, feedQuery, pageUrl])

  const snippet = useMemo(() => {
    if (format === 'script') {
      const lines = [
        `<script src="${attr(origin)}/embed.js"`,
        `        data-event="${attr(slug)}"`,
        `        data-widget="${attr(widget)}"`,
      ]
      // Derived from the same params as pageQuery (embedOptions.logic), so a
      // data-* attribute here can never disagree with the direct link's query
      // param for the identical option.
      for (const [attrName, value] of embedDataAttrs({ format, showHeader, useAccent, accent, track: effTrack, day: effDay, toggles, theme })) {
        lines.push(`        data-${attrName}="${attr(value)}"`)
      }
      if (height.trim()) lines.push(`        data-height="${attr(height.trim())}"`)
      return `${lines.join('\n')}></script>`
    }
    if (format === 'iframe') {
      return [
        `<iframe src="${attr(pageUrl)}"`,
        `        title="${attr(me.event.name)} — ${attr(def.label)}"`,
        `        width="100%" height="${attr(height.trim() || '600')}"`,
        '        style="border:0;display:block" loading="lazy"></iframe>',
        `<p><a href="${attr(pageUrl.split('?')[0] ?? pageUrl)}">${attr(def.label)} — ${attr(me.event.name)}</a></p>`,
      ].join('\n')
    }
    return feedUrl
  }, [
    format,
    origin,
    slug,
    widget,
    showHeader,
    useAccent,
    accent,
    effTrack,
    effDay,
    showAbstract,
    showSpeakers,
    showRoom,
    showTrack,
    font,
    radius,
    spacing,
    useMuted,
    muted,
    height,
    pageUrl,
    feedUrl,
    me.event.name,
    def.label,
  ])

  const previewUrl = pageUrl

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      window.setTimeout(() => setCopied(null), 1800)
    } catch {
      setCopied('failed')
    }
  }

  return (
    <div className="embeds">
      <header className="embeds-head">
        <h2>Embeds</h2>
        <p className="muted">
          Put a live piece of {me.event.name} on your own site. Pick a widget and a format, copy the
          snippet — nothing is saved here, the options travel in the URL.
        </p>
        {feedState === 'unpublished' && (
          <p className="embeds-warn">
            The agenda isn't published yet, so these embeds will render an "isn't published" message
            until you publish it. The snippets themselves stay valid.
          </p>
        )}
      </header>

      <div className="embeds-grid">
        <div className="embeds-controls">
          <fieldset className="embeds-field">
            <legend>Widget</legend>
            <div className="embeds-cards">
              {WIDGETS.map((w) => (
                <button
                  key={w.key}
                  type="button"
                  className={`embeds-card ${widget === w.key ? 'is-active' : ''}`}
                  aria-pressed={widget === w.key}
                  onClick={() => setWidget(w.key)}
                >
                  <span className="embeds-card-title">{w.label}</span>
                  <span className="embeds-card-blurb">{w.blurb}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="embeds-field">
            <legend>Output format</legend>
            <div className="embeds-radios">
              {FORMATS.map((f) => {
                const available = f.key === 'script' || f.key === 'iframe' || def.feeds.includes(f.key)
                return (
                  <label key={f.key} className={available ? 'embeds-radio' : 'embeds-radio is-disabled'}>
                    <input
                      type="radio"
                      name="embed-format"
                      value={f.key}
                      checked={format === f.key}
                      disabled={!available}
                      onChange={() => setFormat(f.key)}
                    />
                    <span>
                      <strong>{f.label}</strong>
                      <span className="muted embeds-radio-blurb">
                        {available ? f.blurb : 'Not available for this widget.'}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>

          <fieldset className="embeds-field">
            <legend>Branding</legend>
            <label className="embeds-check">
              <input
                type="checkbox"
                checked={showHeader}
                onChange={(e) => setShowHeader(e.currentTarget.checked)}
              />
              Show the event header and tab strip
            </label>
            <label className="embeds-check">
              <input
                type="checkbox"
                checked={useAccent}
                onChange={(e) => setUseAccent(e.currentTarget.checked)}
              />
              Override the accent colour
            </label>
            {useAccent && (
              <div className="embeds-accent">
                <input
                  type="color"
                  value={accent}
                  aria-label="Accent colour"
                  onChange={(e) => setAccent(e.currentTarget.value)}
                />
                <input
                  type="text"
                  className="embeds-accent-hex"
                  value={accent}
                  aria-label="Accent colour hex"
                  onChange={(e) => setAccent(e.currentTarget.value)}
                />
              </div>
            )}
          </fieldset>

          <fieldset className="embeds-field">
            <legend>Theme</legend>
            <p className="muted embeds-note">
              A fixed set of tokens, not free-form CSS — each is validated the same way the accent colour is.
            </p>
            <label className="embeds-label" htmlFor="embeds-font">
              Font
            </label>
            <select
              id="embeds-font"
              value={font}
              onChange={(e) => setFont(e.currentTarget.value as typeof font)}
            >
              <option value="">Default</option>
              <option value="sans">Sans-serif</option>
              <option value="serif">Serif</option>
              <option value="mono">Monospace</option>
            </select>
            <label className="embeds-label" htmlFor="embeds-radius">
              Corner radius (px, 0-32)
            </label>
            <input
              id="embeds-radius"
              type="number"
              min="0"
              max="32"
              placeholder="Default"
              value={radius}
              onChange={(e) => setRadius(e.currentTarget.value)}
            />
            <label className="embeds-label" htmlFor="embeds-spacing">
              Density
            </label>
            <select
              id="embeds-spacing"
              value={spacing}
              onChange={(e) => setSpacing(e.currentTarget.value as typeof spacing)}
            >
              <option value="">Default</option>
              <option value="compact">Compact</option>
              <option value="cozy">Cozy</option>
              <option value="roomy">Roomy</option>
            </select>
            <label className="embeds-check">
              <input
                type="checkbox"
                checked={useMuted}
                onChange={(e) => setUseMuted(e.currentTarget.checked)}
              />
              Override the muted text colour
            </label>
            {useMuted && (
              <div className="embeds-accent">
                <input
                  type="color"
                  value={muted}
                  aria-label="Muted text colour"
                  onChange={(e) => setMuted(e.currentTarget.value)}
                />
                <input
                  type="text"
                  className="embeds-accent-hex"
                  value={muted}
                  aria-label="Muted text colour hex"
                  onChange={(e) => setMuted(e.currentTarget.value)}
                />
              </div>
            )}
          </fieldset>

          <fieldset className="embeds-field">
            <legend>Content</legend>
            <label className="embeds-check">
              <input
                type="checkbox"
                checked={showAbstract}
                onChange={(e) => setShowAbstract(e.currentTarget.checked)}
              />
              Show session abstracts
            </label>
            <label className="embeds-check">
              <input
                type="checkbox"
                checked={showSpeakers}
                onChange={(e) => setShowSpeakers(e.currentTarget.checked)}
              />
              Show speakers
            </label>
            <label className="embeds-check">
              <input
                type="checkbox"
                checked={showRoom}
                onChange={(e) => setShowRoom(e.currentTarget.checked)}
              />
              Show room
            </label>
            <label className="embeds-check">
              <input
                type="checkbox"
                checked={showTrack}
                onChange={(e) => setShowTrack(e.currentTarget.checked)}
              />
              Show track
            </label>
          </fieldset>

          <fieldset className="embeds-field" disabled={!filterable}>
            <legend>Content filters</legend>
            {!filterable && <p className="muted embeds-note">This widget shows every speaker — no filters apply.</p>}
            <label className="embeds-label" htmlFor="embeds-track">
              Track
            </label>
            <select
              id="embeds-track"
              value={track}
              onChange={(e) => setTrack(e.currentTarget.value)}
            >
              <option value={ALL}>All tracks</option>
              {tracks.map((t) => (
                // Value is the readable slug (falling back to the UUID only
                // when a name slugs to nothing), so the snippet, direct link
                // and feed URL all express the filter the same readable way.
                <option key={t.id} value={trackSlug(t.name) || t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <label className="embeds-label" htmlFor="embeds-day">
              Day
            </label>
            <select id="embeds-day" value={day} onChange={(e) => setDay(e.currentTarget.value)}>
              <option value={ALL}>All days</option>
              {days.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </fieldset>

          {(format === 'script' || format === 'iframe') && (
            <fieldset className="embeds-field">
              <legend>Frame</legend>
              <label className="embeds-label" htmlFor="embeds-height">
                Starting height (px)
              </label>
              <input
                id="embeds-height"
                type="number"
                min="120"
                step="20"
                value={height}
                onChange={(e) => setHeight(e.currentTarget.value)}
              />
              <p className="muted embeds-note">
                {format === 'script'
                  ? 'The script resizes the frame to its content as the widget loads; this is the height before the first message arrives.'
                  : 'A plain iframe cannot resize itself — pick a height that fits your longest day.'}
              </p>
            </fieldset>
          )}
        </div>

        <div className="embeds-output">
          <div className="embeds-snippet">
            <div className="embeds-snippet-head">
              <h3>{format === 'script' || format === 'iframe' ? 'Snippet' : 'URL'}</h3>
              <button type="button" onClick={() => void copy('snippet', snippet)}>
                {copied === 'snippet' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <textarea readOnly rows={format === 'script' || format === 'iframe' ? 10 : 3} value={snippet} aria-label="Embed snippet" />
          </div>

          <div className="embeds-snippet">
            <div className="embeds-snippet-head">
              <h3>Direct link</h3>
              <button type="button" onClick={() => void copy('link', pageUrl)}>
                {copied === 'link' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="embeds-url">
              <a href={pageUrl} target="_blank" rel="noreferrer">
                {pageUrl}
              </a>
            </p>
          </div>

          <div className="embeds-preview">
            <div className="embeds-snippet-head">
              <h3>Live preview</h3>
              <span className="muted embeds-note">The real public page, with these options applied.</span>
            </div>
            <iframe
              key={previewUrl}
              src={previewUrl}
              title="Embed preview"
              className="embeds-preview-frame"
              style={{ height: `${Math.max(200, Number(height) || 600)}px` }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
