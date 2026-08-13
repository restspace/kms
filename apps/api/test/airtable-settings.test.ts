// Settings-page Airtable configuration (0041 + routes/airtableAdmin.ts +
// resolveAirtableConfig). Under test:
//  1. GET/PUT round-trip on the singleton row, with the API key always masked
//     (key_set + last 4, never the full key anywhere in a response body) and
//     an absent api_key on PUT keeping the stored one.
//  2. ACL: reviewers are refused, admins/owners pass.
//  3. Test-connection probe: prefers just-submitted credentials over stored,
//     reports failure without echoing the key.
//  4. Sweep gating precedence: a DB row overrides AIRTABLE_SYNC/env secrets
//     in both directions; with no row the env fallback still works; enabled
//     but unconfigured stays a warn + no-op.

import { env, SELF } from 'cloudflare:test';
import {
  AirtableScopeError,
  BASE_SCHEMA,
  SYNC_TABLES,
  type AirtableClient,
  type AirtableMetaClient,
} from '@kms/airtable';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAirtableAdminRoutes } from '../src/routes/airtableAdmin';
import { resolveAirtableConfig, sweepAirtableSync } from '../src/jobs/airtableSync';
import type { Env } from '../src/env';
import { jsonReq, seedEvent, seedStaff } from './fixtures-admin';

const ORIGIN = 'https://kms.test';
const KEY = 'patSECRETSECRET1234';

let eventId: string;
let admin: { contactId: string; cookie: string; email: string };

beforeEach(async () => {
  // Storage persists across it() blocks in this pool-workers version and the
  // settings row is a singleton — clear it so every test starts unconfigured.
  await env.DB.prepare('DELETE FROM airtable_settings').run();
  eventId = await seedEvent();
  admin = await seedStaff(eventId, 'admin');
});

/**
 * A fake client factory that records the credentials each client was built
 * with. The client itself covers both the probe (listRecords) and a full
 * sweep (create/update/delete) so sweepAirtableSync can run to completion.
 */
function makeFakeFactory(failWith?: string) {
  const calls: Array<{ apiKey: string; baseId: string }> = [];
  let counter = 0;
  const factory = (opts: { apiKey: string; baseId: string }) => {
    calls.push(opts);
    return {
      async listRecords() {
        if (failWith) throw new Error(failWith);
        return [];
      },
      async createRecords(_table: string, fieldsList: unknown[]) {
        return fieldsList.map(() => `recFAKE${++counter}`);
      },
      async updateRecords() {},
      async deleteRecords() {},
    } as unknown as AirtableClient;
  };
  return { factory, calls };
}

