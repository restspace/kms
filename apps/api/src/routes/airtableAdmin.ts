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
import {
  AirtableClient,
  AirtableMetaClient,
  AirtableScopeError,
  BASE_SCHEMA,
  ensureBaseSchema,
  missingFromBase,
  parseBaseId,
  SYNC_TABLES,
} from '@kms/airtable';
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
export type MakeMetaClient = (opts: { apiKey: string }) => AirtableMetaClient;

/**
 * Factories so tests can swap the Airtable clients these routes build (workers
 * tests must not dial api.airtable.com). Production uses the
 * `airtableAdminRoutes` instance below with the real clients.
 */
export function createAirtableAdminRoutes(
  makeClient: MakeClient = (opts) =>
    // Probe client: fail fast instead of sleeping through Airtable's 30s 429
    // penalty window — a rate-limited probe should say so, not hang the tab.
    new AirtableClient({ ...opts, minIntervalMs: 0, maxRetries: 0 }),
  makeMetaClient: MakeMetaClient = (opts) => new AirtableMetaClient(opts),
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
    // Store the id, not the address bar: parseBaseId strips the table/view ids
    // that come with a copied base URL. An unrecognisable value is kept as
    // typed so the user can see and correct it — the probes reject it by name.
    const submittedBase = typeof body.base_id === 'string' ? body.base_id.trim() : null;
    const baseId =
      submittedBase === null
        ? (existing?.base_id ?? null)
        : submittedBase === ''
          ? null
          : (parseBaseId(submittedBase) ?? submittedBase);
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
   * otherwise. Always 200 with { ok, message?, error? }; neither text ever
   * contains the key.
   *
   * Prefers the metadata API, because the data API cannot tell "wrong base id"
   * from "right base, tables not created yet" — both are a bare 404 NOT_FOUND,
   * and the second is the normal state of a base at step 2. Reading the schema
   * separates them and names the missing tables. With a token that lacks the
   * schema scopes there is no schema to read, so it falls back to the record
   * probe and spells out what a 404 could mean.
   */
  routes.post('/settings/test', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const { apiKey, baseId, unparseableBaseId } = await credentials(c.env as Env, body);
    if (unparseableBaseId) return c.json({ ok: false, error: badBaseId(unparseableBaseId) });
    if (!apiKey || !baseId) return c.json({ ok: false, error: MISSING_BOTH });

    try {
      const missing = missingFromBase(await makeMetaClient({ apiKey }).listTables(baseId));
      if (missing.tables.length === BASE_SCHEMA.length) {
        return c.json({
          ok: false,
          error: 'Connected to the base, but none of the mirror\'s tables exist yet — use "Create the tables in Airtable" below.',
        });
      }
      if (missing.tables.length > 0) {
        return c.json({
          ok: false,
          error: `Connected to the base, but these tables are missing: ${missing.tables.join(', ')}. Use "Create the tables in Airtable" below.`,
        });
      }
      // Every table present but a column short is the more confusing state, and
      // it mirrors exactly nothing: Airtable rejects a whole write over one
      // unknown field name, so say so rather than reporting a healthy base.
      if (missing.fields.length > 0) {
        return c.json({
          ok: false,
          error:
            `Connected to the base, and all ${BASE_SCHEMA.length} tables are there, but ${missing.fields.length} ` +
            `column(s) are missing: ${summarise(missing.fields)}. Nothing will mirror until they exist — ` +
            'use "Create the tables in Airtable" below.',
        });
      }
      return c.json({ ok: true, message: 'Connected — the base has every table and column the mirror needs.' });
    } catch (err) {
      if (!(err instanceof AirtableScopeError)) {
        return c.json({ ok: false, error: scrub(err instanceof Error ? err.message : String(err), apiKey) });
      }
      // No schema scopes: fall back to reading one record from the first
      // mirrored table, which only needs data.records:read.
      try {
        await makeClient({ apiKey, baseId }).listRecords(SYNC_TABLES[0]!.airtableTable, 1);
        return c.json({ ok: true, message: 'Connected — the base answered.' });
      } catch (probeErr) {
        // Belt and braces: the client's errors carry status + body, never the
        // Authorization header, but scrub the key anyway before echoing.
        const raw = scrub(probeErr instanceof Error ? probeErr.message : String(probeErr), apiKey);
        return c.json({
          ok: false,
          error: /: 404\b/.test(raw)
            ? `${raw} — that means either the base ID is wrong, or the base has no "${SYNC_TABLES[0]!.airtableTable}" table yet. This token cannot read the base structure, so add the scopes schema.bases:read and schema.bases:write to tell those apart and to create the tables from here.`
            : raw,
        });
      }
    }
  });

  /**
   * POST /app/api/airtable/settings/bases { api_key? } — bases the token can
   * reach, so the Settings page can offer a picker instead of asking an
   * organiser to dig an `app…` id out of a URL. Always 200 with
   * { ok, bases[], error? }; needs schema.bases:read on the PAT.
   */
  routes.post('/settings/bases', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const { apiKey } = await credentials(c.env as Env, body);
    if (!apiKey) return c.json({ ok: false, bases: [], error: MISSING_KEY });
    try {
      return c.json({ ok: true, bases: await makeMetaClient({ apiKey }).listBases() });
    } catch (err) {
      return c.json({ ok: false, bases: [], error: setupError(err, apiKey) });
    }
  });

  /**
   * POST /app/api/airtable/settings/setup { api_key?, base_id? } — create the
   * tables and columns the sweep writes into, in the selected base. Idempotent
   * and additive (see ensureBaseSchema), so re-running after a partial failure
   * or a schema addition is safe and is the documented recovery path.
   *
   * Always 200 with { ok, report?, error? }: a scope/permission problem is an
   * expected outcome an organiser has to act on, not a 500.
   */
  routes.post('/settings/setup', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const { apiKey, baseId, unparseableBaseId } = await credentials(c.env as Env, body);
    if (unparseableBaseId) return c.json({ ok: false, error: badBaseId(unparseableBaseId) });
    if (!apiKey || !baseId) return c.json({ ok: false, error: MISSING_BOTH });
    try {
      return c.json({ ok: true, report: await ensureBaseSchema(makeMetaClient({ apiKey }), baseId) });
    } catch (err) {
      // Partial progress is kept, not rolled back — the tables already created
      // are correct, and re-running finishes the rest.
      return c.json({ ok: false, error: setupError(err, apiKey) });
    }
  });

  return routes;
}

