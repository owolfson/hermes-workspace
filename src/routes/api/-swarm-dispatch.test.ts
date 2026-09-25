import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildHermesChatQueryArgs,
  buildHermesTmuxLaunchCommand,
  buildWorkerPrompt,
  checkpointFromRuntimeSnapshot,
  classifyHermesTuiPane,
  describeOneshotFailure,
  markCheckpointResult,
  markDispatchResult,
  markDispatchStarted,
  readRuntimeCheckpointSnapshot,
  runtimeCheckpointIsFresh,
  dispatchBlockReason,
  runtimeCheckpointSignature,
  runtimeSnapshotIsFresh,
} from './swarm-dispatch'

describe('checkpointFromRuntimeSnapshot', () => {
  it('maps runtime lifecycle fields into a structured checkpoint', () => {
    const checkpoint = checkpointFromRuntimeSnapshot({
      checkpointStatus: 'done',
      state: 'idle',
      lastSummary: 'Patched dispatch polling',
      lastResult: 'Structured checkpoint returned to RouterChat',
      nextAction: 'Verify in UI flow',
      blockedReason: null,
      lastCheckIn: '2026-04-28T20:00:00.000Z',
      lastOutputAt: 1_746_000_000_000,
      checkpointRaw: null,
    })

    expect(checkpoint).not.toBeNull()
    expect(checkpoint?.stateLabel).toBe('DONE')
    expect(checkpoint?.checkpointStatus).toBe('done')
    expect(checkpoint?.result).toBe('Structured checkpoint returned to RouterChat')
    expect(checkpoint?.nextAction).toBe('Verify in UI flow')
    expect(checkpoint?.raw).toContain('STATE: DONE')
  })

  it('returns null when runtime has no meaningful checkpoint fields yet', () => {
    const checkpoint = checkpointFromRuntimeSnapshot({
      checkpointStatus: 'in_progress',
      state: 'executing',
      lastSummary: null,
      lastResult: null,
      nextAction: null,
      blockedReason: null,
      lastCheckIn: '2026-04-28T20:00:00.000Z',
      lastOutputAt: 1_746_000_000_000,
      checkpointRaw: null,
    })

    expect(checkpoint).toBeNull()
  })
})

describe('dispatchBlockReason', () => {
  it('turns failed or timed-out dispatch results into mission blocker text', () => {
    expect(dispatchBlockReason({ ok: false, error: 'Command failed: worker exited', output: '', checkpointStatus: undefined })).toBe('Command failed: worker exited')
    expect(dispatchBlockReason({ ok: true, error: null, output: 'Delivered', checkpointStatus: 'timeout' })).toBe('No fresh checkpoint before poll timeout.')
    expect(dispatchBlockReason({ ok: true, error: null, output: 'Checkpoint DONE', checkpointStatus: 'checkpointed' })).toBeNull()
  })
})

describe('runtimeSnapshotIsFresh', () => {
  it('requires a changed snapshot with post-dispatch activity', () => {
    const baseline = {
      checkpointStatus: 'in_progress' as const,
      state: 'executing',
      lastSummary: 'Dispatched task',
      lastResult: null,
      nextAction: 'Wait for worker',
      blockedReason: null,
      lastCheckIn: '2026-04-28T19:59:00.000Z',
      lastOutputAt: 1_745_999_900_000,
      checkpointRaw: null,
    }
    const dispatchedAt = 1_746_000_000_000

    expect(runtimeSnapshotIsFresh(baseline, runtimeCheckpointSignature(baseline), dispatchedAt)).toBe(false)

    const updated = {
      ...baseline,
      checkpointStatus: 'done' as const,
      lastResult: 'Completed backend patch',
      nextAction: 'Hand off to UI',
      lastCheckIn: '2026-04-28T20:00:01.000Z',
      lastOutputAt: 1_746_000_001_000,
    }

    expect(runtimeSnapshotIsFresh(updated, runtimeCheckpointSignature(baseline), dispatchedAt)).toBe(true)
  })
})

describe('checkpoint filtering', () => {
  it('still parses IN_PROGRESS runtime snapshots but leaves terminal filtering to the poller', () => {
    const checkpoint = checkpointFromRuntimeSnapshot({
      checkpointStatus: 'in_progress',
      state: 'executing',
      lastSummary: 'Task is running',
      lastResult: null,
      nextAction: 'Wait for worker output',
      blockedReason: null,
      lastCheckIn: '2026-04-28T20:00:01.000Z',
      lastOutputAt: 1_746_000_001_000,
      checkpointRaw: null,
    })

    expect(checkpoint?.stateLabel).toBe('IN_PROGRESS')
  })
})

