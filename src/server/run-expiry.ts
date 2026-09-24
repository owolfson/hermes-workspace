import { listAllActiveRuns, markRunStatus } from './run-store'
import type { PersistedRunState } from './run-store'

// Runs are marked complete/error by the stream that owns them. When that stream dies
// without cleanup (tab closed, workspace restarted) the record stays "active" forever;
// the Background Runs panel had 112 of them, the oldest 19 days old. A run that has not
// moved for hours is not running, so close it out.
export const DEFAULT_RUN_MAX_IDLE_MS = 6 * 60 * 60 * 1000

export async function expireStaleRuns(input: {
  now?: number
  maxIdleMs?: number
  listRuns?: () => Promise<Array<PersistedRunState>>
  markStatus?: typeof markRunStatus
} = {}): Promise<Array<string>> {
  const now = input.now ?? Date.now()
  const maxIdleMs = input.maxIdleMs ?? DEFAULT_RUN_MAX_IDLE_MS
  const listRuns = input.listRuns ?? listAllActiveRuns
  const markStatus = input.markStatus ?? markRunStatus

  const expired: Array<string> = []
  for (const run of await listRuns()) {
    if (now - run.updatedAt <= maxIdleMs) continue
    try {
      await markStatus(
        run.sessionKey,
        run.runId,
        'error',
        `Expired: no activity for over ${Math.round(maxIdleMs / 3_600_000)} hours`,
      )
      expired.push(run.runId)
    } catch {
      // Leave it for the next sweep.
    }
  }
  return expired
}
