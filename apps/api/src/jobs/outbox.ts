// Outbox sweep, invoked from the cron `scheduled` handler (docs/03 §2a).
// Claims due jobs, dispatches by kind, and records done/failed — failures back
// off exponentially inside db.outbox.markFailed and die after 8 attempts.

import type { Db } from '@kms/db';
import { createConsoleProvider, createResendProvider, type OutgoingEmail } from '@kms/email';
import type { Env } from '../env';

const BATCH_SIZE = 10;

export async function sweepOutbox(db: Db, env: Env): Promise<void> {
  const jobs = await db.outbox.claimDue(BATCH_SIZE);
  if (jobs.length === 0) return;

  // Real provider only when a key is present and we are not in dev mode;
  // otherwise mail is logged to the console (local dev needs no key).
  const provider =
    env.RESEND_API_KEY && env.DEV_MODE !== 'on'
      ? createResendProvider(env.RESEND_API_KEY, env.EMAIL_FROM ?? 'noreply@localhost')
      : createConsoleProvider();

  for (const job of jobs) {
    try {
      switch (job.kind) {
        case 'email': {
          const mail = job.payload as OutgoingEmail;
          await provider.send({ to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
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
      await db.outbox.markFailed(job.id, err instanceof Error ? err.message : String(err));
    }
  }
}
