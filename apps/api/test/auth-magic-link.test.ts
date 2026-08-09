// Magic links live in D1 now (sweep item P0-2): the callback consumes with a
// single conditional UPDATE, so a replayed or concurrently-opened link can
// mint at most one session and no KV `magic:` key is written any more.

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintToken } from '../src/tokens';
import { createContact, createEvent } from './fixtures';

const ORIGIN = 'https://kms.test';

let eventId: string;
let slug: string;

beforeEach(async () => {
  slug = `evt-${crypto.randomUUID().slice(0, 8)}`;
  eventId = await createEvent({ slug, name: 'Magic Link Conf' });
});

/** DEV_MODE=on returns the link in the response instead of only emailing it. */
async function requestDevLink(email: string): Promise<string> {
  const res = await SELF.fetch(`${ORIGIN}/auth/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email, event_slug: slug }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; dev_link?: string };
  expect(body.ok).toBe(true);
  expect(body.dev_link).toBeTruthy();
  return body.dev_link as string;
}

const tokenOf = (link: string): string => new URL(link).searchParams.get('t') ?? '';

const callback = (token: string) =>
  SELF.fetch(`${ORIGIN}/auth/callback?t=${encodeURIComponent(token)}`, { redirect: 'manual' });

describe('POST /auth/request', () => {
  it('stores only a hashed token row in D1 and no KV magic key', async () => {
    const link = await requestDevLink('speaker@example.com');
    const token = tokenOf(link);

    const rows = await env.DB.prepare('SELECT token_hash, purpose, consumed_at FROM auth_tokens').all<{
      token_hash: string;
      purpose: string;
      consumed_at: string | null;
    }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.purpose).toBe('portal-login');
    expect(rows.results[0]?.consumed_at).toBeNull();
    expect(rows.results[0]?.token_hash).not.toContain(token);

    const kv = await env.KV.list({ prefix: 'magic:' });
    expect(kv.keys).toHaveLength(0);
  });
});

describe('GET /auth/callback', () => {
  it('lets exactly one of two concurrent callbacks mint a session', async () => {
    const token = tokenOf(await requestDevLink('speaker@example.com'));

    const [a, b] = await Promise.all([callback(token), callback(token)]);
    const responses = [a, b];
    const winners = responses.filter((r) => r.status === 302 && r.headers.get('set-cookie') !== null);
    const losers = responses.filter((r) => r.status === 410);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]?.headers.get('location')).toBe(`/portal/${slug}`);
    expect(await losers[0]?.text()).toContain('This link has expired');
  });

  it('rejects a replayed link', async () => {
    const token = tokenOf(await requestDevLink('speaker@example.com'));
    expect((await callback(token)).status).toBe(302);
    expect((await callback(token)).status).toBe(410);
  });

  it('rejects an expired token', async () => {
    const contactId = await createContact(eventId, { email: 'late@example.com' });
    const { raw, statement } = await mintToken(env.DB, {
      contactId,
      eventId,
      purpose: 'portal-login',
      ttlSeconds: -60,
    });
    await statement.run();
    const res = await callback(raw);
    expect(res.status).toBe(410);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects an unknown token', async () => {
    expect((await callback('not-a-real-token')).status).toBe(410);
  });

  it('authenticates a submission-confirmation link straight into the portal', async () => {
    const contactId = await createContact(eventId, { email: 'submitter@example.com' });
    const { raw, statement } = await mintToken(env.DB, {
      contactId,
      eventId,
      purpose: 'submission-confirm',
      ttlSeconds: 3600,
    });
    await statement.run();

    const res = await callback(raw);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/portal/${slug}`);
    expect(res.headers.get('set-cookie')).toContain('kms_session=');
  });

  it('honours a same-origin redirect_to carried on the token', async () => {
    const contactId = await createContact(eventId, { email: 'redirect@example.com' });
    const { raw, statement } = await mintToken(env.DB, {
      contactId,
      eventId,
      purpose: 'portal-login',
      redirectTo: `/portal/${slug}/tasks`,
    });
    await statement.run();
    const res = await callback(raw);
    expect(res.headers.get('location')).toBe(`/portal/${slug}/tasks`);
  });

  it('ignores an off-site redirect_to', async () => {
    const contactId = await createContact(eventId, { email: 'evil@example.com' });
    const { raw, statement } = await mintToken(env.DB, {
      contactId,
      eventId,
      purpose: 'portal-login',
      redirectTo: '//evil.example.com/steal',
    });
    await statement.run();
    const res = await callback(raw);
    expect(res.headers.get('location')).toBe(`/portal/${slug}`);
  });
});
