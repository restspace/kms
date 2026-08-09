// `import { env } from 'cloudflare:test'` is typed as Cloudflare.Env, so the
// worker's Env plus test-only bindings are declared into that namespace.
/// <reference path="../../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Env as WorkerEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
