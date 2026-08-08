import { createApp } from './app';
import type { Env } from './env';

const app = createApp();

export default {
  fetch: app.fetch,

  // Outbox retry sweep + (later) reminder sweeps — docs/03 §2a.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const { createDb } = await import('@kms/db');
    const { sweepOutbox } = await import('./jobs/outbox');
    await sweepOutbox(createDb(env.DB), env);
  },
} satisfies ExportedHandler<Env>;
