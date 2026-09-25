import { describe, expect, it } from 'vitest'
import { effectiveResolvedAt, isDegradedOverview } from '../overview-cache-policy'

const healthy = { status: {}, modelInfo: {}, analytics: {}, cron: {} } as never

describe('isDegradedOverview', () => {
  it('is false when every core section resolved', () => {
    expect(isDegradedOverview(healthy)).toBe(false)
  })

  // Real failure seen 2026-09-25: right after a workspace restart the dashboard was busy
  // (cold analytics rollup), /api/model/info timed out, modelInfo came back null and the
  // dashboard card said "Offline" + "0 installed" for the whole 10-minute cache TTL.
  it('is true when any core section is null (model info, status, analytics, cron)', () => {
    for (const key of ['status', 'modelInfo', 'analytics', 'cron']) {
      expect(isDegradedOverview({ ...(healthy as object), [key]: null } as never)).toBe(true)
    }
  })

  it('does not treat optional plugin sections (kanban, achievements, logs) as degradation', () => {
    expect(isDegradedOverview({ ...(healthy as object), kanban: null, achievements: null, logs: null } as never)).toBe(false)
  })
})

describe('effectiveResolvedAt', () => {
  const TTL = 600_000
  const DEGRADED = 30_000
  const now = 1_000_000

  it('healthy results keep the full TTL (resolved at now)', () => {
    expect(effectiveResolvedAt(healthy, now, TTL, DEGRADED)).toBe(now)
  })

  it('degraded results expire after only the short TTL', () => {
    const degraded = { ...(healthy as object), modelInfo: null } as never
    const resolvedAt = effectiveResolvedAt(degraded, now, TTL, DEGRADED)
    // fresh while now' - resolvedAt < TTL  =>  fresh for exactly DEGRADED ms
    expect(now + DEGRADED - resolvedAt).toBe(TTL)
    expect(now + DEGRADED - 1 - resolvedAt).toBeLessThan(TTL)
  })
})
