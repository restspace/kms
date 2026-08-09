// Runs before each test file: apply every packages/db migration to this
// file's isolated D1 instance. New migrations are picked up automatically.
import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
