// jsdom project setup: testing-library auto-cleanup + vitest-axe matchers.
import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/preact';
import * as matchers from 'vitest-axe/matchers';

expect.extend(matchers);
afterEach(() => cleanup());
