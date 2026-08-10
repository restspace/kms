import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contrast, readTokenBlocks } from './contrast'

/**
 * §5.4 of the theme workplan: every text/ground and control/ground pair has to
 * be re-derived against the warm ground rather than carried over from the cool
 * grey palette. There is no visual-regression suite, so this is the safety net
 * for a repalette — it fails the build if a future palette edit drops a pair
 * below its WCAG threshold in any of the three theme states.
 */
const css = readFileSync(fileURLToPath(new URL('../tokens.css', import.meta.url)), 'utf8')
const STATES = ['light (:root)', 'OS dark', 'explicit dark'] as const
const blocks = readTokenBlocks(css)

/** Body text and any text below ~18px: WCAG AA 1.4.3. */
const TEXT_ON_GROUND = [
  '--text',
  '--text-secondary',
  '--text-muted',
  '--text-faint',
  '--accent',
  '--accent-strong',
  '--accent-alt',
  '--danger-strong',
  '--notice-text',
]

/** Text tokens paired with the tinted ground they are always drawn on. */
const TEXT_ON_TINT: [string, string][] = [
  ['--accent', '--accent-soft'],
  ['--accent-strong', '--accent-soft'],
  ['--accent', '--accent-soft-hover'],
  ['--danger-strong', '--danger-soft'],
  ['--notice-text', '--notice-soft'],
  ['--text', '--chrome'],
  ['--text-secondary', '--chrome'],
  ['--text-muted', '--chrome'],
  ['--text', '--surface-hover'],
  ['--text-muted', '--surface-hover'],
  ['--text', '--surface'],
  ['--text-muted', '--surface'],
  ['--accent-contrast', '--accent'],
  ['--accent-contrast', '--accent-strong'],
  ['--danger-contrast', '--danger'],
  ['--status-accepted-text', '--status-accepted-bg'],
  ['--status-pending-text', '--status-pending-bg'],
  ['--status-queue-text', '--status-queue-bg'],
  ['--status-declined-text', '--status-declined-bg'],
  ['--status-withdrawn-text', '--status-withdrawn-bg'],
  ['--status-draft-text', '--status-draft-bg'],
]

/**
 * Non-text contrast (WCAG 1.4.11, 3:1). --border is excluded on purpose: it
 * draws decorative hairlines between regions, not control boundaries.
 * --border-strong is not — it outlines inputs and selects.
 */
const NON_TEXT_ON_GROUND = ['--border-strong', '--notice-strong']

describe.each(STATES.map((name, i) => [name, blocks[i]!] as const))('%s palette', (_name, t) => {
  it('declares a complete palette', () => {
    expect(t['--bg']).toMatch(/^#[0-9a-f]{6}$/)
  })

  it.each(TEXT_ON_GROUND)('%s clears 4.5:1 on the ground', (token) => {
    expect(contrast(t[token]!, t['--bg']!)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(TEXT_ON_TINT)('%s clears 4.5:1 on %s', (fg, bg) => {
    expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5)
  })

  it.each(NON_TEXT_ON_GROUND)('%s clears 3:1 on the ground', (token) => {
    expect(contrast(t[token]!, t['--bg']!)).toBeGreaterThanOrEqual(3)
  })

  it('keeps the accent clearly distinct from the body text', () => {
    // §5.2: the accent has to differ from body text by more than hue, or it
    // stops reading as an accent. Guard the value separation directly.
    const ratio = contrast(t['--accent']!, t['--text']!)
    expect(ratio).toBeGreaterThanOrEqual(1.5)
  })

  it('keeps danger and accent in different hue families', () => {
    expect(t['--danger']).not.toBe(t['--accent'])
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
      return Math.atan2(Math.sqrt(3) * (g! - b!), 2 * r! - g! - b!)
    }
    expect(Math.abs(hue(t['--danger']!) - hue(t['--accent']!))).toBeGreaterThan(1)
  })
})
