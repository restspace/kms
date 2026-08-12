// Password authentication (0032 auth_credentials): PBKDF2 hashing, portal
// sign-up behind a confirmation link, password login for the portal and /app,
// the staff set-password route, and the failed-attempt throttle.
//
// CAUTION (vitest.config.ts): D1/KV storage persists across it() blocks in one
// file, so every fixture below is scoped to ids it created itself.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { constantTimeEqual, hashPassword, verifyPassword } from '../src/password';
import { createContact, createEvent, createEventUser } from './fixtures';
import { jsonReq, seedContact, seedEvent, seedStaff } from './fixtures-admin';

const ORIGIN = 'https://kms.test';
const ts = '2026-08-01T00:00:00Z';

const form = (fields: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
  redirect: 'manual',
});

const postJson = (path: string, body: unknown): Promise<Response> =>
  SELF.fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
  });

const tokenOf = (link: string): string => new URL(link).searchParams.get('t') ?? '';

/** A fresh event + a contact on its roster. */
async function fixture(email: string) {
  const slug = `pw-${crypto.randomUUID().slice(0, 8)}`;
  const eventId = await createEvent({ slug, name: 'Password Conf' });
  const contactId = await createContact(eventId, { email });
  return { slug, eventId, contactId };
}

const credentialOf = (contactId: string) =>
  env.DB.prepare(
    'SELECT password_hash, salt, pending_hash, pending_salt, iterations, set_at FROM auth_credentials WHERE contact_id = ?',
  )
    .bind(contactId)
    .first<{
      password_hash: string | null;
      salt: string | null;
      pending_hash: string | null;
      pending_salt: string | null;
      iterations: number;
      set_at: string | null;
    }>();

