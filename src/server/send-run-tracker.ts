const ACTIVE_RUNS_KEY = '__claude_active_send_runs__' as const
const ABORTS_KEY = '__claude_active_send_run_aborts__' as const

type TrackerGlobal = typeof globalThis & {
  [ACTIVE_RUNS_KEY]?: Set<string>
  [ABORTS_KEY]?: Map<string, () => void>
}

// Kept on globalThis so every bundled copy of this module sees the same runs.
function getActiveRuns(): Set<string> {
  const globalValue = globalThis as TrackerGlobal
  if (!globalValue[ACTIVE_RUNS_KEY]) {
    globalValue[ACTIVE_RUNS_KEY] = new Set<string>()
  }
  return globalValue[ACTIVE_RUNS_KEY]
}

function getAborts(): Map<string, () => void> {
  const globalValue = globalThis as TrackerGlobal
  if (!globalValue[ABORTS_KEY]) {
    globalValue[ABORTS_KEY] = new Map<string, () => void>()
  }
  return globalValue[ABORTS_KEY]
}

/** `abort` lets another request (Agent View "kill") stop a stream it did not start. */
export function registerActiveSendRun(runId: string, abort?: () => void): void {
  if (!runId) return
  getActiveRuns().add(runId)
  if (abort) getAborts().set(runId, abort)
}

export function unregisterActiveSendRun(runId: string): void {
  if (!runId) return
  getActiveRuns().delete(runId)
  getAborts().delete(runId)
}

export function hasActiveSendRun(runId: string | null | undefined): boolean {
  if (!runId) return false
  return getActiveRuns().has(runId)
}

/** Stop an in-flight stream started in this process. False if it has no abort handle. */
export function abortActiveSendRun(runId: string): boolean {
  const abort = getAborts().get(runId)
  if (!abort) return false
  try {
    abort()
  } catch {
    // Already closed; the caller still cleans up run state.
  }
  return true
}
