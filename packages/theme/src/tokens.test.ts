import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - build.mjs is plain JS with no type declarations.
import { render } from '../build.mjs'
import { tokensCss } from './generated'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))
const source = readFileSync(here('../tokens.css'), 'utf8')

describe('design tokens', () => {
  it('has a checked-in generated.ts that matches tokens.css', () => {
    // If this fails, run: npm run build -w @kms/theme
    expect(readFileSync(here('./generated.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe(render(source))
  })

  it('defines every token in all three theme states', () => {
    const blocks = source.split(/(?=:root)/).filter((b) => b.includes('--bg:'))
    expect(blocks).toHaveLength(3)
    // Type and density tokens are theme-invariant and only declared once, so
    // compare the set each dark block overrides against the light palette's.
    const namesIn = (b: string) => [...new Set(b.match(/--[a-z0-9-]+(?=\s*:)/g) ?? [])].sort()
    const [light, osDark, explicitDark] = blocks.map(namesIn) as [string[], string[], string[]]
    expect(explicitDark).toEqual(osDark)
    for (const name of osDark) expect(light).toContain(name)
  })

  it('inlines the same custom properties the stylesheet declares', () => {
    for (const name of new Set(source.match(/--[a-z0-9-]+(?=\s*:)/g) ?? [])) {
      expect(tokensCss).toContain(`${name}:`)
    }
  })
})
