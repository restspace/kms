/**
 * WCAG 2.1 relative-luminance contrast, used by the palette audit in
 * contrast.test.ts. Kept in src (not the test file) so the ratios can also be
 * checked from a script while iterating on a palette.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

export function parseHex(hex: string): Rgb {
  const h = hex.trim().replace('#', '')
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`)
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  }
}

const channel = (v: number): number => {
  const s = v / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio, 1:1 (identical) to 21:1 (black on white). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

/** Every custom property declared in a given :root-ish block of a stylesheet. */
export function readTokenBlocks(css: string): Record<string, string>[] {
  return css
    // Comments mention token names ("--surface deliberately equals --bg")
    // and would otherwise parse as declarations.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/(?=:root)/)
    .filter((b) => b.includes('--bg:'))
    .map((block) => {
      const out: Record<string, string> = {}
      for (const [, name, value] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
        out[name!] = value!.trim()
      }
      return out
    })
}
