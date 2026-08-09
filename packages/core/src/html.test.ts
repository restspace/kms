import { describe, expect, it } from 'vitest';
import { sanitizeRichHtml } from './html';

describe('sanitizeRichHtml', () => {
  it('keeps the documented rich-text vocabulary', () => {
    expect(sanitizeRichHtml('<h2>Hello</h2><p><strong>Welcome</strong><br>Friend</p>'))
      .toBe('<h2>Hello</h2><p><strong>Welcome</strong><br>Friend</p>');
  });

  it('removes executable markup and unsafe URLs', () => {
    const result = sanitizeRichHtml(
      '<script>alert(1)</script><img src=x onerror=alert(2)>' +
      '<a href="javascript:alert(3)" onclick="alert(4)">Open</a>',
    );
    expect(result).toBe('<a>Open</a>');
  });

  it('rebuilds safe links and images without event attributes', () => {
    expect(sanitizeRichHtml(
      '<a href="https://example.com/?a=1&b=2" onclick="bad()">Link</a>' +
      '<img src="/files/1" alt="A &quot;photo&quot;" onerror="bad()">',
    )).toBe(
      '<a href="https://example.com/?a=1&amp;b=2" rel="noopener noreferrer">Link</a>' +
      '<img src="/files/1" alt="A &quot;photo&quot;">',
    );
  });
});
