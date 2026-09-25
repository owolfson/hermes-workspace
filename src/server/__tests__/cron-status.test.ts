import { describe, expect, it } from 'vitest'
import { lastRunSuccess } from '../hermes-cron-profiles'

// Real last_status values seen on the live dashboard (2026-09-25):
// ok, delivery_failed (mm-* jobs: ran fine, delivery to "origin" can't push),
// blocked_config (apex-quant-review-11am: never ran — telegram not configured).
describe('lastRunSuccess', () => {
  it('maps clear successes', () => {
    for (const s of ['ok', 'success', 'succeeded', 'completed', 'done']) {
      expect(lastRunSuccess({ last_status: s })).toBe(true)
    }
  })

  it('treats delivery_failed as a successful RUN (the job executed; only delivery failed)', () => {
    expect(lastRunSuccess({ last_status: 'delivery_failed' })).toBe(true)
  })

  it('maps clear failures, including blocked_config (the run never happened)', () => {
    for (const s of ['error', 'failed', 'failure', 'cancelled', 'blocked_config', 'timeout']) {
      expect(lastRunSuccess({ last_status: s })).toBe(false)
    }
  })

  it('is case-insensitive and stays null for missing or unrecognised statuses', () => {
    expect(lastRunSuccess({ last_status: 'OK' })).toBe(true)
    expect(lastRunSuccess({})).toBeNull()
    expect(lastRunSuccess({ last_status: 'weird-new-status' })).toBeNull()
  })
})
