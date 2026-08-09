// D1/KV integration tests inside workerd (docs/03, sweep item P2-23), using
// the vitest-4 plugin API of @cloudflare/vitest-pool-workers 0.20.x.
// Migrations are read on the node side, passed in as a binding and applied by
// the setup file; per-test isolated storage gives every test a clean,
// fully-migrated database. The full demo seed is never replayed here — tests
// build minimal fixtures (see test/fixtures.ts).

import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, '../../packages/db/migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: '../../wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            DEMO_RESET: 'off',
            DEV_MODE: 'on',
            SESSION_SECRET: 'test-secret',
          },
        },
      }),
    ],
    test: {
      name: 'workers',
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
