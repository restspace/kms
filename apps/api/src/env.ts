export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
  APP_URL: string;
  EVENT_DEFAULT_TZ: string;
  EMAIL_PROVIDER: string;
  AIRTABLE_SYNC: string;
  USE_QUEUES: string;
  DEV_MODE: string;
  // secrets (.dev.vars locally, `wrangler secret put` in production)
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  SESSION_SECRET: string;
}

/** Hono context bindings shape used by all route modules */
export type AppEnv = { Bindings: Env };