describe('buildHermesTmuxLaunchCommand', () => {
  it('keeps the tmux shell alive so startup failures leave readable output', () => {
    const command = buildHermesTmuxLaunchCommand({
      profilePath: '/tmp/hermes profiles/swarm1',
      hermesBin: '/opt/homebrew/bin/hermes',
      ghToken: 'ghp_te...3456',
    })

    expect(command).toContain("HERMES_HOME='/tmp/hermes profiles/swarm1'")
    expect(command).toContain("'/opt/homebrew/bin/hermes' chat --tui")
    expect(command).toContain('[Hermes worker exited with status %s]')
    expect(command).not.toContain('exec ')
  })
})

describe('buildHermesChatQueryArgs', () => {
  it('passes the prompt immediately after -q so flags are not parsed as the query', () => {
    const prompt = 'STATE: DONE\nRESULT: ok'
    const args = buildHermesChatQueryArgs(prompt)

    expect(args.slice(0, 3)).toEqual(['chat', '-q', prompt])
    expect(args).toContain('-Q')
    expect(args).toContain('--source')
    expect(args[1]).toBe('-q')
    expect(args[2]).toBe(prompt)
    expect(args[3]).toBe('-Q')
  })
})

describe('buildWorkerPrompt', () => {
  const roster = {
    id: 'swarm5',
    name: 'Builder',
    role: 'Primary Builder',
    specialty: 'full-stack implementation across Hermes Workspace and Swarm2',
    model: 'GPT-5.5',
    mission: 'Ship focused product slices with tests and clean diffs.',
    modes: [],
    tools: [],
    skills: ['swarm-ui-worker', 'swarm-worker-core'],
    plugins: [],
    pluginToolsets: [],
    mcpServers: [],
    capabilities: ['code-editing', 'ui-implementation', 'build-verification'],
    preferredTaskTypes: ['implementation'],
    greenlightRequiredFor: [],
    maxConcurrentTasks: 1,
    acceptsBroadcast: true,
    reviewRequired: false,
  }

  it('uses Name — Role as the human-facing label while preserving swarmN as machine ID', () => {
    const prompt = buildWorkerPrompt({
      workerId: 'swarm5',
      task: 'Patch the conductor card copy.',
      rationale: 'Builder executes implementation work.',
      roster,
    })

    expect(prompt).toContain('Worker: Builder — Primary Builder')
    expect(prompt).toContain('Machine ID: swarm5')
    expect(prompt).toContain('Mission: Ship focused product slices with tests and clean diffs.')
    expect(prompt).toContain('Capabilities: code-editing, ui-implementation, build-verification')
    expect(prompt).toContain('Skills: swarm-ui-worker, swarm-worker-core')
  })

  it('still injects role context for direct one-shot dispatch unless raw mode is explicit', () => {
    const prompt = buildWorkerPrompt({
      workerId: 'swarm5',
      task: 'Reply with exactly: BUILDER_OK',
      roster,
      direct: true,
    })

    expect(prompt).toContain('Worker: Builder — Primary Builder')
    expect(prompt).toContain('## Assigned Task')
    expect(prompt).toContain('Reply with exactly: BUILDER_OK')
  })

  it('keeps explicit raw/smoke dispatch unwrapped for minimal probes', () => {
    const prompt = buildWorkerPrompt({
      workerId: 'swarm5',
      task: 'RAW_PING_ONLY',
      roster,
      direct: true,
      raw: true,
    })

    expect(prompt).toBe('RAW_PING_ONLY')
  })
})
describe('classifyHermesTuiPane', () => {
  // Real status lines captured from `hermes chat --tui` in a tmux pane. The agent
  // takes ~50s to start; pasting a task before it is up silently loses the task.
  const shellEcho = `$ HERMES_HOME=/home/workspace/.hermes/profiles/builder /usr/local/bin/hermes chat --tui; status=$?`
  const forging = ` ─ forging session… │  │ voice off                                                    \n ❯ Try "explain this codebase"`
  const starting = ` ─ starting agent… │ qwen3.8 27b dense │ 24s │ voice off │ 1 session\n builder ❯ Try "explain this codebase"`
  const ready = ` ─ ready │ qwen3.8 27b dense │ 0/163.8k │ [░░░░░░░░░░] 0% │ 48s │ voice off │ 1 session\n builder ❯ Try "explain this codebase"`
  const busy = ` ─ thinking… │ qwen3.8 27b dense │ 12.4k/163.8k │ [█░░░░░░░░░] 8% │ 3s │ voice off │ 1 session\n builder ❯ `

  it('is not ready while the shell has only echoed the launch command', () => {
    expect(classifyHermesTuiPane(shellEcho)).toBe('unknown')
    expect(classifyHermesTuiPane('')).toBe('unknown')
  })

  it('reports starting while the agent is still forging/starting, even though the prompt is already drawn', () => {
    expect(classifyHermesTuiPane(forging)).toBe('starting')
    expect(classifyHermesTuiPane(starting)).toBe('starting')
  })

  it('reports ready once the status bar says ready', () => {
    expect(classifyHermesTuiPane(ready)).toBe('ready')
  })

  it('reports busy for a running turn, which is safe to queue a prompt into', () => {
    expect(classifyHermesTuiPane(busy)).toBe('busy')
  })

  it('only looks at the latest status bar, not stale earlier ones in scrollback', () => {
    expect(classifyHermesTuiPane(`${starting}\n${ready}`)).toBe('ready')
  })
})

