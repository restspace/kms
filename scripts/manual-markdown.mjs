// The manual markdown dialect, converted to HTML. Pure: no filesystem, no
// paths — scripts/build-manual.mjs supplies the files and writes the output,
// and scripts/manual-markdown.test.mjs exercises this half directly.
//
// A deliberately small block scanner rather than a markdown dependency: the
// manual uses one constrained dialect (headings, paragraphs, tables, nested
// bullet lists, ordered lists, blockquotes, fenced code, and bold/italic/code/
// link inlines — no images, no raw HTML, no reference links) and vendoring a
// parser for it would be more surface than the whole feature.

/** README.md is the manual's index; it becomes the `index` help page. */
export const INDEX_SLUG = 'index'

// ---------------------------------------------------------------------------
// inline rendering
// ---------------------------------------------------------------------------

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * GitHub-compatible heading slug, so `page.md#making-and-sending-decisions`
 * links written against GitHub's rendering keep working in the app.
 */
export function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
}

/**
 * Rewrite a markdown link target for the SPA. Links between manual pages
 * become Help routes (keeping any `#anchor`); anything pointing outside the
 * manual directory has no in-app destination, so the caller unwraps it to
 * plain text rather than shipping a dead link.
 */
function rewriteHref(href, knownSlugs) {
  const match = /^([A-Za-z0-9._-]+)\.md(#.*)?$/.exec(href)
  if (!match) return null
  const slug = match[1] === 'README' ? INDEX_SLUG : match[1]
  if (!knownSlugs.has(slug)) return null
  return `?v=help&page=${slug}${match[2] ?? ''}`
}

/**
 * Inline markup. Code spans are lifted out to placeholders first so that
 * `**` or `[` inside `code` is never treated as markup. The placeholder is
 * NUL-delimited, which can never occur in the source text.
 */
function renderInline(source, knownSlugs) {
  const codes = []
  let text = source.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`)
    return '\u0000' + (codes.length - 1) + '\u0000'
  })

  text = escapeHtml(text)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, href) => {
    const target = rewriteHref(href, knownSlugs)
    // Unresolvable target (an out-of-manual path like ../README.md): keep the
    // words, drop the link — the manual reads the same, minus a 404.
    if (target === null) return label
    return `<a href="${escapeHtml(target)}">${label}</a>`
  })
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>')

  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)])
}

// ---------------------------------------------------------------------------
// block rendering
// ---------------------------------------------------------------------------

const isBlank = (line) => line.trim().length === 0
const listMarker = (line) => /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line)
const isTableRow = (line) => /^\s*\|/.test(line)
const isTableDivider = (line) => /^\s*\|[\s:|-]+\|?\s*$/.test(line) && line.includes('-')

/**
 * Render a list starting at `start`. Returns the HTML and the index of the
 * first line after the list. Nesting is by indent width: a marker indented
 * more than the list's own opens a sub-list attached to the current item,
 * which is the only nesting shape the manual uses.
 */
function renderList(lines, start, knownSlugs) {
  const first = listMarker(lines[start])
  const baseIndent = first[1].length
  const ordered = /\d/.test(first[2])
  const items = []
  let index = start

  while (index < lines.length) {
    const line = lines[index]
    if (isBlank(line)) {
      // A blank line ends the list unless a deeper/equal marker follows it.
      const next = lines[index + 1]
      if (next === undefined || !listMarker(next) || listMarker(next)[1].length < baseIndent) break
      index += 1
      continue
    }
    const marker = listMarker(line)
    if (marker && marker[1].length <= baseIndent) {
      if (marker[1].length < baseIndent) break
      items.push({ parts: [marker[3]], children: [] })
      index += 1
      continue
    }
    if (items.length === 0) break
    const current = items[items.length - 1]
    if (marker) {
      // Deeper marker: recurse, and hand back the line the sub-list stopped on.
      const [html, next] = renderList(lines, index, knownSlugs)
      current.children.push(html)
      index = next
      continue
    }
    if (line.search(/\S/) > baseIndent) {
      // Continuation of the current item's text (the manual wraps at ~100 cols).
      current.parts.push(line.trim())
      index += 1
      continue
    }
    break
  }

  const tag = ordered ? 'ol' : 'ul'
  const body = items
    .map((item) => `<li>${renderInline(item.parts.join(' '), knownSlugs)}${item.children.join('')}</li>`)
    .join('')
  return [`<${tag}>${body}</${tag}>`, index]
}

function renderTable(lines, start, knownSlugs) {
  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())

  const header = cells(lines[start])
  let index = start + 2
  const rows = []
  while (index < lines.length && isTableRow(lines[index])) {
    rows.push(cells(lines[index]))
    index += 1
  }

  const head = header.map((cell) => `<th>${renderInline(cell, knownSlugs)}</th>`).join('')
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell, knownSlugs)}</td>`).join('')}</tr>`)
    .join('')
  // Wrapped so a wide table scrolls inside the column instead of stretching it.
  return [`<div class="manual-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`, index]
}

