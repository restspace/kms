import { useEffect, useState } from 'react'
import {
  createSavedEmbed,
  deleteSavedEmbed,
  listSavedEmbeds,
  updateSavedEmbed,
  type Me,
  type SavedEmbedRow,
} from '../api'
import { appConfirm } from '../components/dialogs'
import {
  embedDataAttrs,
  embedPageParams,
  type EmbedFieldToggles,
  type EmbedThemeInput,
  type SavedEmbedOptions,
} from './embedOptions.logic'
import './embeds.css'

/**
 * Embeds (rubric EMB-15) — a generator plus a saved list. The generator's
 * options all travel in the URL, so a copied snippet works with no
 * server-side record; *saving* (0038_saved_embeds) just names the current
 * option state so the screen can answer "what have we embedded where?" and
 * reload a configuration for editing. Snippets are rebuilt from the saved
 * options at copy time, never stored.
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

  // Saved embeds (EMB-15): the persisted list, the row currently loaded into
  // the generator (Save then updates it in place), and the Save box's name.
  const [saved, setSaved] = useState<SavedEmbedRow[] | null>(null)
  const [savedError, setSavedError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    listSavedEmbeds()
      .then((r) => setSaved(r.items))
      .catch((e: unknown) => setSavedError(e instanceof Error ? e.message : 'Failed to load saved embeds'))
  }, [])

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

  const toggles: EmbedFieldToggles = { showAbstract, showSpeakers, showRoom, showTrack }
  const theme: EmbedThemeInput = { font, radius, spacing, useMuted, muted }

  /** The generator's current state as the shape a saved embed persists. */
  const currentOptions: SavedEmbedOptions = { accent, useAccent, showHeader, track, day, height, toggles, theme }

  /**
   * The builders below are parameterized on (widget, format, options) rather
   * than reading component state, so the saved-embeds list can rebuild any
   * row's snippet at copy time without loading it into the generator first.
   * All of them route through embedOptions.logic — one builder for the page
   * query and the <script data-*> attrs, so the two cannot express the same
   * choice two different ways (the EMB-15 defect this pattern already fixed
   * for track/day).
   */
  const pageUrlFor = (w: WidgetKey, f: FormatKey, o: SavedEmbedOptions): string => {
    const wd = WIDGETS.find((x) => x.key === w) as WidgetDef
    const s = embedPageParams({
      format: f,
      showHeader: o.showHeader,
      useAccent: o.useAccent,
      accent: o.accent,
      track: wd.filterable ? o.track : ALL,
      day: wd.filterable ? o.day : ALL,
      toggles: o.toggles,
      theme: o.theme,
    }).toString()
    return `${origin}/e/${encodeURIComponent(slug)}/${w}${s ? `?${s}` : ''}`
  }

  // EMB-15 (major defect): every JSON/XML/iCal feed used to point at the
  // agenda endpoints regardless of which widget was selected, so choosing
  // "Sessions list" handed out .../agenda.json instead of a sessions feed —
  // "Speakers list" was the only widget that got its own URL right. Each
  // widget now maps to the feed that actually describes it: sessions gets
  // its own sessions.json/.xml/.ics (apps/api/src/routes/landing.tsx),
  // speakers/gallery keep speakers.json (their only format), and
  // agenda/schedule keep the agenda feeds since both really are views over
  // the full published agenda, not a distinct payload.
  const feedUrlFor = (w: WidgetKey, f: FormatKey, o: SavedEmbedOptions): string => {
    const wd = WIDGETS.find((x) => x.key === w) as WidgetDef
    const base = `${origin}/e/${encodeURIComponent(slug)}`
    const p = new URLSearchParams()
    if (wd.filterable && o.track) p.set('track', o.track)
    if (wd.filterable && o.day) p.set('day', o.day)
    const feedQuery = p.toString() ? `?${p.toString()}` : ''
    if (w === 'speakers' || w === 'gallery') {
      return `${base}/speakers.json`
    }
    if (w === 'sessions') {
      if (f === 'json') return `${base}/sessions.json`
      if (f === 'xml') return `${base}/sessions.xml${feedQuery}`
      if (f === 'ics') return `${base}/sessions.ics`
      return pageUrlFor(w, f, o)
    }
    if (f === 'json') return `${base}/agenda.json`
    if (f === 'xml') return `${base}/agenda.xml${feedQuery}`
    if (f === 'ics') return `${base}/agenda.ics`
    return pageUrlFor(w, f, o)
  }

  const snippetFor = (w: WidgetKey, f: FormatKey, o: SavedEmbedOptions): string => {
    const wd = WIDGETS.find((x) => x.key === w) as WidgetDef
    const url = pageUrlFor(w, f, o)
    if (f === 'script') {
      const lines = [
        `<script src="${attr(origin)}/embed.js"`,
        `        data-event="${attr(slug)}"`,
        `        data-widget="${attr(w)}"`,
      ]
      // Derived from the same params as the page URL (embedOptions.logic), so
      // a data-* attribute here can never disagree with the direct link's
      // query param for the identical option.
      for (const [attrName, value] of embedDataAttrs({
        format: f,
        showHeader: o.showHeader,
        useAccent: o.useAccent,
        accent: o.accent,
        track: wd.filterable ? o.track : ALL,
        day: wd.filterable ? o.day : ALL,
        toggles: o.toggles,
        theme: o.theme,
      })) {
        lines.push(`        data-${attrName}="${attr(value)}"`)
      }
      if (o.height.trim()) lines.push(`        data-height="${attr(o.height.trim())}"`)
      return `${lines.join('\n')}></script>`
    }
    if (f === 'iframe') {
      return [
        `<iframe src="${attr(url)}"`,
        `        title="${attr(me.event.name)} — ${attr(wd.label)}"`,
        `        width="100%" height="${attr(o.height.trim() || '600')}"`,
        '        style="border:0;display:block" loading="lazy"></iframe>',
        `<p><a href="${attr(url.split('?')[0] ?? url)}">${attr(wd.label)} — ${attr(me.event.name)}</a></p>`,
      ].join('\n')
    }
    return feedUrlFor(w, f, o)
  }

  const pageUrl = pageUrlFor(widget, format, currentOptions)
  const snippet = snippetFor(widget, format, currentOptions)
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

  /** Hydrate the generator from a saved row (its Load action). */
  const loadSaved = (row: SavedEmbedRow) => {
    const o = row.options
    setWidget(row.widget)
    setFormat(row.format)
    setAccent(o.accent || DEFAULT_EMBED_ACCENT)
    setUseAccent(o.useAccent)
    setShowHeader(o.showHeader)
    setTrack(o.track ?? ALL)
    setDay(o.day ?? ALL)
    setHeight(o.height || '600')
    setShowAbstract(o.toggles?.showAbstract ?? true)
    setShowSpeakers(o.toggles?.showSpeakers ?? true)
    setShowRoom(o.toggles?.showRoom ?? true)
    setShowTrack(o.toggles?.showTrack ?? true)
    setFont(o.theme?.font ?? '')
    setRadius(o.theme?.radius ?? '')
    setSpacing(o.theme?.spacing ?? '')
    setUseMuted(o.theme?.useMuted ?? false)
    setMuted(o.theme?.muted || DEFAULT_EMBED_MUTED)
    setActiveId(row.id)
    setSaveName(row.name)
  }

  const saveEmbed = async (asNew: boolean) => {
    const name = saveName.trim()
    if (!name || saving) return
    setSaving(true)
    setSavedError(null)
    try {
      if (!asNew && activeId) {
        const updated = await updateSavedEmbed(activeId, { name, widget, format, options: currentOptions })
        setSaved((cur) => (cur ?? []).map((r) => (r.id === updated.id ? updated : r)))
      } else {
        const created = await createSavedEmbed({ name, widget, format, options: currentOptions })
        setSaved((cur) => [created, ...(cur ?? [])])
        setActiveId(created.id)
      }
    } catch (e) {
      setSavedError(e instanceof Error ? e.message : 'Failed to save the embed.')
    } finally {
      setSaving(false)
    }
  }

  const removeSaved = async (row: SavedEmbedRow) => {
    const confirmed = await appConfirm(
      `Delete "${row.name}"? Snippets already pasted into other sites keep working — only this saved configuration goes away.`,
      { title: 'Delete saved embed', confirmLabel: 'Delete', danger: true },
    )
    if (!confirmed) return
    try {
      await deleteSavedEmbed(row.id)
      setSaved((cur) => (cur ?? []).filter((r) => r.id !== row.id))
      if (activeId === row.id) {
        setActiveId(null)
        setSaveName('')
      }
    } catch (e) {
      setSavedError(e instanceof Error ? e.message : 'Failed to delete the embed.')
    }
  }

  const widgetLabel = (key: WidgetKey) => WIDGETS.find((w) => w.key === key)?.label ?? key
  const formatLabel = (key: FormatKey) => FORMATS.find((f) => f.key === key)?.label ?? key

  return (
    <div className="embeds">
      <header className="embeds-head">
        <h2>Embeds</h2>
        <p className="muted">
          Put a live piece of {me.event.name} on your own site. Pick a widget and a format, copy the
          snippet — and save the configuration to come back to it later.
        </p>
        {feedState === 'unpublished' && (
          <p className="embeds-warn">
            The agenda isn't published yet, so these embeds will render an "isn't published" message
            until you publish it. The snippets themselves stay valid.
          </p>
        )}
      </header>

      <section className="embeds-saved" aria-label="Saved embeds">
        <div className="embeds-snippet-head">
          <h3>Saved embeds</h3>
        </div>
        {savedError && <p className="embeds-warn">{savedError}</p>}
        {saved === null ? (
          <p className="muted embeds-note">Loading…</p>
        ) : saved.length === 0 ? (
          <p className="muted embeds-note">
            Nothing saved yet. Configure a widget below and use “Save” to keep the configuration here.
          </p>
        ) : (
          <table className="embeds-saved-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Widget</th>
                <th>Format</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {saved.map((row) => (
                <tr key={row.id} className={activeId === row.id ? 'is-active' : undefined}>
                  <td>{row.name}</td>
                  <td>{widgetLabel(row.widget)}</td>
                  <td>{formatLabel(row.format)}</td>
                  <td>{row.updated_at.slice(0, 10)}</td>
                  <td className="embeds-saved-actions">
                    <button type="button" onClick={() => loadSaved(row)}>
                      {activeId === row.id ? 'Loaded' : 'Load'}
                    </button>
                    <button type="button" onClick={() => void copy(`row-${row.id}`, snippetFor(row.widget, row.format, row.options))}>
                      {copied === `row-${row.id}` ? 'Copied' : 'Copy snippet'}
                    </button>
                    <button type="button" onClick={() => void removeSaved(row)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

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
          <div className="embeds-snippet embeds-save">
            <div className="embeds-snippet-head">
              <h3>{activeId ? 'Editing a saved embed' : 'Save this embed'}</h3>
            </div>
            <div className="embeds-save-row">
              <input
                type="text"
                placeholder="Name, e.g. Homepage agenda"
                aria-label="Saved embed name"
                value={saveName}
                onChange={(e) => setSaveName(e.currentTarget.value)}
              />
              <button
                type="button"
                disabled={saveName.trim() === '' || saving}
                onClick={() => void saveEmbed(false)}
              >
                {saving ? 'Saving…' : activeId ? 'Save changes' : 'Save'}
              </button>
              {activeId && (
                <button type="button" disabled={saveName.trim() === '' || saving} onClick={() => void saveEmbed(true)}>
                  Save as new
                </button>
              )}
            </div>
            {activeId && (
              <p className="muted embeds-note">
                Renaming here and saving updates the saved embed; “Save as new” keeps the original.
              </p>
            )}
          </div>

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
