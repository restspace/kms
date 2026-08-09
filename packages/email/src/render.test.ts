import { describe, expect, it } from 'vitest';
import { renderTemplate } from './render';

describe('renderTemplate', () => {
  it('escapes public values interpolated into email HTML', () => {
    const rendered = renderTemplate('submission_confirmation', null, null, {
      event: { name: 'Test Event' },
      submission: { title: '<img src=x onerror=alert(1)>', code: 'SESS-1' },
      portal_url: 'https://example.com/portal?a=1&b=2',
    });
    expect(rendered?.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(rendered?.html).not.toContain('<img src=x');
    expect(rendered?.html).toContain('https://example.com/portal?a=1&amp;b=2');
  });

  it('removes line breaks from subjects', () => {
    const rendered = renderTemplate('magic_link', {
      subject: 'Hello {{event.name}}', body_richtext: '<p>Hi</p>', enabled: 1,
    }, null, { event: { name: 'A\r\nBcc: victim@example.com' } });
    expect(rendered?.subject).toBe('Hello A Bcc: victim@example.com');
  });
});