/** Block scanner. `headings` is filled in as an out-parameter for the page TOC. */
function renderBlocks(lines, knownSlugs, headings) {
  const out = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (isBlank(line)) {
      index += 1
      continue
    }

    const fence = /^\s*```(.*)$/.exec(line)
    if (fence) {
      const code = []
      index += 1
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      index += 1
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const text = heading[2].trim()
      const id = slugifyHeading(text)
      // h1 is the page title, rendered by the section header — skip it here.
      if (level > 1) {
        headings.push({ id, level, text })
        out.push(`<h${level} id="${id}">${renderInline(text, knownSlugs)}</h${level}>`)
      }
      index += 1
      continue
    }

    if (/^\s*>/.test(line)) {
      const quoted = []
      while (index < lines.length && (/^\s*>/.test(lines[index]) || (!isBlank(lines[index]) && quoted.length > 0 && /^\s{2,}\S/.test(lines[index])))) {
        quoted.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      out.push(`<blockquote>${renderBlocks(quoted, knownSlugs, headings)}</blockquote>`)
      continue
    }

    if (isTableRow(line) && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const [html, next] = renderTable(lines, index, knownSlugs)
      out.push(html)
      index = next
      continue
    }

    if (listMarker(line)) {
      const [html, next] = renderList(lines, index, knownSlugs)
      out.push(html)
      index = next
      continue
    }

    const paragraph = []
    while (
      index < lines.length &&
      !isBlank(lines[index]) &&
      !/^(#{1,6})\s/.test(lines[index]) &&
      !/^\s*>/.test(lines[index]) &&
      !/^\s*```/.test(lines[index]) &&
      !listMarker(lines[index]) &&
      !isTableRow(lines[index])
    ) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    out.push(`<p>${renderInline(paragraph.join(' '), knownSlugs)}</p>`)
  }

  return out.join('\n')
}

export function renderMarkdown(markdown, knownSlugs) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const headings = []
  const titleLine = lines.find((line) => /^#\s+/.test(line))
  const title = titleLine ? titleLine.replace(/^#\s+/, '').trim() : 'Manual'
  const html = renderBlocks(lines, knownSlugs, headings)
  return { title, html, headings }
}


// ---------------------------------------------------------------------------
// nav structure, read out of README.md
// ---------------------------------------------------------------------------

/**
 * The manual index tables ARE its navigation, so the sidebar is derived from
 * them rather than hand-maintained: each `## Section` followed by a table of
 * `| [Label](page.md) | blurb |` rows becomes a nav section, and a leading `↳`
 * marks a child entry (the workspace sub-tabs).
 */
export function parseNav(readme, knownSlugs) {
  const lines = readme.replace(/\r\n/g, '\n').split('\n')
  const sections = []
  let current = null

  for (const line of lines) {
    const heading = /^##\s+(.*)$/.exec(line)
    if (heading) {
      current = { title: heading[1].replace(/\s*\(.*\)\s*$/, '').trim(), items: [] }
      continue
    }
    if (!current || !isTableRow(line) || isTableDivider(line)) continue
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
    if (cells.length < 2) continue
    const label = cells[0].trim()
    const link = /^(↳\s*)?\[([^\]]+)\]\(([A-Za-z0-9._-]+)\.md\)$/.exec(label)
    if (!link) continue
    const slug = link[3] === 'README' ? INDEX_SLUG : link[3]
    if (!knownSlugs.has(slug)) continue
    current.items.push({ slug, label: link[2], blurb: cells[1].trim(), depth: link[1] ? 1 : 0 })
    if (!sections.includes(current)) sections.push(current)
  }

  return sections
}

