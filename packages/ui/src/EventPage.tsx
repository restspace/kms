import { EventShell, eventShellCss, type EventShellNavItem } from './EventShell'
import type { FieldVisibility, PublicFeedFilter } from './publicData'
import { SessionsWidget } from './widgets/SessionsWidget'
import { SpeakersWidget } from './widgets/SpeakersWidget'
import { SpeakerDetailWidget } from './widgets/SpeakerDetailWidget'
import { AgendaWidget } from './widgets/AgendaWidget'
import { ScheduleWidget } from './widgets/ScheduleWidget'
import { GalleryWidget } from './widgets/GalleryWidget'

export type EventPageKind = 'sessions' | 'speakers' | 'speaker-detail' | 'agenda' | 'schedule' | 'gallery'

/**
 * Preset-driven theming (workplan 14, F3/D5): a fixed allowlist of tokens, not
 * free-form CSS — the SSR handler validates every field before it reaches a
 * stylesheet, the same discipline `accent` already gets. Each field is
 * optional and independently validated/dropped, so a request that mixes valid
 * and invalid tokens keeps only the valid ones.
 */
export interface EmbedTheme {
  /** One of a small named stack list — never an arbitrary font string. */
  font?: 'sans' | 'serif' | 'mono'
  /** Corner radius in px, 0-32 — clamped/validated server-side. */
  radius?: number
  /** Named density preset — not a raw numeric scale. */
  spacing?: 'compact' | 'cozy' | 'roomy'
  /** Validated `#rgb`/`#rrggbb`, exactly like `accent`. */
  muted?: string
}

/**
 * Presentation + filter options, parsed from the page's query string by the
 * SSR handler (apps/api/src/routes/landing.tsx) and carried through the
 * bootstrap so the hydrated tree renders identically. All optional: a bare
 * /e/:slug/agenda behaves exactly as it did before this existed.
 *
 * Query-param names (lane W3-A, rubric EMB-15; toggles/theme added workplan 14):
 *   ?accent=%23ff0055  brand colour for links/active states (--accent)
 *   ?header=0          hide the event name + tab strip (embed mode)
 *   ?embed=1           embed mode: also posts its height to the parent frame
 *   ?track=<id|name>   sessions / agenda / schedule only
 *   ?day=YYYY-MM-DD    sessions / agenda / schedule only
 *   ?show_abstract=0   sessions / agenda / schedule only, default shown
 *   ?show_speakers=0   sessions / agenda / schedule only, default shown
 *   ?show_room=0       sessions / agenda / schedule only, default shown
 *   ?show_track=0      sessions / agenda / schedule only, default shown
 *   ?font=serif        preset font stack (see EmbedTheme)
 *   ?radius=8          corner radius in px, 0-32
 *   ?spacing=roomy     preset density
 *   ?muted=%23667      validated hex, overrides --text-muted
 */
export interface EventPageOptions {
  /** Validated `#rgb`/`#rrggbb` — the SSR handler rejects anything else. */
  accent?: string
  /** Default true; false drops the shell header (name + nav). */
  header?: boolean
  /** True when the page is being rendered for a cross-origin iframe embed. */
  embed?: boolean
  filter?: PublicFeedFilter
  /** Field-visibility toggles (F3/D6); only present when something was turned off. */
  show?: FieldVisibility
  /** Theme token overrides (F3/D5); only present when at least one validated. */
  theme?: EmbedTheme
}

export interface EventPageBootstrap {
  page: EventPageKind
  event: { name: string; slug: string }
  /** Only present when page === 'speaker-detail'. */
  speakerId?: string
  /** Only present when the URL carried embed/filter parameters. */
  options?: EventPageOptions
}

/**
 * Posted by an embedded page to whoever framed it, so the loader script
 * (/embed.js) can size the iframe to its content instead of guessing. Kept
 * as a string constant rather than a module: it has to run inside the iframe
 * document with no bundle of its own, and it must work even if hydration
 * never happens.
 */
export const EMBED_RESIZE_SCRIPT = `(function(){
  if (window.parent === window) return;
  var last = 0;
  function post(){
    var h = Math.ceil(document.documentElement.scrollHeight);
    if (h === last) return;
    last = h;
    window.parent.postMessage({ type: 'kms:embed:height', height: h }, '*');
  }
  window.addEventListener('load', post);
  window.addEventListener('resize', post);
  if (typeof ResizeObserver === 'function') new ResizeObserver(post).observe(document.documentElement);
  setInterval(post, 1000);
  post();
})();`

