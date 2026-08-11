// Airtable mirror sweep (workplan-9), run from the cron tick after the other
// sweeps. One-way D1 → Airtable into a single global base (§5 option (b) —
// this is a single-tenant-deployment feature; per-org bases are the upgrade
// path if a second org ever shares a deployment). Latency is one cron tick
// (the every-minute trigger), traded deliberately against per-write outbox
// enqueues — see workplan-9 §4.2.

import { AirtableClient, runAirtableSync } from '@kms/airtable';
import type { Env } from '../env';

export async function sweepAirtableSync(env: Env): Promise<void> {
  if (env.AIRTABLE_SYNC !== 'on') return;
  if (!env.AIRTABLE_API_KEY || !env.AIRTABLE_BASE_ID) {
    console.warn('[airtable] AIRTABLE_SYNC=on but AIRTABLE_API_KEY/AIRTABLE_BASE_ID not set; skipping');
    return;
  }
  const client = new AirtableClient({ apiKey: env.AIRTABLE_API_KEY, baseId: env.AIRTABLE_BASE_ID });
  await runAirtableSync(env.DB, client, { log: (message) => console.log(`[airtable] ${message}`) });
}
