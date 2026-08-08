// Outbox sweep, invoked from the cron `scheduled` handler (docs/03 §2a).
// Claims due jobs, dispatches by kind, and records done/failed — failures back
// off exponentially inside db.outbox.markFailed and die after 8 attempts.
// Email jobs carry an OutboxEmailPayload; delivery and message_log updates
// live in mailer.ts so the request path and the sweep behave identically.

import type { Db } from '@kms/db';
import type { OutgoingEmail } from '@kms/email';
import { selectProvider } from '@kms/email';
import type { Env } from '../env';
import { deliverEmail, markEmailFailed, type OutboxEmailPayload } from '../mailer';

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 8;

export async function sweepOutbox(db: Db, env: Env, d1: D1Database): Promise<void> {
  const jobs = await db.outbox.claimDue(BATCH_SIZE);
  if (jobs.length === 0) return;

  for (const job of jobs) {
    try {
      switch (job.kind) {
        case 'email': {
          const payload = job.payload as OutboxEmailPayload | OutgoingEmail;
          if ('log_key' in payload) {
            await deliverEmail(d1, env, payload);
          } else {
            // Pre-M2 payload shape without a message_log row; send directly.
            await selectProvider(env).send(payload);
          }
          break;
        }
        case 'airtable_sync': {
          // Airtable mirror lands in M6; acknowledge so the job does not retry.
          console.log(`[outbox] airtable_sync ${job.idempotencyKey}: mirror not built yet (M6), marking done`);
          break;
        }
      }
      await db.outbox.markDone(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.outbox.markFailed(job.id, message);
      if (job.attempts + 1 >= MAX_ATTEMPTS && job.kind === 'email') {
        const payload = job.payload as Partial<OutboxEmailPayload>;
        if (payload.log_key) await markEmailFailed(d1, payload.log_key, message);
      }
    }
  }
}