/**
 * The single hydration root for every public event page (docs: W2-D1
 * foundation lane). One component, one bundle (apps/public/src/event.client.tsx),
 * dispatching on `data.page` to the shell + the matching widget stub — so
 * each of the six routes in apps/api/src/routes/landing.tsx renders the same
 * shape of document and sibling lanes only ever touch their one widget file
 * under packages/ui/src/widgets/.
 */
export function EventPage({ data }: { data: EventPageBootstrap }) {
  const { event } = data
  const options = data.options ?? {}
  const filter = options.filter
  const show = options.show
  const active: EventShellNavItem['key'] = data.page === 'speaker-detail' ? 'speakers' : data.page
  const themeCss = buildThemeCss(options.theme)

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: eventShellCss }} />
      {options.accent && (
        <style dangerouslySetInnerHTML={{ __html: `:root{--accent:${options.accent};}` }} />
      )}
      {themeCss && <style dangerouslySetInnerHTML={{ __html: themeCss }} />}
      {options.embed && <style dangerouslySetInnerHTML={{ __html: embedCss }} />}
      <EventShell
        eventName={event.name}
        eventSlug={event.slug}
        active={active}
        hideHeader={options.header === false}
      >
        {data.page === 'sessions' && <SessionsWidget eventSlug={event.slug} filter={filter} show={show} />}
        {data.page === 'speakers' && <SpeakersWidget eventSlug={event.slug} />}
        {data.page === 'speaker-detail' && (
          <SpeakerDetailWidget eventSlug={event.slug} speakerId={data.speakerId ?? ''} />
        )}
        {data.page === 'agenda' && <AgendaWidget eventSlug={event.slug} filter={filter} show={show} />}
        {data.page === 'schedule' && <ScheduleWidget eventSlug={event.slug} filter={filter} show={show} />}
        {data.page === 'gallery' && <GalleryWidget eventSlug={event.slug} />}
      </EventShell>
      {options.embed && <script dangerouslySetInnerHTML={{ __html: EMBED_RESIZE_SCRIPT }} />}
    </>
  )
}

/**
 * Preset -> concrete CSS custom-property value. Kept as closed lookup tables
 * (not string interpolation of the query param itself) so the allowlist is
 * enforced twice over: the SSR handler only ever sets a key that exists here,
 * and this map only ever emits values it was written with — there is no path
 * from a query param to arbitrary CSS text, which is the whole point of D5.
 */
const FONT_STACKS: Record<NonNullable<EmbedTheme['font']>, string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  serif: '"Source Serif 4", "Source Serif 4 Fallback", "Source Serif 4 Fallback 2", Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
}

/** Density presets scale the app's own --space-* tokens rather than inventing a parallel scale. */
const SPACING_SCALES: Record<NonNullable<EmbedTheme['spacing']>, number> = {
  compact: 0.75,
  cozy: 1,
  roomy: 1.35,
}

const SPACE_BASE_PX: Record<string, number> = { '--space-1': 4, '--space-2': 8, '--space-3': 12, '--space-4': 16, '--space-5': 24 }

/** Scoped to :root like `accent` above — these pages render nothing but the one widget, so :root IS the widget root. */
function buildThemeCss(theme: EmbedTheme | undefined): string | null {
  if (!theme) return null
  const decls: string[] = []
  if (theme.font) decls.push(`--font-ui:${FONT_STACKS[theme.font]};`)
  if (theme.radius !== undefined) {
    decls.push(`--radius:${theme.radius}px;`)
    decls.push(`--radius-sm:${Math.max(0, theme.radius - 1)}px;`)
  }
  if (theme.spacing) {
    const scale = SPACING_SCALES[theme.spacing]
    for (const [name, base] of Object.entries(SPACE_BASE_PX)) {
      decls.push(`${name}:${Math.round(base * scale)}px;`)
    }
  }
  if (theme.muted) decls.push(`--text-muted:${theme.muted};`)
  if (decls.length === 0) return null
  return `:root{${decls.join('')}}`
}

/** Embedded pages sit inside someone else's layout: no page-sized padding. */
const embedCss = `
body { background: transparent; }
main { max-width: none; padding: 0; margin: 0; }
.event-shell { max-width: none; padding: .5rem; }
.event-shell-main { min-height: 0; }
`