/** Write an already-active credential, as the seed and the staff route do. */
async function setActivePassword(contactId: string, password: string): Promise<void> {
  const { hash, salt, iterations } = await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO auth_credentials (contact_id, password_hash, salt, algo, iterations, set_at, created_at)
     VALUES (?, ?, ?, 'pbkdf2-sha256', ?, ?, ?)
     ON CONFLICT (contact_id) DO UPDATE SET password_hash = excluded.password_hash,
       salt = excluded.salt, iterations = excluded.iterations, set_at = excluded.set_at`,
  )
    .bind(contactId, hash, salt, iterations, ts, ts)
    .run();
}

describe('password hashing', () => {
  it('round-trips a password and rejects the wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(await verifyPassword('correct horse battery stapler', stored)).toBe(false);
    expect(stored.iterations).toBe(100_000);
  });

  it('salts every password separately, so equal passwords never share a hash', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    // Each still verifies against its own salt.
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('constantTimeEqual compares content and length', () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});

describe('POST /auth/signup', () => {
  it('stores the password as pending only, and refuses it at login until the link is opened', async () => {
    const f = await fixture('pending@example.com');

    const res = await postJson('/auth/signup', {
      email: 'pending@example.com',
      password: 'hunter2-hunter2',
      event_slug: f.slug,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dev_link?: string };
    expect(body.ok).toBe(true);
    expect(body.dev_link).toBeTruthy();

    const cred = await credentialOf(f.contactId);
    expect(cred?.pending_hash).toBeTruthy();
    expect(cred?.pending_salt).toBeTruthy();
    expect(cred?.password_hash).toBeNull();
    expect(cred?.salt).toBeNull();

    // Nothing authenticates against pending_*.
    const login = await postJson('/auth/login', {
      email: 'pending@example.com',
      password: 'hunter2-hunter2',
      event_slug: f.slug,
    });
    expect(login.status).toBe(401);
    expect(await login.json()).toEqual({ ok: false, error: 'invalid_credentials' });
    expect(login.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a password shorter than 8 characters by re-rendering the signup page', async () => {
    const f = await fixture('short@example.com');
    const res = await SELF.fetch(
      `${ORIGIN}/auth/signup`,
      form({ email: 'short@example.com', password: 'short', event_slug: f.slug }),
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('at least 8 characters');
    expect(html).toContain('/auth/signup');
    expect(await credentialOf(f.contactId)).toBeNull();
  });

  it('answers an unknown address exactly as a known one, and creates nothing', async () => {
    const f = await fixture('known@example.com');
    const stripDevLink = (html: string) => html.replace(/<div class="devlink">[\s\S]*?<\/div>/, '');

    const known = await SELF.fetch(
      `${ORIGIN}/auth/signup`,
      form({ email: 'known@example.com', password: 'a-good-password', event_slug: f.slug }),
    );
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_credentials').first<{ n: number }>();
    const unknown = await SELF.fetch(
      `${ORIGIN}/auth/signup`,
      form({ email: 'stranger@example.com', password: 'a-good-password', event_slug: f.slug }),
    );

    expect(unknown.status).toBe(known.status);
    // Identical page. The DEV_MODE dev-link block is the one difference, and it
    // is a dev-only carve-out that /auth/request has always had — production
    // (DEV_MODE off) emits neither side.
    const knownHtml = stripDevLink(await known.text());
    const unknownHtml = stripDevLink(await unknown.text());
    expect(unknownHtml).not.toContain('known@example.com');
    expect(knownHtml.replace('known@example.com', 'stranger@example.com')).toBe(unknownHtml);

    // No contact conjured, no credential row for the stranger.
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_credentials').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('never clobbers an active password — the old one still works before confirmation', async () => {
    const f = await fixture('keeper@example.com');
    await setActivePassword(f.contactId, 'original-password');

    const res = await postJson('/auth/signup', {
      email: 'keeper@example.com',
      password: 'attacker-password',
      event_slug: f.slug,
    });
    expect(res.status).toBe(200);

    const cred = await credentialOf(f.contactId);
    expect(cred?.pending_hash).toBeTruthy();
    expect(await verifyPassword('original-password', {
      hash: cred!.password_hash!,
      salt: cred!.salt!,
      iterations: cred!.iterations,
    })).toBe(true);

    const good = await postJson('/auth/login', {
      email: 'keeper@example.com',
      password: 'original-password',
      event_slug: f.slug,
    });
    expect(good.status).toBe(200);
    const bad = await postJson('/auth/login', {
      email: 'keeper@example.com',
      password: 'attacker-password',
      event_slug: f.slug,
    });
    expect(bad.status).toBe(401);
  });
});

describe('GET /auth/callback (password activation)', () => {
  it('promotes the pending password, attaches the roster row and signs the speaker in', async () => {
    const slug = `pw-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = await createEvent({ slug, name: 'Activation Conf' });
    // Org contact who is NOT yet on this event's roster: the callback attaches.
    const otherEvent = await createEvent({ slug: `${slug}-other` });
    const orgId = (await env.DB.prepare('SELECT org_id FROM events WHERE id = ?').bind(eventId).first<{ org_id: string }>())!.org_id;
    await env.DB.prepare('UPDATE events SET org_id = ? WHERE id = ?').bind(orgId, otherEvent).run();
    const contactId = await createContact(otherEvent, { email: 'activate@example.com' });

    const signup = await postJson('/auth/signup', {
      email: 'activate@example.com',
      password: 'activate-me-please',
      event_slug: slug,
    });
    const { dev_link: link } = (await signup.json()) as { dev_link: string };

    const cb = await SELF.fetch(`${ORIGIN}/auth/callback?t=${encodeURIComponent(tokenOf(link))}`, {
      redirect: 'manual',
    });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('set-cookie')).toContain('kms_session=');
    expect(cb.headers.get('location')).toBe(`/portal/${slug}`);

    const cred = await credentialOf(contactId);
    expect(cred?.pending_hash).toBeNull();
    expect(cred?.pending_salt).toBeNull();
    expect(cred?.password_hash).toBeTruthy();
    expect(cred?.set_at).toBeTruthy();

    const roster = await env.DB.prepare('SELECT 1 AS ok FROM event_contacts WHERE event_id = ? AND contact_id = ?')
      .bind(eventId, contactId).first();
    expect(roster).toBeTruthy();

    // And now the password works.
    const login = await postJson('/auth/login', {
      email: 'activate@example.com',
      password: 'activate-me-please',
      event_slug: slug,
    });
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ ok: true, redirect_to: `/portal/${slug}` });
    const cookie = login.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('kms_session=');
    const payload = JSON.parse(
      atob((cookie.split('kms_session=')[1] ?? '').split(';')[0]!.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { role: string; email: string; eventSlug: string };
    expect(payload.role).toBe('speaker');
    expect(payload.email).toBe('activate@example.com');
    expect(payload.eventSlug).toBe(slug);
  });
});

