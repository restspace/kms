// The '?' button's target for every screen. The point of the test is the
// coupling this mapping quietly depends on: every sidebar view and every
// workspace sub-tab must resolve to a manual page that was actually generated,
// or the button lands the reader on a contents page instead of an answer.

import { describe, expect, it } from 'vitest'
import { helpSlugFor } from './helpTopics'
import { MANUAL_PAGE_META } from './manualNav.generated'
import { VIEW_KEYS } from '../router'

const WORKSPACE_TABS = ['speakers', 'submissions', 'reviews', 'comments', 'tasks', 'messages', 'files', 'events']
const generated = new Set(MANUAL_PAGE_META.map((page) => page.slug))

describe('helpSlugFor', () => {
  it('resolves every sidebar view to a manual page that exists', () => {
    for (const view of VIEW_KEYS) {
      const slug = helpSlugFor(view, null)
      expect(generated.has(slug), `${view} → ${slug}`).toBe(true)
    }
  })

  it('resolves every workspace tab to its own page, not the shared one', () => {
    for (const tab of WORKSPACE_TABS) {
      const slug = helpSlugFor('workspace', tab)
      expect(slug).toBe(`workspace-${tab}`)
      expect(generated.has(slug), `${tab} → ${slug}`).toBe(true)
    }
  })

  it('treats workspace with no tab as the Speakers tab, which is what it shows', () => {
    expect(helpSlugFor('workspace', null)).toBe('workspace-speakers')
  })

  it('falls back to a real page for an unknown tab or view', () => {
    expect(helpSlugFor('workspace', 'not-a-tab')).toBe('workspace')
    expect(helpSlugFor('nonsense' as never, null)).toBe('index')
  })

  it('sends Help itself to the contents rather than looping', () => {
    expect(helpSlugFor('help', null)).toBe('index')
  })
})
