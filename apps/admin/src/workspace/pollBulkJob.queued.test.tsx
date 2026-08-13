/**
 * Handoff defect (crm-messaging wave): `pollBulkJob` stopped permanently at
 * the first `status === 'done'`, so recipient rows still "queued" at settle
 * time never updated the compose banner even though GET /bulk-jobs/:id keeps
 * returning live counts as the sweep cron drains the outbox. The loop now
 * reports the settled job immediately, then keeps polling a BOUNDED number of
 * follow-ups with backoff while `queued > 0`, re-invoking `onSettled` with
 * fresher counts each time — and stops for good once the outbox is empty or
 * the budget is spent (locally crons never fire, so "queued" may legitimately
 * never advance). Same fake-timer harness as App.decisionPoll.test.tsx.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const getBulkJob = vi.fn()

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, getBulkJob: (...args: unknown[]) => getBulkJob(...args) }
})

import { pollBulkJob } from './messaging'
import type { BulkJobStatus } from '../api'

const job = (overrides: Partial<BulkJobStatus> = {}): BulkJobStatus => ({
  id: 'job-1',
  kind: 'compose',
  status: 'running',
  total: 3,
  enqueued: 3,
  sent: 0,
  failed: 0,
  queued: 0,
  error: null,
  ...overrides,
})

beforeEach(() => {
  getBulkJob.mockReset()
})

describe('pollBulkJob after a done-but-still-queued settle', () => {
  it('keeps polling and re-reports onSettled as queued rows drain, then stops once empty', async () => {
    vi.useFakeTimers()
    try {
      getBulkJob
        .mockResolvedValueOnce(job({ status: 'done', sent: 1, queued: 2 }))
        .mockResolvedValueOnce(job({ status: 'done', sent: 2, queued: 1 }))
        .mockResolvedValueOnce(job({ status: 'done', sent: 3, queued: 0 }))

      const onSettled = vi.fn()
      pollBulkJob('job-1', { onSettled, onError: vi.fn() }, 3_000)

      await vi.advanceTimersByTimeAsync(0) // first tick: done, 2 queued
      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onSettled.mock.calls[0][0]).toMatchObject({ sent: 1, queued: 2 })

      await vi.advanceTimersByTimeAsync(6_000) // follow-up 1 (backoff 2x)
      expect(onSettled).toHaveBeenCalledTimes(2)
      expect(onSettled.mock.calls[1][0]).toMatchObject({ sent: 2, queued: 1 })

      await vi.advanceTimersByTimeAsync(12_000) // follow-up 2 (backoff 4x)
      expect(onSettled).toHaveBeenCalledTimes(3)
      expect(onSettled.mock.calls[2][0]).toMatchObject({ sent: 3, queued: 0 })

      // Outbox empty — no further polls however long we wait.
      const calls = getBulkJob.mock.calls.length
      await vi.advanceTimersByTimeAsync(600_000)
      expect(getBulkJob.mock.calls.length).toBe(calls)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after a bounded number of follow-ups when queued never advances (no cron locally)', async () => {
    vi.useFakeTimers()
    try {
      getBulkJob.mockResolvedValue(job({ status: 'done', sent: 0, queued: 3 }))

      const onSettled = vi.fn()
      pollBulkJob('job-2', { onSettled, onError: vi.fn() }, 3_000)

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(600_000) // far past every backoff step

      // Initial settle + 5 bounded follow-ups, then silence.
      expect(onSettled).toHaveBeenCalledTimes(6)
      const calls = getBulkJob.mock.calls.length
      await vi.advanceTimersByTimeAsync(600_000)
      expect(getBulkJob.mock.calls.length).toBe(calls)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failing follow-up poll stops quietly instead of replacing the settled banner with an error', async () => {
    vi.useFakeTimers()
    try {
      getBulkJob
        .mockResolvedValueOnce(job({ status: 'done', sent: 1, queued: 2 }))
        .mockRejectedValueOnce(new Error('network blip'))

      const onSettled = vi.fn()
      const onError = vi.fn()
      pollBulkJob('job-3', { onSettled, onError }, 3_000)

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(6_000)

      expect(onSettled).toHaveBeenCalledTimes(1)
      expect(onError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a failed job stays terminal — one onSettled, no follow-ups', async () => {
    vi.useFakeTimers()
    try {
      getBulkJob.mockResolvedValue(job({ status: 'failed', queued: 2, error: 'boom' }))

      const onSettled = vi.fn()
      pollBulkJob('job-4', { onSettled, onError: vi.fn() }, 3_000)

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(600_000)
      expect(onSettled).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancel() suppresses the follow-up polls too', async () => {
    vi.useFakeTimers()
    try {
      getBulkJob.mockResolvedValue(job({ status: 'done', sent: 1, queued: 2 }))

      const onSettled = vi.fn()
      const handle = pollBulkJob('job-5', { onSettled, onError: vi.fn() }, 3_000)

      await vi.advanceTimersByTimeAsync(0)
      expect(onSettled).toHaveBeenCalledTimes(1)
      handle.cancel()
      await vi.advanceTimersByTimeAsync(600_000)
      expect(onSettled).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
