import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildJobMutationPayload,
  findJobById,
  getJobErrorText,
  getLatestJobOutputText,
  isFailedJobState,
  isTerminalJobState,
  normalizeJobState,
  normalizeJobsResponse,
  triggerJob,
} from './jobs-api'
import type { HermesJob, JobOutput } from './jobs-api'

const job = {
  id: 'job-1',
  name: 'Example job',
  prompt: 'Run the example job',
  schedule: {},
  enabled: true,
  state: 'scheduled',
} satisfies HermesJob

describe('normalizeJobsResponse', () => {
  it('accepts dashboard cron jobs returned as a top-level array', () => {
    expect(normalizeJobsResponse([job])).toEqual([job])
  })

  it('accepts gateway jobs returned in an object wrapper', () => {
    expect(normalizeJobsResponse({ jobs: [job] })).toEqual([job])
  })

  it('falls back to an empty list for unexpected payloads', () => {
    expect(normalizeJobsResponse({ jobs: null })).toEqual([])
  })
})

describe('job helpers', () => {
  it('finds jobs by id', () => {
    expect(findJobById([job], 'job-1')).toEqual(job)
    expect(findJobById([job], 'missing')).toBeNull()
    expect(findJobById([job], null)).toBeNull()
  })

  it('normalizes and classifies job states', () => {
    expect(normalizeJobState(' Running ')).toBe('running')
    expect(isFailedJobState('errored')).toBe(true)
    expect(isFailedJobState('running')).toBe(false)
    expect(isTerminalJobState('success')).toBe(true)
    expect(isTerminalJobState('done')).toBe(true)
    expect(isTerminalJobState('scheduled')).toBe(false)
  })

  it('returns the latest non-empty job output text', () => {
    const outputs: Array<JobOutput> = [
      { filename: 'a.log', timestamp: '2026-04-30T12:00:00Z', content: 'older run', size: 9 },
      { filename: 'b.log', timestamp: '2026-04-30T12:05:00Z', content: '   ', size: 3 },
      { filename: 'c.log', timestamp: '2026-04-30T12:10:00Z', content: 'newest run', size: 10 },
    ]

    expect(getLatestJobOutputText(outputs)).toBe('newest run')
  })

  it('prefers explicit job error text', () => {
    expect(getJobErrorText({ ...job, last_run_error: '  boom  ' })).toBe('boom')
    expect(getJobErrorText({ ...job, last_run_error: null, error: 'oops' })).toBe('oops')
    expect(getJobErrorText(null)).toBeNull()
  })
})


describe('job mutation payloads', () => {
  it('sends prompt as input for Hermes cron APIs that require an input string', () => {
    expect(
      buildJobMutationPayload({
        name: 'Daily summary',
        schedule: 'every 30m',
        prompt: 'summarize the latest notes',
        deliver: ['local'],
      }),
    ).toEqual({
      name: 'Daily summary',
      schedule: 'every 30m',
      prompt: 'summarize the latest notes',
      input: 'summarize the latest notes',
      deliver: 'local',
    })
  })

  it('serializes multiple delivery targets into the string format expected by Hermes cron APIs', () => {
    expect(
      buildJobMutationPayload({
        name: 'Push updates',
        schedule: '0 9 * * *',
        prompt: 'send the daily sync',
        deliver: ['local', 'discord'],
      }),
    ).toEqual({
      name: 'Push updates',
      schedule: '0 9 * * *',
      prompt: 'send the daily sync',
      input: 'send the daily sync',
      deliver: 'local,discord',
    })
  })
})

describe('triggerJob', () => {
  afterEach(() => vi.unstubAllGlobals())

  // Real behavior on hermes-dashboard v0.21.1 (executions.db, 2026-09-25): after a manual
  // run, a second Run-now for the same schedule slot is refused with HTTP 409
  // {"detail":"Job is already running or was claimed by another scheduler"} and the audit
  // row says "Fire claim was not acquired". Nothing is actually running, so the raw text
  // misleads; the UI should say what really happened and how to force a run.
  it('explains a 409 truthfully instead of echoing "already running"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ detail: 'Job is already running or was claimed by another scheduler' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    await expect(triggerJob('abc')).rejects.toThrow(/already ran for its current schedule slot/i)
    await expect(triggerJob('abc')).rejects.toThrow(/pause it first/i)
  })

  it('still surfaces other errors from the server body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: 'Job not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    await expect(triggerJob('abc')).rejects.toThrow('Job not found')
  })
})