describe('GET/PUT /app/api/airtable/settings', () => {
  it('reports unconfigured for a fresh deployment', async () => {
    const res = await SELF.fetch(`${ORIGIN}/app/api/airtable/settings`, { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, base_id: '', key_set: false, key_last4: null });
  });

  it('round-trips enabled/base_id/api_key and masks the key everywhere', async () => {
    const put = await SELF.fetch(
      `${ORIGIN}/app/api/airtable/settings`,
      jsonReq(admin.cookie, { enabled: true, base_id: 'appBASE1', api_key: KEY }, 'PUT'),
    );
    expect(put.status).toBe(200);
    const putBody = await put.text();
    expect(putBody).not.toContain(KEY);
    expect(JSON.parse(putBody)).toEqual({ enabled: true, base_id: 'appBASE1', key_set: true, key_last4: '1234' });

    const get = await SELF.fetch(`${ORIGIN}/app/api/airtable/settings`, { headers: { cookie: admin.cookie } });
    const getBody = await get.text();
    expect(getBody).not.toContain(KEY);
    expect(JSON.parse(getBody)).toEqual({ enabled: true, base_id: 'appBASE1', key_set: true, key_last4: '1234' });

    // The full key is stored — masking is a response concern, not storage.
    const row = await env.DB.prepare('SELECT api_key FROM airtable_settings WHERE id = 1')
      .first<{ api_key: string }>();
    expect(row?.api_key).toBe(KEY);
  });

  it('PUT without api_key keeps the stored key; other fields still update', async () => {
    await SELF.fetch(
      `${ORIGIN}/app/api/airtable/settings`,
      jsonReq(admin.cookie, { enabled: true, base_id: 'appBASE1', api_key: KEY }, 'PUT'),
    );
    const put = await SELF.fetch(
      `${ORIGIN}/app/api/airtable/settings`,
      jsonReq(admin.cookie, { enabled: false, base_id: 'appBASE2' }, 'PUT'),
    );
    expect(await put.json()).toEqual({ enabled: false, base_id: 'appBASE2', key_set: true, key_last4: '1234' });
    const row = await env.DB.prepare('SELECT api_key FROM airtable_settings WHERE id = 1')
      .first<{ api_key: string }>();
    expect(row?.api_key).toBe(KEY);
  });

  it('an empty-string api_key also keeps the stored key (the UI sends nothing it did not type)', async () => {
    await SELF.fetch(
      `${ORIGIN}/app/api/airtable/settings`,
      jsonReq(admin.cookie, { enabled: true, base_id: 'appBASE1', api_key: KEY }, 'PUT'),
    );
    const put = await SELF.fetch(
      `${ORIGIN}/app/api/airtable/settings`,
      jsonReq(admin.cookie, { enabled: true, base_id: 'appBASE1', api_key: '' }, 'PUT'),
    );
    expect(((await put.json()) as { key_set: boolean }).key_set).toBe(true);
  });

  it('reviewers get 403 on both GET and PUT; owners pass', async () => {
    const reviewer = await seedStaff(eventId, 'reviewer');
    const get = await SELF.fetch(`${ORIGIN}/app/api/airtable/settings`, { headers: { cookie: reviewer.cookie } });
    expect(get.status).toBe(403);
    const put = await SELF.fetch(
      `${ORIGIN}/app/api/airtable/settings`,
      jsonReq(reviewer.cookie, { enabled: true }, 'PUT'),
    );
    expect(put.status).toBe(403);

    const owner = await seedStaff(eventId, 'owner');
    const ownerGet = await SELF.fetch(`${ORIGIN}/app/api/airtable/settings`, { headers: { cookie: owner.cookie } });
    expect(ownerGet.status).toBe(200);
  });

  it('stores the base id from a pasted base URL, not the whole path', async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/app/api/airtable/settings`,
      jsonReq(
        admin.cookie,
        { enabled: false, base_id: 'https://airtable.com/appbrUQ7n7P0zFSL6/tblEn0t0UeFGHnLrl/viwYhZ' },
        'PUT',
      ),
    );
    expect((await res.json()) as { base_id: string }).toMatchObject({ base_id: 'appbrUQ7n7P0zFSL6' });
  });

  it('unauthenticated requests get 401', async () => {
    const res = await SELF.fetch(`${ORIGIN}/app/api/airtable/settings`);
    expect(res.status).toBe(401);
  });
});

/** Fake metadata client — records the key it was built with, never dials out. */
function makeFakeMeta(over: Partial<Record<string, unknown>> = {}) {
  const keys: string[] = [];
  const factory = (opts: { apiKey: string }) => {
    keys.push(opts.apiKey);
    return {
      async listBases() {
        return [{ id: 'appA', name: 'Conference' }];
      },
      async listTables() {
        return [];
      },
      async createTable() {},
      async createField() {},
      ...over,
    } as unknown as AirtableMetaClient;
  };
  return { factory, keys };
}

/** A base whose schema is already complete, as the metadata API would report it. */
const fullyBuiltBase = () =>
  BASE_SCHEMA.map((t, i) => ({ id: `tbl${i}`, name: t.name, fields: t.fields.map((f) => ({ id: f.name, ...f })) }));

describe('POST /app/api/airtable/settings/test', () => {
  // The probe would dial api.airtable.com, so these tests build the router
  // via its factory with a fake client and call it directly (same guard path:
  // the defensive middleware re-resolves the session from the cookie).
  const testEnv = () => ({ ...env, AIRTABLE_SYNC: 'off' }) as unknown as Env;
  const builtMeta = () => makeFakeMeta({ async listTables() { return fullyBuiltBase(); } });

  it('uses stored credentials when none are submitted', async () => {
    await SELF.fetch(
      `${ORIGIN}/app/api/airtable/settings`,
      jsonReq(admin.cookie, { enabled: true, base_id: 'appSTORED', api_key: KEY }, 'PUT'),
    );
    const { factory, keys } = builtMeta();
    const routes = createAirtableAdminRoutes(makeFakeFactory().factory, factory);
    const res = await routes.request('/settings/test', jsonReq(admin.cookie, {}), testEnv());
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect(keys).toEqual([KEY]);
  });

  it('just-submitted credentials win over stored ones', async () => {
    await SELF.fetch(
      `${ORIGIN}/app/api/airtable/settings`,
      jsonReq(admin.cookie, { enabled: true, base_id: 'appSTORED', api_key: KEY }, 'PUT'),
    );
    const { factory, keys } = builtMeta();
    const routes = createAirtableAdminRoutes(makeFakeFactory().factory, factory);
    const res = await routes.request(
      '/settings/test',
      jsonReq(admin.cookie, { api_key: 'patTYPED9999', base_id: 'appTYPED' }),
      testEnv(),
    );
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect(keys).toEqual(['patTYPED9999']);
  });

  it('tells an unbuilt base apart from a wrong base id, instead of a bare 404', async () => {
    const routes = createAirtableAdminRoutes(makeFakeFactory().factory, makeFakeMeta().factory);
    const res = await routes.request(
      '/settings/test',
      jsonReq(admin.cookie, { api_key: KEY, base_id: 'appEMPTY' }),
      testEnv(),
    );
    const parsed = (await res.json()) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Create the tables in Airtable');
    expect(parsed.error).not.toContain('404');
  });

  it('accepts a base URL pasted from the browser, stripping the table and view ids', async () => {
    const bases: string[] = [];
    const { factory } = makeFakeMeta({
      async listTables(baseId: string) {
        bases.push(baseId);
        return fullyBuiltBase();
      },
    });
    const routes = createAirtableAdminRoutes(makeFakeFactory().factory, factory);
    const res = await routes.request(
      '/settings/test',
      jsonReq(admin.cookie, {
        api_key: KEY,
        base_id: 'https://airtable.com/appbrUQ7n7P0zFSL6/tblEn0t0UeFGHnLrl/viwYhZb2WIzFFKCj2',
      }),
      testEnv(),
    );
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    expect(bases).toEqual(['appbrUQ7n7P0zFSL6']);
  });

  it('rejects a base id with no app… in it by name, without calling Airtable', async () => {
    const { factory, keys } = makeFakeMeta();
    const routes = createAirtableAdminRoutes(makeFakeFactory().factory, factory);
    const res = await routes.request(
      '/settings/test',
      jsonReq(admin.cookie, { api_key: KEY, base_id: 'my conference base' }),
      testEnv(),
    );
    const parsed = (await res.json()) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('my conference base');
    expect(keys).toHaveLength(0);
  });

  it('names the tables a half-built base is missing', async () => {
    const { factory } = makeFakeMeta({
      async listTables() {
        return fullyBuiltBase().filter((t) => t.name !== 'Reviews' && t.name !== 'Tags');
      },
    });
    const routes = createAirtableAdminRoutes(makeFakeFactory().factory, factory);
    const res = await routes.request(
      '/settings/test',
      jsonReq(admin.cookie, { api_key: KEY, base_id: 'appHALF' }),
      testEnv(),
    );
    const parsed = (await res.json()) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Reviews, Tags');
  });

  it('reports failure detail without echoing the key', async () => {
    const { factory } = makeFakeMeta({
      async listTables() {
        throw new Error(`airtable meta GET: 401 {"error":"AUTHENTICATION_REQUIRED"} key=${KEY}`);
      },
    });
    const routes = createAirtableAdminRoutes(makeFakeFactory().factory, factory);
    const res = await routes.request(
      '/settings/test',
      jsonReq(admin.cookie, { api_key: KEY, base_id: 'appBAD' }),
      testEnv(),
    );
    const body = await res.text();
    expect(body).not.toContain(KEY);
    const parsed = JSON.parse(body) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('401');
    expect(parsed.error).toContain('[redacted]');
  });

  describe('token without the schema scopes', () => {
    const scopeless = () =>
      makeFakeMeta({
        async listTables() {
          throw new AirtableScopeError('403 INVALID_PERMISSIONS');
        },
      }).factory;

    it('falls back to the record probe and passes when it answers', async () => {
      const { factory, calls } = makeFakeFactory();
      const routes = createAirtableAdminRoutes(factory, scopeless());
      const res = await routes.request(
        '/settings/test',
        jsonReq(admin.cookie, { api_key: KEY, base_id: 'appOK' }),
        testEnv(),
      );
      expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
      expect(calls).toEqual([{ apiKey: KEY, baseId: 'appOK' }]);
    });

    it('explains what a 404 from the record probe could mean', async () => {
      const { factory } = makeFakeFactory('airtable GET Events: 404 {"error":"NOT_FOUND"}');
      const routes = createAirtableAdminRoutes(factory, scopeless());
      const res = await routes.request(
        '/settings/test',
        jsonReq(admin.cookie, { api_key: KEY, base_id: 'appOK' }),
        testEnv(),
      );
      const parsed = (await res.json()) as { ok: boolean; error: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('base ID is wrong');
      expect(parsed.error).toContain('schema.bases:write');
    });
  });

  it('says so when nothing is configured anywhere', async () => {
    const { factory, calls } = makeFakeFactory();
    const { factory: meta, keys } = makeFakeMeta();
    const routes = createAirtableAdminRoutes(factory, meta);
    const res = await routes.request('/settings/test', jsonReq(admin.cookie, {}), testEnv());
    const parsed = (await res.json()) as { ok: boolean };
    expect(parsed.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(keys).toHaveLength(0);
  });
});

describe('POST /app/api/airtable/settings/bases and /setup', () => {
  const testEnv = () => ({ ...env, AIRTABLE_SYNC: 'off' }) as unknown as Env;

  it('lists bases with the typed key before anything is saved', async () => {
    const { factory, keys } = makeFakeMeta();
    const routes = createAirtableAdminRoutes(makeFakeFactory().factory, factory);
    const res = await routes.request('/settings/bases', jsonReq(admin.cookie, { api_key: KEY }), testEnv());
    expect(await res.json()).toEqual({ ok: true, bases: [{ id: 'appA', name: 'Conference' }] });
    expect(keys).toEqual([KEY]);
  });

  it('creates every mirrored table in an empty base and reports it', async () => {
    const created: string[] = [];
    const { factory } = makeFakeMeta({
      async createTable(_baseId: string, table: { name: string }) {
        created.push(table.name);
      },
    });
    const routes = createAirtableAdminRoutes(makeFakeFactory().factory, factory);
    const res = await routes.request(
      '/settings/setup',
      jsonReq(admin.cookie, { api_key: KEY, base_id: 'appNEW' }),
      testEnv(),
    );
    const body = (await res.json()) as { ok: boolean; report: { createdTables: string[] } };
    expect(body.ok).toBe(true);
    expect(body.report.createdTables).toEqual(SYNC_TABLES.map((t) => t.airtableTable));
    expect(created).toEqual(SYNC_TABLES.map((t) => t.airtableTable));
  });

  it('explains the missing token scopes rather than echoing a raw 403', async () => {
    const { factory } = makeFakeMeta({
      async listTables() {
        throw new AirtableScopeError(`403 INVALID_PERMISSIONS key=${KEY}`);
      },
    });
    const routes = createAirtableAdminRoutes(makeFakeFactory().factory, factory);
    const res = await routes.request(
      '/settings/setup',
      jsonReq(admin.cookie, { api_key: KEY, base_id: 'appNEW' }),
      testEnv(),
    );
    const text = await res.text();
    expect(text).not.toContain(KEY);
    const body = JSON.parse(text) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('schema.bases:write');
  });

  it('scrubs the key out of any other setup failure', async () => {
    const { factory } = makeFakeMeta({
      async listTables() {
        throw new Error(`airtable meta GET: 500 boom key=${KEY}`);
      },
    });
    const routes = createAirtableAdminRoutes(makeFakeFactory().factory, factory);
    const res = await routes.request(
      '/settings/setup',
      jsonReq(admin.cookie, { api_key: KEY, base_id: 'appNEW' }),
      testEnv(),
    );
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).toContain('[redacted]');
  });

  it('refuses setup with no base selected', async () => {
    const { factory, keys } = makeFakeMeta();
    const routes = createAirtableAdminRoutes(makeFakeFactory().factory, factory);
    const res = await routes.request('/settings/setup', jsonReq(admin.cookie, { api_key: KEY }), testEnv());
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: false });
    expect(keys).toHaveLength(0);
  });

  it('refuses both routes to reviewers', async () => {
    const reviewer = await seedStaff(eventId, 'reviewer');
    const routes = createAirtableAdminRoutes(makeFakeFactory().factory, makeFakeMeta().factory);
    for (const path of ['/settings/bases', '/settings/setup']) {
      const res = await routes.request(path, jsonReq(reviewer.cookie, { api_key: KEY }), testEnv());
      expect(res.status).toBe(403);
    }
  });
});

describe('sweep gating — DB settings over env, env fallback intact', () => {
  const baseEnv = (over: Partial<Env>): Env =>
    ({ DB: env.DB, AIRTABLE_SYNC: 'off', ...over }) as unknown as Env;

  it('resolveAirtableConfig: no row -> env values verbatim', async () => {
    const config = await resolveAirtableConfig(
      baseEnv({ AIRTABLE_SYNC: 'on', AIRTABLE_API_KEY: 'envKey', AIRTABLE_BASE_ID: 'envBase' }),
    );
    expect(config).toEqual({ enabled: true, apiKey: 'envKey', baseId: 'envBase', source: 'env' });
  });

  it('resolveAirtableConfig: a row overrides the env flag in both directions', async () => {
    await env.DB.prepare(
      `INSERT INTO airtable_settings (id, enabled, api_key, base_id, updated_at) VALUES (1, 0, NULL, NULL, ?)`,
    ).bind('2026-08-13T00:00:00Z').run();
    const off = await resolveAirtableConfig(baseEnv({ AIRTABLE_SYNC: 'on' }));
    expect(off.enabled).toBe(false);
    expect(off.source).toBe('db');

    await env.DB.prepare('UPDATE airtable_settings SET enabled = 1 WHERE id = 1').run();
    const on = await resolveAirtableConfig(baseEnv({ AIRTABLE_SYNC: 'off' }));
    expect(on.enabled).toBe(true);
  });

  it('resolveAirtableConfig: DB credentials win; empty DB columns fall back to env secrets', async () => {
    await env.DB.prepare(
      `INSERT INTO airtable_settings (id, enabled, api_key, base_id, updated_at) VALUES (1, 1, 'dbKey', NULL, ?)`,
    ).bind('2026-08-13T00:00:00Z').run();
    const config = await resolveAirtableConfig(
      baseEnv({ AIRTABLE_API_KEY: 'envKey', AIRTABLE_BASE_ID: 'envBase' }),
    );
    expect(config.apiKey).toBe('dbKey'); // DB over env
    expect(config.baseId).toBe('envBase'); // per-field env fallback
  });

  it('sweepAirtableSync runs with DB credentials while env says off', async () => {
    await env.DB.prepare(
      `INSERT INTO airtable_settings (id, enabled, api_key, base_id, updated_at) VALUES (1, 1, 'dbKey', 'dbBase', ?)`,
    ).bind('2026-08-13T00:00:00Z').run();
    const { factory, calls } = makeFakeFactory();
    await sweepAirtableSync(baseEnv({ AIRTABLE_SYNC: 'off', AIRTABLE_API_KEY: 'envKey', AIRTABLE_BASE_ID: 'envBase' }), factory);
    expect(calls).toEqual([{ apiKey: 'dbKey', baseId: 'dbBase' }]);
    // It really swept: the watermark table has rows for the mirrored tables.
    const state = await env.DB.prepare('SELECT COUNT(*) AS n FROM airtable_sync_state').first<{ n: number }>();
    expect(state!.n).toBeGreaterThan(0);
  });

  it('sweepAirtableSync stays off when the DB row disables an env-enabled deployment', async () => {
    await env.DB.prepare(
      `INSERT INTO airtable_settings (id, enabled, api_key, base_id, updated_at) VALUES (1, 0, 'dbKey', 'dbBase', ?)`,
    ).bind('2026-08-13T00:00:00Z').run();
    const { factory, calls } = makeFakeFactory();
    await sweepAirtableSync(baseEnv({ AIRTABLE_SYNC: 'on', AIRTABLE_API_KEY: 'envKey', AIRTABLE_BASE_ID: 'envBase' }), factory);
    expect(calls).toHaveLength(0);
  });

  it('sweepAirtableSync no-ops (no client built) when enabled but unconfigured', async () => {
    await env.DB.prepare(
      `INSERT INTO airtable_settings (id, enabled, api_key, base_id, updated_at) VALUES (1, 1, NULL, NULL, ?)`,
    ).bind('2026-08-13T00:00:00Z').run();
    const { factory, calls } = makeFakeFactory();
    await sweepAirtableSync(baseEnv({}), factory);
    expect(calls).toHaveLength(0);
  });

  it('env-only fallback still sweeps (pre-migration behaviour preserved)', async () => {
    const { factory, calls } = makeFakeFactory();
    await sweepAirtableSync(
      baseEnv({ AIRTABLE_SYNC: 'on', AIRTABLE_API_KEY: 'envKey', AIRTABLE_BASE_ID: 'envBase' }),
      factory,
    );
    expect(calls).toEqual([{ apiKey: 'envKey', baseId: 'envBase' }]);
  });
});
