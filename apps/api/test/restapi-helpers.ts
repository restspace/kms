// Shared, non-test helpers for the restApi.ts (/api/v1) test files (BE-5).
// Not itself a test — fixtures.ts/fixtures-admin.ts are the frozen/concurrent
// seed helpers; api_tokens seeding lives here since neither owns it.

import { env } from 'cloudflare:test';
import { sha256Hex } from '../src/hashing';

const ts = '2026-08-01T00:00:00Z';

/** Mint an api_tokens row directly (bypassing the admin /tokens endpoint) and
 * return the raw bearer value, matching the `kms_<hex>` shape restApi.ts expects. */
export async function seedApiToken(orgId: string, name = 'Test token'): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const raw = 'kms_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare(
    `INSERT INTO api_tokens (id, org_id, name, token_hash, token_prefix, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(`tok-${crypto.randomUUID()}`, orgId, name, await sha256Hex(raw), raw.slice(0, 12), ts)
    .run();
  return raw;
}

export const bearerReq = (token: string, body?: unknown, method = 'GET', extraHeaders: Record<string, string> = {}): RequestInit => ({
  method,
  headers: {
    authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...extraHeaders,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export async function orgIdForEvent(eventId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT org_id FROM events WHERE id = ?').bind(eventId).first<{ org_id: string }>();
  if (!row) throw new Error(`no such event: ${eventId}`);
  return row.org_id;
}
