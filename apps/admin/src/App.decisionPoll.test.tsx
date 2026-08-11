/**
 * Regression test for the "Send decision emails" progress toast hanging
 * forever at "Sending decisions… 0/2 processed" (evaluation defect: the bulk
 * job progress poll had no ceiling of its own).
 *
 * `pollBulkJob` (workspace/messaging.tsx) is deliberately open-ended — a
 * compose/remind job can legitimately take a while, and those callers want an
 * unbounded "in progress" state. The decision-email toast promises delivery
 * "within a minute" right after it posts, so `pollDecisionJob` (App.tsx)
 * wraps it with a hard timeout: past that ceiling, stop polling and tell the
 * organiser instead of leaving the toast implying work is still happening.
 *
 * This exercises `pollDecisionJob` directly with fake timers and a mocked
 * `getBulkJob`, rather than mounting the whole shell — App.tsx has no seam
 * for standing up a full workspace + selection + bulk-bar render cheaply,
 * and the earlier CFP-14 fix (jobs/bulkJobs.ts's deliverNow, covered by
 * apps/api/test/bulkjobs-expander-decisions-notify.test.ts) already pins the
 * server side of "does the job actually reach a truthful terminal state".
 * This test pins the client's promise that the poll always resolves one way
 * or another, even when the server side never settles.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const getBulkJob = vi.fn()

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return { ...actual, getBulkJob: (...args: unknown[]) => getBulkJob(...args) }
})

import { pollDecisionJob } from './App'
import type { BulkJobStatus } from './api'

const job = (overrides: Partial<BulkJobStatus> = {}): BulkJobStatus => ({
  id: 'job-1',
  kind: 'send-decisions',
  status: 'running',
  total: 2,
  enqueued: 0,
  sent: 0,
  failed: 0,
  queued: 0,
  error: null,
  ...overrides,
})

beforeEach(() => {
  getBulkJob.mockReset()
})

describe('pollDecisionJob', () => {
  it('resolves via onSettled once the job reaches a terminal state, and never fires onTimeout afterwards', async () => {
    vi.useFakeTimers()
    try {
      getBulkJob
        .mockResolvedValueOnce(job({ status: 'running', enqueued: 0 }))
        .mockResolvedValueOnce(job({ status: 'running', enqueued: 1 }))
        .mockResolvedValueOnce(job({ status: 'done', enqueued: 2, sent: 2 }))

      const onProgress = vi.fn()
      const onSettled = vi.fn()
      const onTimeout = vi.fn()
      pollDecisionJob('job-1', { onProgress, onSettled, onError: vi.fn(), onTimeout }, 60_000)

      await vi.advanceTimersByTimeAsync(0) // first tick: running, enqueued 0
      await vi.advanceTimersByTimeAsync(3_000) // second tick: running, enqueued 1
      await vi.advanceTimersByTimeAsync(3_000) // third tick: done -> settles

      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onSettled.mock.calls[0][0]).toMatchObject({ status: 'done', enqueued: 2, sent: 2 })
      expect(onProgress).toHaveBeenCalledTimes(2)

      // Settling must have cancelled the internal timeout guard — advancing
      // well past the timeout window afterwards must not also fire onTimeout.
      await vi.advanceTimersByTimeAsync(120_000)
      expect(onTimeout).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops polling and calls onTimeout when the job never reaches a terminal state (the "0/2 processed" hang)', async () => {
    vi.useFakeTimers()
    try {
      getBulkJob.mockResolvedValue(job({ status: 'running', enqueued: 0 }))

      const onSettled = vi.fn()
      const onTimeout = vi.fn()
      pollDecisionJob('job-2', { onSettled, onError: vi.fn(), onTimeout }, 10_000)

      await vi.advanceTimersByTimeAsync(10_000)

      expect(onTimeout).toHaveBeenCalledTimes(1)
      expect(onSettled).not.toHaveBeenCalled()

      // The timeout must have cancelled the underlying poll — no further
      // getBulkJob calls once it fires, or the toast could flip back to
      // "Sending…" after already telling the organiser to check the list.
      const callsAtTimeout = getBulkJob.mock.calls.length
      await vi.advanceTimersByTimeAsync(30_000)
      expect(getBulkJob.mock.calls.length).toBe(callsAtTimeout)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancel() stops polling and suppresses the timeout', async () => {
    vi.useFakeTimers()
    try {
      getBulkJob.mockResolvedValue(job({ status: 'running' }))
      const onTimeout = vi.fn()
      const handle = pollDecisionJob('job-3', { onSettled: vi.fn(), onError: vi.fn(), onTimeout }, 5_000)

      await vi.advanceTimersByTimeAsync(0)
      handle.cancel()
      await vi.advanceTimersByTimeAsync(20_000)

      expect(onTimeout).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
