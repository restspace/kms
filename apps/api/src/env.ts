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
  /** "on" enables the Settings reset button + nightly seed replay (demo deployments only) */
  DEMO_RESET: string;
  // secrets (.dev.vars locally, `wrangler secret put` in production)
  /** Airtable personal access token; with AIRTABLE_BASE_ID, enables the mirror when AIRTABLE_SYNC = "on" */
  AIRTABLE_API_KEY?: string;
  AIRTABLE_BASE_ID?: string;
  RESEND_API_KEY?: string;
  /** calendar-safe invite path (spike verdict, docs/12 M0); Resend fallback without it */
  SENDGRID_API_KEY?: string;
  EMAIL_FROM?: string;
  SESSION_SECRET: string;
}

/** Hono context bindings shape used by all route modules */
export type AppEnv = { Bindings: Env };
