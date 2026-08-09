/**
 * Serialised agenda mutations (sweep item P2-9).
 *
 * The agenda fires overlapping writes: drag a block, resize it, hit ⌘Z, drop
 * it somewhere else — all before the first PUT comes back. Every response
 * carries a *whole* agenda payload, so an older reply landing last would
 * quietly resurrect a stale board.
 *
 * Three rules keep it honest:
 *
 *  1. **Per-key FIFO.** Writes for the same session run one after another
 *     (the server's row is the shared resource); different sessions still run
 *     concurrently, so dragging two blocks stays snappy.
 *  2. **Monotonic client sequence.** A number is taken at *dispatch* time, not
 *     at completion. A payload is applied only if its sequence beats the last
 *     applied one, so a slow response can never overwrite a newer applied one.
 *  3. **One recovery per burst.** Failures are noisy in bursts (offline, 500s).
 *     The error callback fires once per burst; once every in-flight write has
 *     drained, a single authoritative refetch resyncs the board.
 *
 * Nothing here touches React — it is plain promise plumbing so it can be unit
 * tested (`mutationQueue.logic.test.ts`) without a DOM.
 */

export interface MutationQueueOptions {
  /** Once per error burst, with the first failure of that burst. */
  onError: (error: unknown) => void
  /** Once per error burst, after every in-flight mutation has settled. */
  onRefetch: () => void
  /** Debounce before the recovery refetch, so a burst produces one fetch. */
  refetchDelayMs?: number
}

export interface EnqueueHandlers<T> {
  /** Runs only for a response that is still the newest one seen. */
  apply: (result: T) => void
  /** Per-operation cleanup (pop the undo entry, …). Errors still burst-report. */
  onError?: (error: unknown) => void
}

export interface MutationQueue {
  /**
   * Queue `op` behind any other pending mutation for `key`. Never rejects —
   * failures are routed to the handlers and the burst machinery.
   */
  enqueue: <T>(key: string, op: () => Promise<T>, handlers: EnqueueHandlers<T>) => Promise<void>
  /** Sequence of the newest response that was actually applied. */
  lastAppliedSeq: () => number
  /** Mutations dispatched but not yet settled. */
  inFlight: () => number
  /** Drop pending timers (component unmount). */
  dispose: () => void
}

export function createMutationQueue(options: MutationQueueOptions): MutationQueue {
  const refetchDelayMs = options.refetchDelayMs ?? 250

  let nextSeq = 0
  let lastApplied = 0
  let inFlight = 0
  let burstError: { error: unknown } | null = null
  let refetchTimer: ReturnType<typeof setTimeout> | null = null

  // One chain per key. The stored promise is the tail of that chain; it always
  // resolves (rejections are swallowed at the call site) so the chain never
  // wedges on a failure.
  const chains = new Map<string, Promise<void>>()

  const maybeRecover = () => {
    if (inFlight > 0 || burstError === null) return
    if (refetchTimer !== null) clearTimeout(refetchTimer)
    refetchTimer = setTimeout(() => {
      refetchTimer = null
      // A new burst may have started while we waited; let it finish first.
      if (inFlight > 0) return
      burstError = null
      options.onRefetch()
    }, refetchDelayMs)
  }

  const enqueue = <T,>(key: string, op: () => Promise<T>, handlers: EnqueueHandlers<T>): Promise<void> => {
    const seq = ++nextSeq
    inFlight += 1

    const run = async () => {
      try {
        const result = await op()
        // Stale response: a newer mutation already painted the board.
        if (seq > lastApplied) {
          lastApplied = seq
          handlers.apply(result)
        }
      } catch (error) {
        handlers.onError?.(error)
        if (burstError === null) {
          burstError = { error }
          options.onError(error)
        }
      } finally {
        inFlight -= 1
        maybeRecover()
      }
    }

    const tail = (chains.get(key) ?? Promise.resolve()).then(run, run)
    chains.set(key, tail)
    void tail.then(() => {
      // Let the map shrink once this key goes quiet.
      if (chains.get(key) === tail) chains.delete(key)
    })
    return tail
  }

  return {
    enqueue,
    lastAppliedSeq: () => lastApplied,
    inFlight: () => inFlight,
    dispose: () => {
      if (refetchTimer !== null) clearTimeout(refetchTimer)
      refetchTimer = null
    },
  }
}
