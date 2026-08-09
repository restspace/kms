// Queue semantics for agenda writes (sweep item P2-9). Pure promise plumbing,
// no DOM: deferreds stand in for in-flight PUTs so responses can be resolved
// deliberately out of order.

import { describe, expect, it, vi } from 'vitest';
import { createMutationQueue } from './mutationQueue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks and a zero-delay timer run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const noopOptions = () => ({ onError: vi.fn(), onRefetch: vi.fn(), refetchDelayMs: 0 });

describe('createMutationQueue', () => {
  it('drops a stale response when a newer one already applied', async () => {
    const opts = noopOptions();
    const queue = createMutationQueue(opts);
    const slow = deferred<string>();
    const fast = deferred<string>();
    const applied: string[] = [];

    // Different sessions → the two chains run concurrently.
    void queue.enqueue('session-a', () => slow.promise, { apply: (r) => applied.push(r) });
    void queue.enqueue('session-b', () => fast.promise, { apply: (r) => applied.push(r) });

    fast.resolve('newer');
    await settle();
    slow.resolve('older');
    await settle();

    expect(applied).toEqual(['newer']);
    expect(queue.lastAppliedSeq()).toBe(2);
    expect(opts.onRefetch).not.toHaveBeenCalled();
  });

  it('serialises mutations for the same session and applies the last one', async () => {
    const queue = createMutationQueue(noopOptions());
    const order: string[] = [];
    const first = deferred<string>();
    const second = deferred<string>();

    void queue.enqueue('session-a', () => { order.push('start-1'); return first.promise; }, {
      apply: (r) => order.push(`apply-${r}`),
    });
    void queue.enqueue('session-a', () => { order.push('start-2'); return second.promise; }, {
      apply: (r) => order.push(`apply-${r}`),
    });

    await settle();
    // The second op must not have been dispatched while the first is open.
    expect(order).toEqual(['start-1']);

    first.resolve('one');
    await settle();
    second.resolve('two');
    await settle();

    expect(order).toEqual(['start-1', 'apply-one', 'start-2', 'apply-two']);
  });

  it('reports one error and one refetch per burst, after in-flight drains', async () => {
    const opts = noopOptions();
    const queue = createMutationQueue(opts);
    const a = deferred<string>();
    const b = deferred<string>();
    const perOp = vi.fn();

    void queue.enqueue('session-a', () => a.promise, { apply: vi.fn(), onError: perOp });
    void queue.enqueue('session-b', () => b.promise, { apply: vi.fn(), onError: perOp });

    a.reject(new Error('boom'));
    await settle();
    // Still one write in flight: no recovery fetch yet.
    expect(opts.onRefetch).not.toHaveBeenCalled();

    b.reject(new Error('boom too'));
    await settle();
    await settle(); // the recovery fetch is debounced one turn past the drain

    expect(perOp).toHaveBeenCalledTimes(2);
    expect(opts.onError).toHaveBeenCalledTimes(1);
    expect(opts.onRefetch).toHaveBeenCalledTimes(1);
    expect(queue.inFlight()).toBe(0);
  });

  it('starts a fresh burst after recovery', async () => {
    const opts = noopOptions();
    const queue = createMutationQueue(opts);

    await queue.enqueue('session-a', () => Promise.reject(new Error('one')), { apply: vi.fn() });
    await settle();
    await queue.enqueue('session-a', () => Promise.reject(new Error('two')), { apply: vi.fn() });
    await settle();

    expect(opts.onError).toHaveBeenCalledTimes(2);
    expect(opts.onRefetch).toHaveBeenCalledTimes(2);
  });

  it('keeps applying after a failure — the chain does not wedge', async () => {
    const opts = noopOptions();
    const queue = createMutationQueue(opts);
    const applied: string[] = [];

    void queue.enqueue('session-a', () => Promise.reject(new Error('nope')), { apply: () => applied.push('bad') });
    void queue.enqueue('session-a', () => Promise.resolve('good'), { apply: (r) => applied.push(r) });
    await settle();

    expect(applied).toEqual(['good']);
    expect(opts.onError).toHaveBeenCalledTimes(1);
  });

  it('dispose cancels a pending recovery fetch', async () => {
    const opts = { onError: vi.fn(), onRefetch: vi.fn(), refetchDelayMs: 20 };
    const queue = createMutationQueue(opts);
    void queue.enqueue('session-a', () => Promise.reject(new Error('x')), { apply: vi.fn() });
    await settle();
    queue.dispose();
    await new Promise((r) => setTimeout(r, 40));
    expect(opts.onRefetch).not.toHaveBeenCalled();
  });
});
