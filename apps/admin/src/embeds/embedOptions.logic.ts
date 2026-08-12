// Pure query/attribute builders for the Embeds screen (workplan 14, F3/D6):
// the direct link, the <script data-*> snippet and (where a feed honours
// filters at all) the feed URL must all express the same options identically
// — this was the judged EMB-15 defect for track/day, fixed by unifying on one
// slug-based vocabulary (b815e77). The same discipline now covers the new
// field-visibility toggles and theme tokens: one function builds the query
// params, and both the page URL and the script tag read off it, so they
// cannot drift by construction.

export type EmbedFormat = 'script' | 'iframe' | 'json' | 'xml' | 'ics'

export interface EmbedFieldToggles {
  showAbstract: boolean
  showSpeakers: boolean
  showRoom: boolean
  showTrack: boolean
}

export interface EmbedThemeInput {
  /** '' means "no override". */
  font: '' | 'sans' | 'serif' | 'mono'
  /** '' means "no override"; otherwise a trimmed numeric string. */
  radius: string
  spacing: '' | 'compact' | 'cozy' | 'roomy'
  useMuted: boolean
  muted: string
}

export interface EmbedOptionsInput {
  format: EmbedFormat
  showHeader: boolean
  useAccent: boolean
  accent: string
  /** Readable slug (or UUID fallback), same as the existing track filter. */
  track: string
  day: string
  toggles: EmbedFieldToggles
  theme: EmbedThemeInput
}

/**
 * What a saved embed persists (EMB-15): the full generator state minus
 * widget/format, which travel as their own columns so the list screen and the
 * API's allowlist validation can read them without opening the blob. Snippets
 * are never stored — they are rebuilt from these options at copy time, so a
 * later snippet-format improvement reaches every saved embed for free.
 */
export interface SavedEmbedOptions {
  accent: string
  useAccent: boolean
  showHeader: boolean
  track: string
  day: string
  height: string
  toggles: EmbedFieldToggles
  theme: EmbedThemeInput
}

/**
 * Query params for the public page URL (also what an <iframe src> or the
 * embed.js loader constructs client-side from its data-* attrs). Presentation
 * options only — content filters (track/day) already lived here; toggles and
 * theme tokens join them on the same footing.
 */
export function embedPageParams(input: EmbedOptionsInput): URLSearchParams {
  const p = new URLSearchParams()
  if (input.format === 'script' || input.format === 'iframe') p.set('embed', '1')
  if (!input.showHeader) p.set('header', '0')
  if (input.useAccent && input.accent) p.set('accent', input.accent)
  if (input.track) p.set('track', input.track)
  if (input.day) p.set('day', input.day)
  if (!input.toggles.showAbstract) p.set('show_abstract', '0')
  if (!input.toggles.showSpeakers) p.set('show_speakers', '0')
  if (!input.toggles.showRoom) p.set('show_room', '0')
  if (!input.toggles.showTrack) p.set('show_track', '0')
  if (input.theme.font) p.set('font', input.theme.font)
  if (input.theme.radius.trim()) p.set('radius', input.theme.radius.trim())
  if (input.theme.spacing) p.set('spacing', input.theme.spacing)
  if (input.theme.useMuted && input.theme.muted) p.set('muted', input.theme.muted)
  return p
}

/** query-param name -> `<script>` data-* attribute name (kebab-case, no `data-` prefix). */
const DATA_ATTR_NAME: Record<string, string> = {
  header: 'header',
  accent: 'accent',
  track: 'track',
  day: 'day',
  show_abstract: 'show-abstract',
  show_speakers: 'show-speakers',
  show_room: 'show-room',
  show_track: 'show-track',
  font: 'font',
  radius: 'radius',
  spacing: 'spacing',
  muted: 'muted',
}

/**
 * The same params as `embedPageParams`, expressed as `data-*` attribute
 * name/value pairs for the `<script>` snippet — derived from the identical
 * URLSearchParams rather than rebuilt by hand, so the tag and the link can
 * never carry different values for the same option. `embed=1` is dropped:
 * the loader script always sets that itself once it builds the iframe src.
 */
export function embedDataAttrs(input: EmbedOptionsInput): [string, string][] {
  const params = embedPageParams(input)
  const attrs: [string, string][] = []
  for (const [key, value] of params) {
    if (key === 'embed') continue
    const attrName = DATA_ATTR_NAME[key]
    if (attrName) attrs.push([attrName, value])
  }
  return attrs
}
