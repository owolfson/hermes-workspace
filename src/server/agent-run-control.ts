import { abortActiveSendRun } from './send-run-tracker'
import { listAllActiveRuns, markRunStatus } from './run-store'
import type { PersistedRunState } from './run-store'

export type StopSessionRunsResult = {
  stopped: number
  aborted: number
  runIds: Array<string>
}

type StopDeps = {
  listRuns: () => Promise<Array<PersistedRunState>>
  markStatus: typeof markRunStatus
  abort: (runId: string) => boolean
}

const defaultDeps: StopDeps = {
  listRuns: listAllActiveRuns,
  markStatus: markRunStatus,
  abort: abortActiveSendRun,
}

/**
 * Stop every open run of a session. Portable chat streams are workspace-owned
 * (the run id is minted here, not by the gateway), so "kill" means aborting the
 * in-flight stream, which cancels the upstream request, and closing out the run
 * record so it stops showing as active. Orphaned runs (no live stream, e.g. after
 * a restart) are just closed out.
 */
export async function stopSessionRuns(
  sessionKey: string,
  deps: StopDeps = defaultDeps,
): Promise<StopSessionRunsResult> {
  const runs = (await deps.listRuns()).filter(
    (run) => run.sessionKey === sessionKey || run.friendlyId === sessionKey,
  )
  const result: StopSessionRunsResult = { stopped: 0, aborted: 0, runIds: [] }
  for (const run of runs) {
    if (deps.abort(run.runId)) result.aborted += 1
    try {
      await deps.markStatus(run.sessionKey, run.runId, 'error', 'Stopped by user')
    } catch {
      // Best effort: the stream is already aborted; keep stopping the rest.
    }
    result.stopped += 1
    result.runIds.push(run.runId)
  }
  return result
}
