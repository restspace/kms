// vitest-axe registers its matchers at runtime in apps/admin/test/setup.ts;
// this merges the matcher into vitest's Assertion type for the ui project's
// test files, which the root tsc graph also checks.
import type { AxeMatchers } from 'vitest-axe/matchers';

declare module 'vitest' {
  interface Assertion<T = unknown> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}
