import { describe, expect, it } from 'vitest'
import { stripHtml, toParagraphs } from './richText'

describe('stripHtml', () => {
  it('removes tags and collapses whitespace', () => {
    expect(stripHtml('<p>Hello <strong>world</strong></p>')).toBe('Hello world')
  })

  it('decodes the entities a rich-text editor emits', () => {
    expect(stripHtml('<p>Tips &amp; tricks &mdash; part&nbsp;2</p>')).toBe('Tips & tricks — part 2')
    expect(stripHtml('caf&#233;')).toBe('café')
  })

  it('leaves plain text alone', () => {
    expect(stripHtml('Just a sentence.')).toBe('Just a sentence.')
  })
})

describe('toParagraphs', () => {
  it('splits HTML on block boundaries and drops the markup', () => {
    // D4 regression: the agenda modal used to render "<p>...</p>" verbatim
    // because it split the raw HTML on blank lines and printed the pieces.
    expect(toParagraphs('<p>First para.</p><p>Second para.</p>')).toEqual([
      'First para.',
      'Second para.',
    ])
  })

  it('treats a double <br> as a paragraph break', () => {
    expect(toParagraphs('<div>One<br><br>Two</div>')).toEqual(['One', 'Two'])
  })

  it('still splits plain text on blank lines', () => {
    expect(toParagraphs('One\n\nTwo')).toEqual(['One', 'Two'])
  })

  it('returns nothing for empty or tag-only input', () => {
    expect(toParagraphs('')).toEqual([])
    expect(toParagraphs('<p></p>')).toEqual([])
  })
})