describe('describeOneshotFailure', () => {
  const command = 'Command failed: hermes chat -q ## Swarm Orchestrator Dispatch ... --source swarm-dispatch'

  it('says the worker timed out and after how long, instead of echoing the command line', () => {
    // execFile reports a SIGTERM-on-timeout as "Command failed: <full command>" with
    // empty stderr, which showed up in the UI as an unexplained BLOCKED worker.
    const text = describeOneshotFailure({ message: command, killed: true, signal: 'SIGTERM', stderr: '', timeoutMs: 240_000 })
    expect(text).toMatch(/timed out after 240s/)
    expect(text).not.toMatch(/Command failed/)
  })

  it('keeps any stderr the worker printed before it was stopped', () => {
    const text = describeOneshotFailure({ message: command, killed: true, signal: 'SIGTERM', stderr: 'session_id: 20260924_005127_52356a', timeoutMs: 600_000 })
    expect(text).toMatch(/timed out after 600s/)
    expect(text).toContain('session_id: 20260924_005127_52356a')
  })

  it('prefers stderr for a real failure', () => {
    expect(describeOneshotFailure({ message: command, killed: false, signal: null, stderr: 'boom: model unreachable', timeoutMs: 240_000 })).toBe('boom: model unreachable')
  })

  it('falls back to the error message when there is no stderr and it was not a timeout', () => {
    expect(describeOneshotFailure({ message: command, killed: false, signal: null, stderr: '  ', timeoutMs: 240_000 })).toBe(command)
  })
})

describe('markCheckpointResult', () => {
  let home: string | null = null
  afterEach(() => {
    vi.unstubAllEnvs()
    if (home) rmSync(home, { recursive: true, force: true })
    home = null
  })

  it('moves a worker out of executing when its checkpoint is DONE, so the Swarm page stops showing it as running', () => {
    home = mkdtempSync(join(tmpdir(), 'swarm-runtime-'))
    vi.stubEnv('HERMES_HOME', home)
    const profile = join(home, 'profiles', 'builder')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'runtime.json'), JSON.stringify({ workerId: 'builder', state: 'executing', phase: 'dispatched', checkpointStatus: 'in_progress', currentTask: 'Conductor mission: x' }))

    markCheckpointResult('builder', {
      stateLabel: 'DONE',
      runtimeState: 'idle',
      checkpointStatus: 'done',
      filesChanged: 'a.txt',
      commandsRun: 'write_file',
      result: 'wrote the file',
      blocker: 'none',
      nextAction: 'none',
      raw: 'STATE: DONE',
    } as never)

    const runtime = JSON.parse(readFileSync(join(profile, 'runtime.json'), 'utf8'))
    expect(runtime.state).toBe('idle')
    expect(runtime.phase).toBe('done')
    expect(runtime.checkpointStatus).toBe('done')
    expect(runtime.currentTask).toBeNull()
    expect(runtime.lastResult).toBe('wrote the file')
  })
})

