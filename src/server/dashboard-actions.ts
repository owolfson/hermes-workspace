import { dashboardFetch } from './gateway-capabilities'

/**
 * Hub skill install/uninstall on hermes-dashboard v0.21.1 are asynchronous: the POST
 * returns `{ ok, pid, name }` immediately and the work (fetch, quarantine, security
 * scan, install — about 1-2 minutes for an install) runs in the background, reported
 * by GET /api/actions/{name}/status. Answering "success" at POST time would tell the
 * user it worked before anything happened (and hide a failure entirely), so callers
 * wait for the action to finish.
 */

export type ActionState = 'running' | 'done' | 'failed' | 'unknown'

export type ActionOutcome = { state: ActionState; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function interpretActionStatus(
  raw: unknown,
  opts: { expect?: 'Installed' | 'Uninstalled' } = {},
): ActionOutcome {
  if (!isRecord(raw) || typeof raw.running !== 'boolean') {
    return { state: 'unknown', message: 'Action status unavailable.' }
  }
  const lines = Array.isArray(raw.lines)
    ? raw.lines.filter((l): l is string => typeof l === 'string' && l.trim() !== '')
    : []
  if (raw.running) return { state: 'running', message: lines[lines.length - 1] ?? '' }
  if (raw.exit_code === 0) {
    const summary = [...lines].reverse().find((l) => /^(Installed|Uninstalled)\b/.test(l))
    // The CLI exits 0 even when it did nothing (e.g. uninstalling a name it doesn't
    // know prints "(may be a builtin)"). When the caller knows what a real success
    // looks like, a missing summary line is a failure, never a silent success.
    if (opts.expect && !(summary ?? '').startsWith(opts.expect)) {
      const detail = lines[lines.length - 1] ?? ''
      return {
        state: 'failed',
        message: `Nothing was ${opts.expect.toLowerCase()}${detail ? `: ${detail}` : '.'}`,
      }
    }
    return { state: 'done', message: summary ?? lines[lines.length - 1] ?? 'Done.' }
  }
  const tail = lines.slice(-3).join(' ')
  return {
    state: 'failed',
    message: tail || `Action exited with code ${String(raw.exit_code ?? 'unknown')}.`,
  }
}

/** Poll the dashboard until the named action finishes, or give up after timeoutMs. */
export async function waitForDashboardAction(
  name: string,
  opts: {
    timeoutMs?: number
    intervalMs?: number
    expect?: 'Installed' | 'Uninstalled'
  } = {},
): Promise<ActionOutcome & { timedOut: boolean }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 240_000)
  const interval = opts.intervalMs ?? 2_000
  let last: ActionOutcome = { state: 'running', message: '' }
  while (Date.now() < deadline) {
    try {
      const res = await dashboardFetch(
        `/api/actions/${encodeURIComponent(name)}/status`,
        { signal: AbortSignal.timeout(15_000) },
      )
      last = interpretActionStatus(await res.json().catch(() => null), {
        expect: opts.expect,
      })
      if (last.state === 'done' || last.state === 'failed') {
        return { ...last, timedOut: false }
      }
    } catch {
      // transient dashboard hiccup — keep polling until the deadline
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  return { ...last, timedOut: true }
}
