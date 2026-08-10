import { describe, expect, it } from 'vitest';
import { tokensCss } from '@kms/theme';
import { applyTheme, renderTemplate } from './render';

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

describe('email theme defaults track the app token layer', () => {
  // Email is "sympathetic to", not "identical to", the app (workplan §4): the
  // heading face is a stack rather than the real webfont, and radii are near
  // square because Outlook drops them. But the *colours* must not drift, so
  // read them back out of the shared tokens rather than restating them here.
  const light = tokensCss.slice(0, tokensCss.indexOf('@media'))
  const token = (name: string) => new RegExp(`${name}:(#[0-9a-f]{6})`).exec(light)![1]!

  const html = applyTheme('<p>Body</p>', 'Subject', null, 'Test Event')

  it('uses the app accent for the header band and buttons', () => {
    expect(html).toContain(`background:${token('--accent')}`)
  })

  it('uses the app paper ground', () => {
    expect(html).toContain(`background:${token('--bg')}`)
  })

  it('uses the app body-text colour', () => {
    expect(html).toContain(`color:${token('--text')}`)
  })

  it('sets headings in a serif stack, never a webfont', () => {
    expect(html).toMatch(/font-family:Georgia, 'Times New Roman', Times, serif/)
    expect(html).not.toContain('Source Serif 4')
    expect(html).not.toContain('@font-face')
  })

  it('keeps every colour an Outlook-safe literal hex', () => {
    expect(html).not.toContain('var(--')
    expect(html).not.toContain('color-mix')
    expect(html).not.toContain('oklch')
  })
})
