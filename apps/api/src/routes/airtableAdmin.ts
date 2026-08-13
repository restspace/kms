// Airtable mirror settings (Settings page). Moves the sweep's gating out of
// wrangler.toml/env secrets into a UI-editable singleton row
// (airtable_settings, 0041) — resolveAirtableConfig (jobs/airtableSync.ts)
// reads the row first and falls back to the env vars, so env-configured
// deployments keep working.
//
// Mounted at /app/api/airtable from app.ts, after the /app/api mount so the
// shared admin guard runs first (same convention as filesAdmin.ts/chase.ts);
// the guard below is the defensive re-resolution those files carry too.
// Reviewers never reach these routes: the shared guard 403s them off every
// non-reviewer surface, and the defensive guard here requires admin.view.
//
// Security: the stored PAT never leaves the server. GET/PUT respond with
// key_set + the last 4 characters only, and the test-connection endpoint
// scrubs the key out of any upstream error text before returning it.

import { Hono } from 'hono';
import { can } from '@kms/core';
import type { Actor } from '@kms/core';
import { AirtableClient, SYNC_TABLES } from '@kms/airtable';
import type { AccessEnv } from '../access';
import type { Env } from '../env';
import { resolveAirtableConfig } from '../jobs/airtableSync';
import { getRevalidatedPrivilegedSession } from '../session';

interface SettingsRow {
  enabled: number;
  api_key: string | null;
  base_id: string | null;
}

const loadRow = (db: D1Database) =>
  db.prepare('SELECT enabled, api_key, base_id FROM airtable_settings WHERE id = 1').first<SettingsRow>();

/** The only shape the key ever leaves the server in. */
const maskedJson = (row: SettingsRow | null) => ({
  enabled: row?.enabled === 1,
  base_id: row?.base_id ?? '',
  key_set: Boolean(row?.api_key),
  key_last4: row?.api_key ? row.api_key.slice(-4) : null,
});

export type MakeClient = (opts: { apiKey: string; baseId: string }) => AirtableClient;

/**
 * Factory so tests can swap the Airtable client the test-connection probe
 * builds (workers tests must not dial api.airtable.com). Production uses the
 * `airtableAdminRoutes` instance below with the real client.
 */
export function createAirtableAdminRoutes(
  makeClient: MakeClient = (opts) =>
    // Probe client: fail fast instead of sleeping through Airtable's 30s 429
    // penalty window — a rate-limited probe should say so, not hang the tab.
    new AirtableClient({ ...opts, minIntervalMs: 0, maxRetries: 0 }),
) {
  const routes = new Hono<AccessEnv>();

  routes.use('*', async (c, next) => {
    if (!c.get('session')) {
      const session = await getRevalidatedPrivilegedSession(c);
      if (!session) return c.json({ error: 'unauthenticated' }, 401);
      c.set('session', session);
    }
    const session = c.get('session');
    const actor: Actor = { contactId: session.contactId, email: session.email, role: session.role };
    // Organiser configuration, never reviewer-visible (admin.view = admin/owner).
    if (!can(actor, 'admin.view')) return c.json({ error: 'forbidden' }, 403);
    await next();
  });

  /** GET /app/api/airtable/settings — masked view of the singleton row. */
  routes.get('/settings', async (c) => {
    return c.json(maskedJson(await loadRow(c.env.DB)));
  });

  /**
   * PUT /app/api/airtable/settings { enabled?, base_id?, api_key? } — upsert
   * the singleton. An absent/empty api_key keeps the stored one, so the UI can
   * save the toggle or base id without re-entering the secret.
   */
  routes.put('/settings', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const existing = await loadRow(c.env.DB);

    const enabled = typeof body.enabled === 'boolean' ? body.enabled : existing?.enabled === 1;
    const baseId =
      typeof body.base_id === 'string' ? body.base_id.trim() || null : (existing?.base_id ?? null);
    const apiKey =
      typeof body.api_key === 'string' && body.api_key.trim() !== ''
        ? body.api_key.trim()
        : (existing?.api_key ?? null);

    await c.env.DB.prepare(
      `INSERT INTO airtable_settings (id, enabled, api_key, base_id, updated_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, api_key = excluded.api_key,
                                      base_id = excluded.base_id, updated_at = excluded.updated_at`,
    )
      .bind(enabled ? 1 : 0, apiKey, baseId, new Date().toISOString())
      .run();

    return c.json(maskedJson(await loadRow(c.env.DB)));
  });

  /**
   * POST /app/api/airtable/settings/test { api_key?, base_id? } — probe the
   * base with the just-typed credentials when given, the stored/env ones
   * otherwise, via one cheap read (maxRecords=1 off the first mirrored
   * table). Always 200 with { ok, error? }; the error text never contains
   * the key.
   */
  routes.post('/settings/test', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const stored = await resolveAirtableConfig(c.env as Env);
    const apiKey =
      (typeof body.api_key === 'string' && body.api_key.trim()) || stored.apiKey;
    const baseId =
      (typeof body.base_id === 'string' && body.base_id.trim()) || stored.baseId;
    if (!apiKey || !baseId) {
      return c.json({ ok: false, error: 'API key and base ID are required — enter or save them first.' });
    }
    try {
      await makeClient({ apiKey, baseId }).listRecords(SYNC_TABLES[0]!.airtableTable, 1);
      return c.json({ ok: true });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // Belt and braces: the client's errors carry status + body, never the
      // Authorization header, but scrub the key anyway before echoing.
      const error = raw.split(apiKey).join('[redacted]').slice(0, 300);
      return c.json({ ok: false, error });
    }
  });

  return routes;
}

export const airtableAdminRoutes = createAirtableAdminRoutes();
