import { describe, expect, it, vi } from 'vitest'
import { stopSessionRuns } from './agent-run-control'

const run = (over: Record<string, unknown>) => ({
  runId: 'r',
  sessionKey: 's1',
  friendlyId: 'main',
  status: 'active',
  updatedAt: 1,
  ...over,
})

describe('stopSessionRuns', () => {
  it('aborts live streams and marks every open run for the session as stopped', async () => {
    const markStatus = vi.fn(async () => null)
    const abort = vi.fn((runId: string) => runId === 'live')
    const result = await stopSessionRuns('s1', {
      listRuns: async () => [
        run({ runId: 'live' }),
        run({ runId: 'orphan' }),
        run({ runId: 'other-session', sessionKey: 's2', friendlyId: 's2' }),
      ] as never,
      markStatus,
      abort,
    })
    expect(result).toEqual({ stopped: 2, aborted: 1, runIds: ['live', 'orphan'] })
    expect(markStatus).toHaveBeenCalledWith('s1', 'live', 'error', 'Stopped by user')
    expect(markStatus).toHaveBeenCalledWith('s1', 'orphan', 'error', 'Stopped by user')
    expect(markStatus).toHaveBeenCalledTimes(2)
  })

  it('matches the session by friendly id as well as key', async () => {
    const result = await stopSessionRuns('main', {
      listRuns: async () => [run({ runId: 'a' })] as never,
      markStatus: async () => null,
      abort: () => false,
    })
    expect(result.runIds).toEqual(['a'])
  })

  it('returns nothing to stop when the session has no open runs', async () => {
    const markStatus = vi.fn(async () => null)
    const result = await stopSessionRuns('s9', {
      listRuns: async () => [run({})] as never,
      markStatus,
      abort: () => false,
    })
    expect(result).toEqual({ stopped: 0, aborted: 0, runIds: [] })
    expect(markStatus).not.toHaveBeenCalled()
  })

  it('a failing status write for one run does not block the others', async () => {
    const markStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk'))
      .mockResolvedValueOnce(null)
    const result = await stopSessionRuns('s1', {
      listRuns: async () => [run({ runId: 'a' }), run({ runId: 'b' })] as never,
      markStatus,
      abort: () => false,
    })
    expect(result.runIds).toEqual(['a', 'b'])
    expect(markStatus).toHaveBeenCalledTimes(2)
  })
})
