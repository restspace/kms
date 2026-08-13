// Demo-reset email redirection (0043 + src/demoEmails.ts). Under test:
//  1. parseRedirectBase: what counts as a usable tester mailbox, and that an
//     already plus-addressed input does not nest a second tag.
//  2. Tag derivation: first names where distinctive, escalating to initial /
//     full surname / counter on collision, and stability across runs.
//  3. applyEmailRedirect against D1: speakers and reviewers rewritten, owner
//     and admin seats left alone, message_log kept in step with contacts.
//  4. The stored setting round-trips and a cleared one disables redirection.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyEmailRedirect,
  buildRedirectMap,
  parseRedirectBase,
  readRedirectEmail,
  writeRedirectEmail,
} from '../src/demoEmails';

const ts = '2026-08-01T00:00:00Z';

/**
 * A miniature stand-in for the demo organisation: applyEmailRedirect finds its
 * contacts by the seed's `ai-engineer` slug, so the fixture has to use it too.
 * Storage persists across it() blocks in this pool, hence the teardown-first
 * shape — every test starts from an empty demo org.
 */
async function seedDemoOrg(): Promise<{ eventId: string; ids: Record<string, string> }> {
  await env.DB.prepare("DELETE FROM organisations WHERE slug = 'ai-engineer'").run();
  await env.DB.prepare('DELETE FROM demo_settings').run();

  const orgId = 'org-demo-redirect';
  const eventId = 'evt-demo-redirect';
  await env.DB.prepare('INSERT INTO organisations (id, name, slug, created_at) VALUES (?, ?, ?, ?)')
    .bind(orgId, 'AI Engineer', 'ai-engineer', ts)
    .run();
  await env.DB.prepare(
    `INSERT INTO events (id, org_id, name, slug, type, timezone, starts_at, ends_at, default_submission_limit, agenda_published, created_at, updated_at)
     VALUES (?, ?, 'Demo', 'demo', 'conference', 'UTC', ?, ?, 3, 0, ?, ?)`,
  )
    .bind(eventId, orgId, ts, ts, ts, ts)
    .run();

  const people: Array<[string, string, string, string, string | null]> = [
    // id, email, first, last, event_users role (null = no seat)
    ['con-owner', 'james@atelyr.com', 'James', 'Ellis-Jones', 'owner'],
    ['con-admin', 'ops@atelyr.com', 'Dana', 'Ops', 'admin'],
    ['con-ada', 'ada@example.com', 'Ada', 'Lovelace', null],
    ['con-grace', 'grace.hopper@example.com', 'Grace', 'Hopper', null],
    ['con-ada2', 'ada.byron@example.com', 'Ada', 'Byron', null],
    ['con-rosalind', 'rosalind.franklin@example.com', 'Rosalind', 'Franklin', 'reviewer'],
  ];
  const ids: Record<string, string> = {};
  for (const [id, email, first, last, role] of people) {
    ids[id] = id;
    await env.DB.prepare(
      'INSERT INTO contacts (id, org_id, email, first_name, last_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(id, orgId, email, first, last, ts, ts)
      .run();
    if (role) {
      await env.DB.prepare(
        'INSERT INTO event_users (event_id, contact_id, role, invited_at, accepted_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind(eventId, id, role, ts, ts)
        .run();
    }
  }
  return { eventId, ids };
}

describe('parseRedirectBase', () => {
  it('splits a plain address', () => {
    expect(parseRedirectBase('tester@atelyr.com')).toEqual({ local: 'tester', domain: 'atelyr.com' });
  });

  it('drops an existing +tag instead of nesting a second one', () => {
    // A tester pasting back a generated address must not get you+ada+grace@…
    expect(parseRedirectBase('tester+ada@atelyr.com')).toEqual({ local: 'tester', domain: 'atelyr.com' });
  });

  it('lowercases the domain but preserves the local part', () => {
    expect(parseRedirectBase(' Tester.QA@Atelyr.COM ')).toEqual({ local: 'Tester.QA', domain: 'atelyr.com' });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['tester', 'no domain'],
    ['tester@localhost', 'domain without a dot'],
    ['@atelyr.com', 'no local part'],
    ['+ada@atelyr.com', 'local part is only a tag'],
    ['a@b.com, c@d.com', 'a list'],
    ['Tester <tester@atelyr.com>', 'a display name'],
  ])('rejects %j (%s)', (input) => {
    expect(parseRedirectBase(input)).toBeNull();
  });
});

describe('buildRedirectMap', () => {
  const base = { local: 'tester', domain: 'atelyr.com' };

  it('uses the first name where it is distinctive', () => {
    const map = buildRedirectMap(
      [
        { id: '1', email: null, first_name: 'Ada', last_name: 'Lovelace' },
        { id: '2', email: null, first_name: 'Grace', last_name: 'Hopper' },
      ],
      base,
    );
    expect(map.get('1')).toBe('tester+ada@atelyr.com');
    expect(map.get('2')).toBe('tester+grace@atelyr.com');
  });

  it('escalates to surname initial, then full surname, then a counter', () => {
    const map = buildRedirectMap(
      [
        { id: '1', email: null, first_name: 'Ada', last_name: 'Lovelace' },
        { id: '2', email: null, first_name: 'Ada', last_name: 'Lyon' },
        { id: '3', email: null, first_name: 'Ada', last_name: 'Lyon' },
        { id: '4', email: null, first_name: 'Ada', last_name: null },
      ],
      base,
    );
    expect([...map.values()]).toEqual([
      'tester+ada@atelyr.com',
      'tester+adal@atelyr.com',
      'tester+adalyon@atelyr.com',
      'tester+ada2@atelyr.com',
    ])
  });

  it('strips accents and punctuation, and names an unnamed contact', () => {
    const map = buildRedirectMap(
      [
        { id: '1', email: null, first_name: 'Renée', last_name: "O'Brien" },
        { id: '2', email: null, first_name: null, last_name: null },
      ],
      base,
    );
    expect(map.get('1')).toBe('tester+renee@atelyr.com');
    expect(map.get('2')).toBe('tester+contact@atelyr.com');
  });

  it('is stable: the same input always yields the same addresses', () => {
    const contacts = [
      { id: '1', email: null, first_name: 'Ada', last_name: 'Lovelace' },
      { id: '2', email: null, first_name: 'Ada', last_name: 'Byron' },
    ];
    expect([...buildRedirectMap(contacts, base)]).toEqual([...buildRedirectMap(contacts, base)]);
  });
});

describe('applyEmailRedirect', () => {
  let fixture: Awaited<ReturnType<typeof seedDemoOrg>>;

  beforeEach(async () => {
    fixture = await seedDemoOrg();
  });

  const emailOf = async (id: string): Promise<string | null> =>
    (await env.DB.prepare('SELECT email FROM contacts WHERE id = ?').bind(id).first<{ email: string }>())?.email ?? null;

  it('rewrites speakers and reviewers but leaves owner and admin seats alone', async () => {
    const count = await applyEmailRedirect(env.DB, 'tester@atelyr.com');

    expect(count).toBe(4);
    // The sign-in the tester is using must survive the reset.
    expect(await emailOf('con-owner')).toBe('james@atelyr.com');
    expect(await emailOf('con-admin')).toBe('ops@atelyr.com');
    expect(await emailOf('con-ada')).toBe('tester+ada@atelyr.com');
    expect(await emailOf('con-grace')).toBe('tester+grace@atelyr.com');
    // Reviewers are demo participants, not organisers: they get redirected.
    expect(await emailOf('con-rosalind')).toBe('tester+rosalind@atelyr.com');
    // Second Ada takes the disambiguated tag rather than colliding.
    expect(await emailOf('con-ada2')).toBe('tester+adab@atelyr.com');
  });

  it('keeps message_log addresses in step with the contacts they belong to', async () => {
    await env.DB.prepare(
      `INSERT INTO message_log (id, event_id, template_key, to_email, contact_id, subject, status, idempotency_key, created_at)
       VALUES ('msg-redirect-1', ?, 'task_reminder', 'ada@example.com', 'con-ada', 'Reminder', 'sent', 'test:redirect:1', ?)`,
    )
      .bind(fixture.eventId, ts)
      .run();

    await applyEmailRedirect(env.DB, 'tester@atelyr.com');

    const row = await env.DB.prepare('SELECT to_email FROM message_log WHERE id = ?')
      .bind('msg-redirect-1')
      .first<{ to_email: string }>();
    expect(row?.to_email).toBe('tester+ada@atelyr.com');
  });

  it('is a no-op for a missing or unusable address', async () => {
    expect(await applyEmailRedirect(env.DB, null)).toBe(0);
    expect(await applyEmailRedirect(env.DB, 'not-an-address')).toBe(0);
    expect(await emailOf('con-ada')).toBe('ada@example.com');
  });

  it('re-running over already redirected contacts is idempotent', async () => {
    await applyEmailRedirect(env.DB, 'tester@atelyr.com');
    await applyEmailRedirect(env.DB, 'tester@atelyr.com');
    expect(await emailOf('con-ada')).toBe('tester+ada@atelyr.com');
  });
});

describe('demo_settings', () => {
  beforeEach(async () => {
    await env.DB.prepare('DELETE FROM demo_settings').run();
  });

  it('round-trips the tester mailbox and can be cleared', async () => {
    expect(await readRedirectEmail(env.DB)).toBeNull();

    await writeRedirectEmail(env.DB, 'tester@atelyr.com', ts);
    expect(await readRedirectEmail(env.DB)).toBe('tester@atelyr.com');

    // Singleton: a second write updates rather than failing on the PK.
    await writeRedirectEmail(env.DB, 'other@atelyr.com', ts);
    expect(await readRedirectEmail(env.DB)).toBe('other@atelyr.com');

    await writeRedirectEmail(env.DB, null, ts);
    expect(await readRedirectEmail(env.DB)).toBeNull();
  });
});