const MISSING_KEY = 'API key is required — enter or save it first.';
const MISSING_BOTH = 'API key and base ID are required — enter or save them first.';

/**
 * Just-typed credentials win over stored/env ones, so the UI can verify before
 * saving. The base id is normalised on the way through: a value pasted from the
 * browser's address bar carries the table and view ids too, and those would be
 * concatenated into every Airtable request path.
 */
async function credentials(env: Env, body: Record<string, unknown>) {
  const stored = await resolveAirtableConfig(env);
  const raw = (typeof body.base_id === 'string' && body.base_id.trim()) || stored.baseId || '';
  return {
    apiKey: (typeof body.api_key === 'string' && body.api_key.trim()) || stored.apiKey,
    baseId: raw === '' ? '' : (parseBaseId(raw) ?? ''),
    /** Set when something was supplied but held no `app…` id — a typo, not a blank. */
    unparseableBaseId: raw !== '' && parseBaseId(raw) === null ? raw.slice(0, 60) : null,
  };
}

/** A whole release's worth of new columns is a wall of text; name a few. */
const summarise = (names: string[], keep = 6) =>
  names.length <= keep ? names.join(', ') : `${names.slice(0, keep).join(', ')} and ${names.length - keep} more`;

const badBaseId = (raw: string) =>
  `"${raw}" doesn't contain an Airtable base ID. Paste the base's web address, or the app… part of it — you can also press "Find my bases" above.`;

/** Belt and braces: upstream errors carry status + body, never the key — scrub anyway. */
const scrub = (raw: string, apiKey: string) => raw.split(apiKey).join('[redacted]').slice(0, 300);

/**
 * Setup fails most often because the PAT carries only the two data.records
 * scopes the mirror needs — say that in the terms of the Airtable UI the
 * organiser has to go back to, rather than echoing a raw 403 body.
 */
function setupError(err: unknown, apiKey: string): string {
  if (err instanceof AirtableScopeError) {
    return (
      'Airtable refused: this token cannot read or change the base structure. ' +
      'Edit it at airtable.com/create/tokens, add the scopes schema.bases:read and ' +
      'schema.bases:write, and make sure the base (or its workspace) is in its access list.'
    );
  }
  return scrub(err instanceof Error ? err.message : String(err), apiKey);
}

export const airtableAdminRoutes = createAirtableAdminRoutes();
