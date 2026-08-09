// D1/KV integration tests inside workerd (docs/03, sweep item P2-23), using
// the vitest-4 plugin API of @cloudflare/vitest-pool-workers 0.20.x.
// Migrations are read on the node side, passed in as a binding and applied by
// the setup file. CAUTION: in this pool-workers version storage persists
// across it() blocks within a test file — scope every assertion query to ids
// created by its own test and prefer random ids; unscoped LIKE/first()
// queries WILL pick up earlier tests' rows. The full demo seed is never
// replayed here — tests build minimal fixtures (see test/fixtures.ts).

import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/** Absolute path to a preact sub-package, so every importer shares one copy. */
const preact = (sub: string): string =>
  path.join(import.meta.dirname, '../../node_modules/preact', sub);

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, '../../packages/db/migrations'));
  return {
    // wrangler.toml's [alias] block maps the React API onto preact/compat for
    // the deployed Worker; vitest resolves the module graph itself, so the
    // same mapping has to be stated here or SSR of any hook-using component
    // (the packages/ui widgets, the CFP wizard) pulls in real React and throws
    // "Invalid hook call" — inside the test worker only. Lane W3-A hit this
    // first, when the /e/:slug/* pages gained their first worker test.
    //
    // The preact entries are absolute on purpose: preact-render-to-string and
    // the aliased compat build otherwise resolve `preact` from two different
    // spellings of the repo path on Windows (C:/info/kms vs C:/info/KMS),
    // which loads two copies of the hooks module and blows up on `__H`.
    resolve: {
      alias: [
        { find: /^react$/, replacement: preact('compat') },
        { find: /^react-dom$/, replacement: preact('compat') },
        { find: /^react-dom\/client$/, replacement: preact('compat/client') },
        { find: /^react\/jsx-runtime$/, replacement: preact('jsx-runtime') },
        { find: /^react\/jsx-dev-runtime$/, replacement: preact('jsx-runtime') },
        { find: /^preact$/, replacement: preact('') },
        { find: /^preact\/hooks$/, replacement: preact('hooks') },
        { find: /^preact\/compat$/, replacement: preact('compat') },
        { find: /^preact\/jsx-runtime$/, replacement: preact('jsx-runtime') },
      ],
    },
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
