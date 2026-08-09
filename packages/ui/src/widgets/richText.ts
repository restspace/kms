/**
 * Organiser-authored rich text → safe display text.
 *
 * Session descriptions (and anything else typed into the submission form's
 * rich-text questions) arrive as HTML. The public widgets never inject markup —
 * they render text nodes — so a widget that treats the value as plain text
 * shows the tags verbatim ("<p>Lorem…</p>"), which is what the agenda modal
 * did. Strip the markup instead, splitting on block boundaries so paragraphing
 * survives the trip.
 */

/** Sentinel used while turning block-level markup into paragraph breaks. */
const BREAK = '\u0000'

const BLOCK_BOUNDARY = /<\/(?:p|div|li|h[1-6]|blockquote|tr|ul|ol)\s*>|(?:<br\s*\/?>\s*){2,}/gi

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match
    }
    return ENTITIES[body.toLowerCase()] ?? match
  })
}

/** Tags out, entities decoded, whitespace collapsed — safe for a single line. */
export function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Paragraphs of plain text. Handles both HTML (block tags end a paragraph) and
 * plain text with blank-line paragraphing, so it stays correct on legacy rows
 * that were never rich text.
 */
export function toParagraphs(value: string): string[] {
  const looksLikeHtml = /<[a-z!/][^>]*>/i.test(value)
  const source = looksLikeHtml
    ? value.replace(BLOCK_BOUNDARY, BREAK)
    : value.replace(/\n{2,}/g, BREAK)
  return source
    .split(BREAK)
    .map((chunk) => stripHtml(chunk))
    .filter((chunk) => chunk.length > 0)
}
