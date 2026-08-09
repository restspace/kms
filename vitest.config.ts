// Three test projects (sweep item P2-23):
//  - unit:    pure-logic tests colocated in packages/*/src (node env)
//  - ui:      Preact component tests for apps/admin + packages/ui (jsdom)
//  - workers: D1 integration tests under apps/api/test via
//             @cloudflare/vitest-pool-workers (referenced by path)
// The workers project boots miniflare from wrangler.toml, whose [assets]
// binding requires apps/public/dist to exist — run `npm run build` before
// `npm test` on a fresh checkout (CI does).

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/admin/src/**/*.logic.test.ts',
          ],
        },
      },
      {
        resolve: {
          alias: {
            react: 'preact/compat',
            'react-dom': 'preact/compat',
            'react/jsx-runtime': 'preact/jsx-runtime',
          },
        },
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['apps/admin/src/**/*.test.tsx', 'packages/ui/src/**/*.test.tsx'],
          setupFiles: ['./apps/admin/test/setup.ts'],
        },
      },
      './apps/api/vitest.config.ts',
    ],
  },
});
