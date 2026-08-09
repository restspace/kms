// Per-event revision marker in KV (sweep item P2-16). Writing routes bump it;
// the dashboard (and any other cached read) keys its ETag + KV payload cache
// on the current value, so a 304/hit costs zero D1 queries. Timestamps are
// good enough: KV has no atomic increment, and the only requirement is that
// the value *changes* after a relevant write.

import type { Env } from './env';

export async function bumpEventRevision(env: Env, eventId: string): Promise<void> {
  try {
    await env.KV.put(`rev:${eventId}`, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  } catch {
    // A missed bump only means one stale cache window (short TTL backstop).
  }
}

export async function getEventRevision(env: Env, eventId: string): Promise<string> {
  return (await env.KV.get(`rev:${eventId}`)) ?? '0';
}
