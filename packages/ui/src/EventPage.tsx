import { EventShell, eventShellCss, type EventShellNavItem } from './EventShell'
import type { PublicFeedFilter } from './publicData'
import { SessionsWidget } from './widgets/SessionsWidget'
import { SpeakersWidget } from './widgets/SpeakersWidget'
import { SpeakerDetailWidget } from './widgets/SpeakerDetailWidget'
import { AgendaWidget } from './widgets/AgendaWidget'
import { ScheduleWidget } from './widgets/ScheduleWidget'
import { GalleryWidget } from './widgets/GalleryWidget'

export type EventPageKind = 'sessions' | 'speakers' | 'speaker-detail' | 'agenda' | 'schedule' | 'gallery'

/**
 * Presentation + filter options, parsed from the page's query string by the
 * SSR handler (apps/api/src/routes/landing.tsx) and carried through the
 * bootstrap so the hydrated tree renders identically. All optional: a bare
 * /e/:slug/agenda behaves exactly as it did before this existed.
 *
 * Query-param names (lane W3-A, rubric EMB-15):
 *   ?accent=%23ff0055  brand colour for links/active states (--accent)
 *   ?header=0          hide the event name + tab strip (embed mode)
 *   ?embed=1           embed mode: also posts its height to the parent frame
 *   ?track=<id|name>   sessions / agenda / schedule only
 *   ?day=YYYY-MM-DD    sessions / agenda / schedule only
 */
export interface EventPageOptions {
  /** Validated `#rgb`/`#rrggbb` — the SSR handler rejects anything else. */
  accent?: string
  /** Default true; false drops the shell header (name + nav). */
  header?: boolean
  /** True when the page is being rendered for a cross-origin iframe embed. */
  embed?: boolean
  filter?: PublicFeedFilter
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
  const active: EventShellNavItem['key'] = data.page === 'speaker-detail' ? 'speakers' : data.page

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: eventShellCss }} />
      {options.accent && (
        <style dangerouslySetInnerHTML={{ __html: `:root{--accent:${options.accent};}` }} />
      )}
      {options.embed && <style dangerouslySetInnerHTML={{ __html: embedCss }} />}
      <EventShell
        eventName={event.name}
        eventSlug={event.slug}
        active={active}
        hideHeader={options.header === false}
      >
        {data.page === 'sessions' && <SessionsWidget eventSlug={event.slug} filter={filter} />}
        {data.page === 'speakers' && <SpeakersWidget eventSlug={event.slug} />}
        {data.page === 'speaker-detail' && (
          <SpeakerDetailWidget eventSlug={event.slug} speakerId={data.speakerId ?? ''} />
        )}
        {data.page === 'agenda' && <AgendaWidget eventSlug={event.slug} filter={filter} />}
        {data.page === 'schedule' && <ScheduleWidget eventSlug={event.slug} filter={filter} />}
        {data.page === 'gallery' && <GalleryWidget eventSlug={event.slug} />}
      </EventShell>
      {options.embed && <script dangerouslySetInnerHTML={{ __html: EMBED_RESIZE_SCRIPT }} />}
    </>
  )
}

/** Embedded pages sit inside someone else's layout: no page-sized padding. */
const embedCss = `
body { background: transparent; }
main { max-width: none; padding: 0; margin: 0; }
.event-shell { max-width: none; padding: .5rem; }
.event-shell-main { min-height: 0; }
`
