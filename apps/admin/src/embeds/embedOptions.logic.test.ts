import { describe, expect, it } from 'vitest'
import { embedDataAttrs, embedPageParams, type EmbedOptionsInput } from './embedOptions.logic'

function baseInput(overrides: Partial<EmbedOptionsInput> = {}): EmbedOptionsInput {
  return {
    format: 'script',
    showHeader: false,
    useAccent: false,
    accent: '#2c4a73',
    track: '',
    day: '',
    toggles: { showAbstract: true, showSpeakers: true, showRoom: true, showTrack: true },
    theme: { font: '', radius: '', spacing: '', useMuted: false, muted: '#667788' },
    ...overrides,
  }
}

describe('embedPageParams', () => {
  it('carries no extra params when every toggle/theme field is at its default', () => {
    const p = embedPageParams(baseInput())
    expect(p.toString()).toBe('embed=1&header=0')
  })

  it('emits show_*=0 only for toggles that are off, never for ones left on', () => {
    const p = embedPageParams(
      baseInput({ toggles: { showAbstract: false, showSpeakers: true, showRoom: false, showTrack: true } }),
    )
    expect(p.get('show_abstract')).toBe('0')
    expect(p.get('show_room')).toBe('0')
    expect(p.has('show_speakers')).toBe(false)
    expect(p.has('show_track')).toBe(false)
  })

  it('emits theme tokens only when set, trimming a numeric radius', () => {
    const p = embedPageParams(
      baseInput({ theme: { font: 'serif', radius: ' 8 ', spacing: 'roomy', useMuted: true, muted: '#667788' } }),
    )
    expect(p.get('font')).toBe('serif')
    expect(p.get('radius')).toBe('8')
    expect(p.get('spacing')).toBe('roomy')
    expect(p.get('muted')).toBe('#667788')
  })

  it('drops the muted colour when the override checkbox is off, even with a value present', () => {
    const p = embedPageParams(baseInput({ theme: { font: '', radius: '', spacing: '', useMuted: false, muted: '#667788' } }))
    expect(p.has('muted')).toBe(false)
  })

  it('carries track/day filters exactly as given, same as before the toggles existed', () => {
    const p = embedPageParams(baseInput({ track: 'platform-engineering', day: '2026-10-01' }))
    expect(p.get('track')).toBe('platform-engineering')
    expect(p.get('day')).toBe('2026-10-01')
  })
})

describe('embedDataAttrs — snippet/link consistency (regression-tested like the track filter, EMB-15)', () => {
  it('produces the identical set of options the page URL carries, minus embed=1', () => {
    const input = baseInput({
      showHeader: true,
      track: 'platform-engineering',
      day: '2026-10-01',
      toggles: { showAbstract: false, showSpeakers: false, showRoom: true, showTrack: true },
      theme: { font: 'mono', radius: '4', spacing: 'compact', useMuted: true, muted: '#556677' },
    })
    const params = embedPageParams(input)
    const attrs = new Map(embedDataAttrs(input))

    // Every param that ends up in the page URL/iframe src (other than the
    // always-on embed=1, which the loader sets itself) appears in the script
    // snippet under the matching data-* name, with the same value.
    for (const [key, value] of params) {
      if (key === 'embed') continue
      const attrName = key.replace(/_/g, '-')
      expect(attrs.get(attrName)).toBe(value)
    }
    expect(attrs.size).toBe([...params].filter(([k]) => k !== 'embed').length)
  })

  it('omits data-* attributes for options left at their default', () => {
    const attrs = new Map(embedDataAttrs(baseInput()))
    expect(attrs.has('show-abstract')).toBe(false)
    expect(attrs.has('font')).toBe(false)
    expect(attrs.has('radius')).toBe(false)
    expect(attrs.has('spacing')).toBe(false)
    expect(attrs.has('muted')).toBe(false)
  })
})
