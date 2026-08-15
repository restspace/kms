// The front door carries a "Testers please read" banner pointing at the two
// orientation documents in the repo. It is the first thing a cold visitor sees
// and nothing else on the page depends on it, which is exactly how a banner
// goes missing in a refactor unnoticed — hence this guard.

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const DOCS = 'https://github.com/restspace/kms/blob/main/docs';

describe('GET / — testers notice', () => {
  it('leads with the notice and links both documents, on a bare install too', async () => {
    // No event seeded in this file's isolated D1, so this also covers the
    // "nothing here yet" branch of the page.
    const res = await SELF.fetch('https://example.com/');
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('Testers please read');
    expect(html).toContain(`${DOCS}/Intro.md`);
    expect(html).toContain(`${DOCS}/SuppliedExtras.md`);

    // Above the heading, and Intro above Extras — the order is the point.
    expect(html.indexOf('Testers please read')).toBeLessThan(html.indexOf('<h1>'));
    expect(html.indexOf('/Intro.md')).toBeLessThan(html.indexOf('/SuppliedExtras.md'));

    // Off-site links must not hand the repo an opener reference.
    for (const doc of ['Intro.md', 'SuppliedExtras.md']) {
      const anchor = html.slice(html.indexOf(`${DOCS}/${doc}`));
      expect(anchor.slice(0, 120)).toContain('rel="noopener noreferrer"');
    }
  });
});
