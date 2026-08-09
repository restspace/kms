// Small, dependency-free rich-text allowlist for content rendered on public
// pages. Recognised tags are rebuilt with canonical attributes; input markup
// is never copied verbatim, so malformed HTML fails closed.

const CONTAINER_TAGS = new Set([
  'p', 'div', 'blockquote', 'pre', 'code',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'u', 's',
]);

const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

function escapeText(value: string): string {
  return value
    .replace(/&(?!#\d+;|#x[\da-f]+;|amp;|lt;|gt;|quot;|apos;)/gi, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function readAttribute(source: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`,
    'i',
  ).exec(source);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

function safeUrl(value: string, image = false): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!image && /^mailto:[^\s@]+@[^\s@]+$/i.test(trimmed)) return trimmed;
  return null;
}

/** Sanitize the deliberately small rich-text vocabulary used by CFP copy. */
export function sanitizeRichHtml(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const source = input.replace(DROP_WITH_CONTENT, '');
  let output = '';
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    if (open === -1) {
      output += escapeText(source.slice(cursor));
      break;
    }
    output += escapeText(source.slice(cursor, open));
    const close = source.indexOf('>', open + 1);
    if (close === -1) {
      output += escapeText(source.slice(open));
      break;
    }

    const token = source.slice(open, close + 1);
    const parsed = /^<\s*(\/?)\s*([a-z][\w-]*)\b([^>]*)>$/i.exec(token);
    if (parsed) {
      const closing = parsed[1] === '/';
      const tag = parsed[2]!.toLowerCase();
      const attrs = parsed[3] ?? '';
      if (CONTAINER_TAGS.has(tag)) {
        output += closing ? `</${tag}>` : `<${tag}>`;
      } else if (tag === 'br' && !closing) {
        output += '<br>';
      } else if (tag === 'a') {
        if (closing) output += '</a>';
        else {
          const href = readAttribute(attrs, 'href');
          const safe = href === null ? null : safeUrl(href);
          output += safe
            ? `<a href="${escapeAttribute(safe)}" rel="noopener noreferrer">`
            : '<a>';
        }
      } else if (tag === 'img' && !closing) {
        const src = readAttribute(attrs, 'src');
        const safe = src === null ? null : safeUrl(src, true);
        if (safe) {
          const alt = readAttribute(attrs, 'alt') ?? '';
          output += `<img src="${escapeAttribute(safe)}" alt="${escapeAttribute(alt)}">`;
        }
      }
    }
    cursor = close + 1;
  }

  return output;
}
