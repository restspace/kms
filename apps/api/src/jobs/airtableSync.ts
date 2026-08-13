// Airtable mirror sweep (workplan-9), run from the cron tick after the other
// sweeps. One-way D1 → Airtable into a single global base (§5 option (b) —
// this is a single-tenant-deployment feature; per-org bases are the upgrade
// path if a second org ever shares a deployment). Latency is one cron tick
// (the every-minute trigger), traded deliberately against per-write outbox
// enqueues — see workplan-9 §4.2.
//
// Configuration is resolved DB-first (the Settings page writes the
// airtable_settings singleton, 0041): a stored row's `enabled` flag replaces
// the AIRTABLE_SYNC env var, and its non-empty credentials replace the
// AIRTABLE_API_KEY / AIRTABLE_BASE_ID secrets. No row — or the table not
// migrated yet — falls back to the env vars, so pre-existing env-configured
// deployments keep syncing without touching the UI.

import { AirtableClient, runAirtableSync } from '@kms/airtable';
import type { Env } from '../env';

export interface ResolvedAirtableConfig {
  enabled: boolean;
  apiKey?: string;
  baseId?: string;
  /** where `enabled` came from — 'db' when the settings row exists */
  source: 'db' | 'env';
}

interface SettingsRow {
  enabled: number;
  api_key: string | null;
  base_id: string | null;
}

/** DB row when present, env fallback per field otherwise (shared with the
 *  settings routes' test-connection endpoint). */
export async function resolveAirtableConfig(env: Env): Promise<ResolvedAirtableConfig> {
  let row: SettingsRow | null = null;
  try {
    row = await env.DB.prepare('SELECT enabled, api_key, base_id FROM airtable_settings WHERE id = 1')
      .first<SettingsRow>();
  } catch {
    // Table missing (deployment not migrated to 0041 yet) — env-only mode.
  }
  return {
    enabled: row ? row.enabled === 1 : env.AIRTABLE_SYNC === 'on',
    apiKey: row?.api_key || env.AIRTABLE_API_KEY || undefined,
    baseId: row?.base_id || env.AIRTABLE_BASE_ID || undefined,
    source: row ? 'db' : 'env',
  };
}

/** Injectable for tests only — production always builds the real client. */
export type AirtableClientFactory = (opts: { apiKey: string; baseId: string }) => AirtableClient;

export async function sweepAirtableSync(
  env: Env,
  makeClient: AirtableClientFactory = (opts) => new AirtableClient(opts),
): Promise<void> {
  const config = await resolveAirtableConfig(env);
  if (!config.enabled) return;
  if (!config.apiKey || !config.baseId) {
    console.warn(
      `[airtable] sync enabled (${config.source}) but API key/base id not set in settings or env; skipping`,
    );
    return;
  }
  const client = makeClient({ apiKey: config.apiKey, baseId: config.baseId });
  await runAirtableSync(env.DB, client, { log: (message) => console.log(`[airtable] ${message}`) });
}