describe('markDispatchResult', () => {
  let home: string | null = null
  afterEach(() => {
    vi.unstubAllEnvs()
    if (home) rmSync(home, { recursive: true, force: true })
    home = null
  })
  const doneCheckpoint = {
    stateLabel: 'DONE', runtimeState: 'idle', checkpointStatus: 'done', filesChanged: null, commandsRun: null,
    result: 'ok', blocker: null, nextAction: null, raw: 'STATE: DONE',
  } as never
  function setup() {
    home = mkdtempSync(join(tmpdir(), 'swarm-runtime-'))
    vi.stubEnv('HERMES_HOME', home)
    const profile = join(home, 'profiles', 'ops-watch')
    mkdirSync(profile, { recursive: true })
    return join(profile, 'runtime.json')
  }
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

  it('marks a delivered task as executing / in_progress (the task was just handed over)', () => {
    const path = setup()
    markDispatchResult('ops-watch', { workerId: 'ops-watch', ok: true, output: 'delivered', error: null, durationMs: 1, exitCode: 0, delivery: 'tmux' })
    expect(read(path)).toMatchObject({ state: 'executing', checkpointStatus: 'in_progress', lastDispatchMode: 'tmux' })
  })

  it('marks a failed dispatch as blocked', () => {
    const path = setup()
    markDispatchResult('ops-watch', { workerId: 'ops-watch', ok: false, output: '', error: 'boom', durationMs: 1, exitCode: 1, delivery: 'oneshot' })
    expect(read(path)).toMatchObject({ state: 'blocked', checkpointStatus: 'blocked', blockedReason: 'boom' })
  })

  it('does not drag a worker back to executing after its run already produced a DONE checkpoint', () => {
    // Fire-and-forget workers: the exit handler records the checkpoint, then reports the
    // dispatch result. That report used to overwrite the finished state with executing.
    const path = setup()
    markCheckpointResult('ops-watch', doneCheckpoint)
    markDispatchResult('ops-watch', { workerId: 'ops-watch', ok: true, output: 'done', error: null, durationMs: 1, exitCode: 0, delivery: 'oneshot', checkpoint: doneCheckpoint })
    const runtime = read(path)
    expect(runtime.state).toBe('idle')
    expect(runtime.checkpointStatus).toBe('done')
    expect(runtime.lastDispatchMode).toBe('oneshot') // dispatch bookkeeping is still recorded
  })
})

describe('a new dispatch must not inherit the previous task\'s completion', () => {
  let home: string | null = null
  afterEach(() => {
    vi.unstubAllEnvs()
    if (home) rmSync(home, { recursive: true, force: true })
    home = null
  })
  const doneCheckpoint = {
    stateLabel: 'DONE', runtimeState: 'idle', checkpointStatus: 'done', filesChanged: 'a.txt', commandsRun: 'write_file',
    result: 'previous task result', blocker: null, nextAction: null,
    raw: 'STATE: DONE\nFILES_CHANGED: a.txt\nCOMMANDS_RUN: write_file\nRESULT: previous task result\nBLOCKER: none\nNEXT_ACTION: none',
  } as never

  it('clears the previous checkpoint at dispatch start, so the next poll cannot read it as done', () => {
    // Regression: once worker runtime correctly ended as "done" with its checkpointRaw saved,
    // the NEXT mission's first poll parsed that stale raw and completed in 165ms with the old result.
    home = mkdtempSync(join(tmpdir(), 'swarm-runtime-'))
    vi.stubEnv('HERMES_HOME', home)
    const profile = join(home, 'profiles', 'builder')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'runtime.json'), '{}')
    markCheckpointResult('builder', doneCheckpoint)
    expect(checkpointFromRuntimeSnapshot(readRuntimeCheckpointSnapshot(profile))?.stateLabel).toBe('DONE') // the stale state exists

    markDispatchStarted('builder', 'a brand new task', 'mission-2', 'assign-2')

    const snapshot = readRuntimeCheckpointSnapshot(profile)
    expect(snapshot.checkpointRaw).toBeNull()
    const cp = checkpointFromRuntimeSnapshot(snapshot)
    expect(cp === null || cp.stateLabel === 'IN_PROGRESS').toBe(true)
  })

  it('only trusts a runtime checkpoint written after this assignment was dispatched', () => {
    const dispatchedAt = 1_790_344_133_897
    const snap = (lastOutputAt: number | null) => ({ lastOutputAt }) as never
    expect(runtimeCheckpointIsFresh(snap(dispatchedAt - 86_400_000), dispatchedAt)).toBe(false) // yesterday's
    expect(runtimeCheckpointIsFresh(snap(null), dispatchedAt)).toBe(false) // cannot prove fresh
    expect(runtimeCheckpointIsFresh(snap(dispatchedAt + 5_000), dispatchedAt)).toBe(true)
    expect(runtimeCheckpointIsFresh(snap(dispatchedAt), dispatchedAt)).toBe(true)
  })
})
