import { describe, expect, it, vi } from 'vitest'
import { expireStaleRuns } from './run-expiry'

const HOUR = 60 * 60 * 1000
const run = (runId: string, ageMs: number, status = 'active', now = 1_000_000_000_000) => ({
  runId,
  sessionKey: `s-${runId}`,
  friendlyId: 'main',
  status,
  updatedAt: now - ageMs,
})

describe('expireStaleRuns', () => {
  const now = 1_000_000_000_000

  it('closes out open runs idle longer than the limit and leaves fresh ones alone', async () => {
    const markStatus = vi.fn(async () => null)
    const expired = await expireStaleRuns({
      now,
      maxIdleMs: 6 * HOUR,
      listRuns: async () =>
        [run('zombie', 19 * 24 * HOUR), run('old', 7 * HOUR), run('fresh', 2 * 60 * 1000), run('borderline', 5 * HOUR)] as never,
      markStatus,
    })
    expect(expired).toEqual(['zombie', 'old'])
    expect(markStatus).toHaveBeenCalledWith('s-zombie', 'zombie', 'error', expect.stringContaining('no activity'))
    expect(markStatus).toHaveBeenCalledTimes(2)
  })

  it('reports only the runs it actually closed when a write fails', async () => {
    const markStatus = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValueOnce(null)
    const expired = await expireStaleRuns({
      now,
      maxIdleMs: HOUR,
      listRuns: async () => [run('a', 3 * HOUR), run('b', 3 * HOUR)] as never,
      markStatus,
    })
    expect(expired).toEqual(['b'])
  })

  it('does nothing when there are no runs', async () => {
    const markStatus = vi.fn()
    expect(await expireStaleRuns({ now, maxIdleMs: HOUR, listRuns: async () => [], markStatus })).toEqual([])
    expect(markStatus).not.toHaveBeenCalled()
  })
})
