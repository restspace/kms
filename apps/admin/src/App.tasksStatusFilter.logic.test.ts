// Tasks tab status filter (baseline defect: "no complete/incomplete status
// filter ... only column sorting"). `tasksDataSourceWithStatusFilter` is the
// translation from the TaskStatusFilter chip's `taskState` value into the
// query adminApi.ts's tasks resource actually understands — `complete` and
// `overdue` map onto existing filter keys 1:1, while `open` has no single
// matching value server-side and is covered by fetching both incomplete
// statuses and merging client-side. This pins that translation without
// standing up a whole App render.

import { describe, expect, it, vi } from 'vitest'
import { tasksDataSourceWithStatusFilter } from './App'
import type { DataSourceParams, DataSourceResult } from './components/DataList'
import type { TaskAssignmentRow } from './api'

const row = (id: string, status: TaskAssignmentRow['status'], due_at: string | null = null): TaskAssignmentRow =>
  ({ id, status, due_at } as unknown as TaskAssignmentRow)

describe('tasksDataSourceWithStatusFilter', () => {
  it('passes "complete" through as the resource\'s status=complete filter', async () => {
    const base = vi.fn(
      async (): Promise<DataSourceResult<TaskAssignmentRow>> => ({ items: [row('1', 'complete')], total: 1 }),
    )
    const wrapped = tasksDataSourceWithStatusFilter(base)
    const params: DataSourceParams = { from: 0, size: 20, filters: { taskState: 'complete', q: 'agreement' } }
    const result = await wrapped(params)
    expect(base).toHaveBeenCalledWith({ ...params, filters: { q: 'agreement', status: 'complete' } })
    expect(result.total).toBe(1)
  })

  it('passes "overdue" through as the resource\'s overdue=true filter', async () => {
    const base = vi.fn(async (): Promise<DataSourceResult<TaskAssignmentRow>> => ({ items: [], total: 0 }))
    const wrapped = tasksDataSourceWithStatusFilter(base)
    const params: DataSourceParams = { from: 0, size: 20, filters: { taskState: 'overdue' } }
    await wrapped(params)
    expect(base).toHaveBeenCalledWith({ ...params, filters: { overdue: 'true' } })
  })

  it('drops the taskState key and calls through unfiltered for the "All" chip', async () => {
    const base = vi.fn(async (): Promise<DataSourceResult<TaskAssignmentRow>> => ({ items: [], total: 0 }))
    const wrapped = tasksDataSourceWithStatusFilter(base)
    const params: DataSourceParams = { from: 0, size: 20, filters: { taskState: '', contact_id: 'con-1' } }
    await wrapped(params)
    expect(base).toHaveBeenCalledWith({ ...params, filters: { contact_id: 'con-1' } })
  })

  it('"open" merges not_started + in_progress results and re-paginates client-side', async () => {
    const base = vi.fn(async (p: DataSourceParams): Promise<DataSourceResult<TaskAssignmentRow>> => {
      if (p.filters.status === 'not_started') return { items: [row('a', 'not_started'), row('b', 'not_started')], total: 2 }
      if (p.filters.status === 'in_progress') return { items: [row('c', 'in_progress')], total: 1 }
      throw new Error(`unexpected filters ${JSON.stringify(p.filters)}`)
    })
    const wrapped = tasksDataSourceWithStatusFilter(base)
    const params: DataSourceParams = { from: 0, size: 2, filters: { taskState: 'open' } }
    const result = await wrapped(params)
    expect(result.total).toBe(3)
    expect(result.items).toHaveLength(2)
    expect(result.items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(base).toHaveBeenCalledTimes(2)
  })

  it('"open" sorts the merged set by the requested field/direction before paginating', async () => {
    const base = vi.fn(async (p: DataSourceParams): Promise<DataSourceResult<TaskAssignmentRow>> => {
      if (p.filters.status === 'not_started') return { items: [row('a', 'not_started', '2026-08-20')], total: 1 }
      if (p.filters.status === 'in_progress') return { items: [row('b', 'in_progress', '2026-08-10')], total: 1 }
      throw new Error('unexpected')
    })
    const wrapped = tasksDataSourceWithStatusFilter(base)
    const params: DataSourceParams = {
      from: 0,
      size: 10,
      filters: { taskState: 'open' },
      sort: { field: 'due_at', direction: 'asc' },
    }
    const result = await wrapped(params)
    expect(result.items.map((i) => i.id)).toEqual(['b', 'a'])
  })
})
