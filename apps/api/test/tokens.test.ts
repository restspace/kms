// Wave-0 smoke for the workers test project + the atomic token contract
// (sweep item P0-2 acceptance: concurrent callbacks cannot both succeed).
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { consumeToken, mintToken } from '../src/tokens';
import { createContact, createEvent } from './fixtures';

describe('auth_tokens', () => {
  it('consumes exactly once under concurrent attempts', async () => {
    const eventId = await createEvent();
    const contactId = await createContact(eventId);
    const { raw, statement } = await mintToken(env.DB, {
      contactId,
      eventId,
      purpose: 'portal-login',
    });
    await statement.run();

    const results = await Promise.all([
      consumeToken(env.DB, raw, ['portal-login']),
      consumeToken(env.DB, raw, ['portal-login']),
      consumeToken(env.DB, raw, ['portal-login']),
    ]);
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.contact_id).toBe(contactId);
  });

  it('rejects wrong-purpose and expired tokens', async () => {
    const eventId = await createEvent();
    const contactId = await createContact(eventId);

    const wrongPurpose = await mintToken(env.DB, { contactId, eventId, purpose: 'submission-confirm' });
    await wrongPurpose.statement.run();
    expect(await consumeToken(env.DB, wrongPurpose.raw, ['portal-login'])).toBeNull();

    const expired = await mintToken(env.DB, { contactId, eventId, purpose: 'portal-login', ttlSeconds: -60 });
    await expired.statement.run();
    expect(await consumeToken(env.DB, expired.raw, ['portal-login'])).toBeNull();
  });

  it('stores only the hash, never the raw token', async () => {
    const eventId = await createEvent();
    const contactId = await createContact(eventId);
    const { raw, statement } = await mintToken(env.DB, { contactId, eventId, purpose: 'portal-login' });
    await statement.run();
    const row = await env.DB.prepare('SELECT token_hash FROM auth_tokens').first<{ token_hash: string }>();
    expect(row?.token_hash).toBeTruthy();
    expect(row?.token_hash).not.toContain(raw);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
