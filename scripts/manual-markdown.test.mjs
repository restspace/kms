// The manual's markdown dialect (scripts/manual-markdown.mjs). This converter
// is hand-rolled, so its job here is to pin the constructs docs/manual actually
// uses — and, just as importantly, the escaping: everything the manual writes
// must survive as text rather than becoming markup.

import { describe, expect, it } from 'vitest'
import { INDEX_SLUG, parseNav, renderMarkdown, slugifyHeading } from './manual-markdown.mjs'

const SLUGS = new Set([INDEX_SLUG, 'agenda', 'workspace-speakers'])
const render = (markdown) => renderMarkdown(markdown, SLUGS).html

describe('slugifyHeading', () => {
  it('matches the GitHub anchors the manual links against', () => {
    expect(slugifyHeading('Making and sending decisions')).toBe('making-and-sending-decisions')
    expect(slugifyHeading('Organisation board (all events)')).toBe('organisation-board-all-events')
  })
})

describe('renderMarkdown', () => {
  it('takes the title from the h1 and leaves it out of the body', () => {
    const { title, html } = renderMarkdown('# Agenda\n\nSome prose.\n', SLUGS)
    expect(title).toBe('Agenda')
    expect(html).toBe('<p>Some prose.</p>')
  })

  it('gives every sub-heading an id, and reports them for the TOC', () => {
    const { html, headings } = renderMarkdown('# T\n\n## Views\n\n### Group by\n', SLUGS)
    expect(html).toContain('<h2 id="views">Views</h2>')
    expect(html).toContain('<h3 id="group-by">Group by</h3>')
    expect(headings).toEqual([
      { id: 'views', level: 2, text: 'Views' },
      { id: 'group-by', level: 3, text: 'Group by' },
    ])
  })

  it('joins a wrapped paragraph into one line', () => {
    expect(render('The manual wraps\nat about a hundred\ncolumns.\n')).toBe(
      '<p>The manual wraps at about a hundred columns.</p>',
    )
  })

  it('renders bold, italic and code inlines', () => {
    expect(render('**Save** the *draft* by pressing `M`.')).toBe(
      '<p><strong>Save</strong> the <em>draft</em> by pressing <code>M</code>.</p>',
    )
  })

  it('never lets markup inside a code span be re-parsed', () => {
    expect(render('Type `**not bold**` here.')).toBe('<p>Type <code>**not bold**</code> here.</p>')
  })

  it('escapes HTML in prose and in code', () => {
    expect(render('A `<script>` tag & an <b>attempt</b>.')).toBe(
      '<p>A <code>&lt;script&gt;</code> tag &amp; an &lt;b&gt;attempt&lt;/b&gt;.</p>',
    )
  })

  it('rewrites links between manual pages into Help routes, anchors included', () => {
    expect(render('See [the agenda](agenda.md).')).toBe('<p>See <a href="?v=help&amp;page=agenda">the agenda</a>.</p>')
    expect(render('See [publishing](agenda.md#publishing).')).toContain('href="?v=help&amp;page=agenda#publishing"')
  })

  it('unwraps a link that points outside the manual rather than shipping a 404', () => {
    expect(render('See [the spec](../README.md).')).toBe('<p>See the spec.</p>')
    expect(render('See [nothing](does-not-exist.md).')).toBe('<p>See nothing.</p>')
  })

  it('renders a bullet list, including a nested one', () => {
    expect(render('- Top one\n- Top two\n  - Nested\n  - Also nested\n- Top three\n')).toBe(
      '<ul><li>Top one</li><li>Top two<ul><li>Nested</li><li>Also nested</li></ul></li><li>Top three</li></ul>',
    )
  })

  it('folds a wrapped list item back onto one line', () => {
    expect(render('- An item whose text\n  wraps onto a second line.\n')).toBe(
      '<ul><li>An item whose text wraps onto a second line.</li></ul>',
    )
  })

  it('renders an ordered list', () => {
    expect(render('1. First\n2. Second\n')).toBe('<ol><li>First</li><li>Second</li></ol>')
  })

  it('renders a table inside a scroll wrapper', () => {
    const html = render('| Screen | Covers |\n|---|---|\n| [Agenda](agenda.md) | Scheduling |\n')
    expect(html).toContain('<div class="manual-table-wrap">')
    expect(html).toContain('<th>Screen</th>')
    expect(html).toContain('<td><a href="?v=help&amp;page=agenda">Agenda</a></td>')
  })

  it('renders a multi-line blockquote as one quoted block', () => {
    expect(render('> **Note:** this spans\n> two source lines.\n')).toBe(
      '<blockquote><p><strong>Note:</strong> this spans two source lines.</p></blockquote>',
    )
  })

  it('preserves a fenced code block verbatim', () => {
    expect(render('```\ndraft --> pending\n  |\n```\n')).toBe('<pre><code>draft --&gt; pending\n  |</code></pre>')
  })
})

describe('parseNav', () => {
  const README = [
    '# User Manual',
    '',
    '## Workflow guides',
    '',
    '| Guide | Covers |',
    '|---|---|',
    '| [Getting started](agenda.md) | Signing in |',
    '',
    '## Screen reference (left-hand admin sidebar)',
    '',
    '| Screen | Covers |',
    '|---|---|',
    '| [Workspace](index.md) | Shared tab mechanics |',
    '| ↳ [Speakers](workspace-speakers.md) | The Speakers tab |',
    '| [Missing](not-generated.md) | A page that does not exist |',
    '',
  ].join('\n')

  it('builds one section per heading, with the blurb column and ↳ nesting', () => {
    expect(parseNav(README, SLUGS)).toEqual([
      {
        title: 'Workflow guides',
        items: [{ slug: 'agenda', label: 'Getting started', blurb: 'Signing in', depth: 0 }],
      },
      {
        // The parenthetical is dropped: the rail is narrow, and "left-hand
        // admin sidebar" is exactly where the reader already is.
        title: 'Screen reference',
        items: [
          { slug: 'index', label: 'Workspace', blurb: 'Shared tab mechanics', depth: 0 },
          { slug: 'workspace-speakers', label: 'Speakers', blurb: 'The Speakers tab', depth: 1 },
        ],
      },
    ])
  })

  it('drops rows pointing at pages that were not generated', () => {
    const labels = parseNav(README, SLUGS).flatMap((section) => section.items.map((item) => item.label))
    expect(labels).not.toContain('Missing')
  })
})
