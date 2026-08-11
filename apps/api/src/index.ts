import { createApp } from './app';
import type { Env } from './env';

const app = createApp();

export default {
  fetch: app.fetch,

  // Reminder sweeps enqueue, then the outbox sweep delivers — same tick
  // (docs/03 §2a, docs/08 §4). The daily 09:00 UTC trigger replays the demo
  // seed instead, when this deployment is the public demo (docs/12 §2).
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (controller.cron === '0 9 * * *') {
      // Daily tick: drop long-expired auth_tokens hashes (sweep item P0-2
      // cleanup), then the demo reset when this deployment is the public demo.
      const { cleanupExpiredAuthTokens } = await import('./routes/auth');
      await cleanupExpiredAuthTokens(env.DB);
      if (env.DEMO_RESET === 'on') {
        const { resetDemoData } = await import('./demo');
        await resetDemoData(env.DB);
      }
      return;
    }
    const { createDb } = await import('@kms/db');
    const { sweepOutbox } = await import('./jobs/outbox');
    const { sweepReminders } = await import('./jobs/reminders');
    const { sweepBulkJobs } = await import('./jobs/bulkJobs');
    const { sweepAirtableSync } = await import('./jobs/airtableSync');
    const db = createDb(env.DB);
    await sweepReminders(env);
    await sweepOutbox(db, env, env.DB);
    await sweepBulkJobs(env);
    await sweepAirtableSync(env);
  },
} satisfies ExportedHandler<Env>;