describe('POST /auth/login', () => {
  it('answers a wrong password and an unknown address identically', async () => {
    const f = await fixture('generic@example.com');
    await setActivePassword(f.contactId, 'the-real-password');

    const wrong = await SELF.fetch(
      `${ORIGIN}/auth/login`,
      form({ email: 'generic@example.com', password: 'not-it-at-all', event_slug: f.slug }),
    );
    const unknown = await SELF.fetch(
      `${ORIGIN}/auth/login`,
      form({ email: 'ghost@example.com', password: 'not-it-at-all', event_slug: f.slug }),
    );
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    expect(unknown.headers.get('set-cookie')).toBeNull();
    // Same page, same message; only the echoed address differs.
    const wrongHtml = (await wrong.text()).replace(/generic@example\.com/g, 'X');
    const unknownHtml = (await unknown.text()).replace(/ghost@example\.com/g, 'X');
    expect(wrongHtml).toBe(unknownHtml);
    expect(wrongHtml).toContain('Invalid email or password');
  });

  it('signs an owner into /app and the workspace gate accepts the cookie', async () => {
    const slug = `pw-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = await createEvent({ slug, name: 'Owner Conf' });
    const contactId = await createContact(eventId, { email: 'owner@example.com' });
    await createEventUser(eventId, contactId, 'owner');
    await setActivePassword(contactId, 'owner-password-1');

    const res = await postJson('/auth/login', {
      email: 'owner@example.com',
      password: 'owner-password-1',
      event_slug: slug,
      surface: 'admin',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, redirect_to: '/app' });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(cookie).toContain('kms_session=');

    const app = await SELF.fetch(`${ORIGIN}/app`, { headers: { cookie } });
    expect(app.status).toBe(200);
  });

  it('re-renders the admin login page when surface=admin', async () => {
    const f = await fixture('adminsurface@example.com');
    const res = await SELF.fetch(
      `${ORIGIN}/auth/login`,
      form({ email: 'adminsurface@example.com', password: 'nope-nope', event_slug: f.slug, surface: 'admin' }),
    );
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('Admin sign in');
    expect(html).toContain('Invalid email or password');
  });

  it('throttles repeated failures without ever changing what it says', async () => {
    const f = await fixture('throttled@example.com');
    await setActivePassword(f.contactId, 'throttle-password');

    let last: Response | null = null;
    for (let i = 0; i < 11; i++) {
      last = await postJson('/auth/login', {
        email: 'throttled@example.com',
        password: `wrong-${i}`,
        event_slug: f.slug,
      });
      expect(last.status).toBe(401);
    }
    expect(await last!.json()).toEqual({ ok: false, error: 'invalid_credentials' });

    const keys = await env.KV.list({ prefix: 'pwfail:' });
    expect(keys.keys.length).toBeGreaterThan(0);

    // Over budget, even the right password is turned away for the window.
    const correct = await postJson('/auth/login', {
      email: 'throttled@example.com',
      password: 'throttle-password',
      event_slug: f.slug,
    });
    expect(correct.status).toBe(401);
    // 12 real PBKDF2 verifications at 100k iterations — needs headroom under
    // full-suite parallel load, where the default 5s budget flakes.
  }, 30_000);
});

describe('PUT /app/api/contacts/:id/password', () => {
  const api = (path: string, cookie: string, body?: unknown, method = 'PUT') =>
    SELF.fetch(`${ORIGIN}/app/api${path}`, jsonReq(cookie, body, method));

  it('lets an admin set a speaker password that then works at login', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'setme@example.com' });
    const slug = (await env.DB.prepare('SELECT slug FROM events WHERE id = ?').bind(eventId).first<{ slug: string }>())!.slug;

    const res = await api(`/contacts/${speaker}/password`, admin.cookie, { password: 'staff-set-password' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const cred = await credentialOf(speaker);
    expect(cred?.password_hash).toBeTruthy();
    expect(cred?.pending_hash).toBeNull();

    const login = await postJson('/auth/login', {
      email: 'setme@example.com',
      password: 'staff-set-password',
      event_slug: slug,
    });
    expect(login.status).toBe(200);
  });

  it('rejects a short password, a reviewer session and an off-roster contact', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedStaff(eventId, 'reviewer');
    const speaker = await seedContact(eventId, { email: 'guarded@example.com' });
    const foreign = await seedContact(await seedEvent(), { email: 'foreign@example.com' });

    expect((await api(`/contacts/${speaker}/password`, admin.cookie, { password: 'short' })).status).toBe(400);
    expect((await api(`/contacts/${speaker}/password`, reviewer.cookie, { password: 'long-enough-pw' })).status).toBe(403);
    expect((await api(`/contacts/${foreign}/password`, admin.cookie, { password: 'long-enough-pw' })).status).toBe(404);
    expect(await credentialOf(speaker)).toBeNull();
  });
});
