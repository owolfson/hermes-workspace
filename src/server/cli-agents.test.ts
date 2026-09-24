import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyAgentProcess, scanCliAgents } from './cli-agents'

describe('classifyAgentProcess', () => {
  it('recognizes a hermes worker launched through its venv python', () => {
    const agent = classifyAgentProcess(['/opt/hermes-cli/bin/python3', '/opt/hermes-cli/bin/hermes', 'chat', '--tui'], {
      HERMES_HOME: '/home/workspace/.hermes/profiles/builder',
    })
    expect(agent).toEqual({ name: 'hermes · builder', task: 'Interactive session (TUI)' })
  })

  it('uses the first line of a one-shot prompt as the task', () => {
    const agent = classifyAgentProcess(['hermes', 'chat', '-q', 'Fix the build\nand run tests', '-Q'], {})
    expect(agent).toEqual({ name: 'hermes', task: 'Fix the build' })
  })

  it('recognizes other agent CLIs by executable name', () => {
    expect(classifyAgentProcess(['/usr/local/bin/claude', '--resume'], {})?.name).toBe('claude')
    expect(classifyAgentProcess(['node', '/usr/lib/node_modules/@openai/codex/bin/codex', 'exec', 'x'], {})?.name).toBe('codex')
  })

  it('ignores unrelated processes and the workspace server itself', () => {
    expect(classifyAgentProcess(['node', '--max-old-space-size=2048', 'server-entry.js'], {})).toBeNull()
    expect(classifyAgentProcess(['tmux', 'new-session', '-s', 'hermes'], {})).toBeNull()
    expect(classifyAgentProcess(['/bin/sh', '-c', 'hermes chat --tui'], {})).toBeNull()
  })

  it('truncates very long tasks', () => {
    const task = classifyAgentProcess(['hermes', 'chat', '-q', 'x'.repeat(500)], {})?.task ?? ''
    expect(task.length).toBeLessThanOrEqual(140)
  })
})

describe('scanCliAgents', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fakeproc-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function addProc(pid: number, argv: Array<string>, env: Record<string, string>, startTicks: number) {
    const dir = join(root, String(pid))
    mkdirSync(dir)
    writeFileSync(join(dir, 'cmdline'), argv.join('\0') + '\0')
    writeFileSync(join(dir, 'environ'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0')
    // /proc/<pid>/stat: pid (comm) state ppid ... field 22 = starttime (in clock ticks), 19 fields after the state
    const fields = ['S', '1', '1', '1', '0', '-1', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '1', '0', '1', String(startTicks)]
    writeFileSync(join(dir, 'stat'), `${pid} (hermes) ${fields.join(' ')} 0 0\n`)
  }

  it('lists running agent processes with their runtime in seconds', () => {
    addProc(101, ['hermes', 'chat', '--tui'], { HERMES_HOME: '/h/profiles/builder' }, 1000)
    addProc(202, ['node', 'server-entry.js'], {}, 500)
    const agents = scanCliAgents({ procRoot: root, bootTimeSec: 10_000, clockTicks: 100, nowSec: 10_060 })
    // started at 10_000 + 1000/100 = 10_010 -> 50s ago
    expect(agents).toEqual([
      { pid: 101, name: 'hermes · builder', task: 'Interactive session (TUI)', runtimeSeconds: 50, status: 'running' },
    ])
  })

  it('skips non-numeric entries and processes that vanish mid-scan', () => {
    mkdirSync(join(root, 'self'))
    mkdirSync(join(root, '303'))
    expect(scanCliAgents({ procRoot: root, bootTimeSec: 0, clockTicks: 100, nowSec: 1 })).toEqual([])
  })
})
