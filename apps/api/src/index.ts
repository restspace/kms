import { createApp } from './app';
import type { Env } from './env';

const app = createApp();

export default {
  fetch: app.fetch,

  // Reminder sweeps enqueue, then the outbox sweep delivers — same tick
  // (docs/03 §2a, docs/08 §4).
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const { createDb } = await import('@kms/db');
    const { sweepOutbox } = await import('./jobs/outbox');
    const { sweepReminders } = await import('./jobs/reminders');
    const db = createDb(env.DB);
    await sweepReminders(env);
    await sweepOutbox(db, env, env.DB);
  },
} satisfies ExportedHandler<Env>;
