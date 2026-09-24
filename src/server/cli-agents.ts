import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type CliAgent = {
  pid: number
  name: string
  task: string
  runtimeSeconds: number
  status: 'running' | 'finished'
}

const AGENT_EXECUTABLES = new Set(['hermes', 'claude', 'codex', 'gemini', 'aider', 'opencode'])
const MAX_TASK_CHARS = 140

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

/** Name/task for an agent CLI process, or null when argv is not one. */
export function classifyAgentProcess(
  argv: Array<string>,
  env: Record<string, string>,
): { name: string; task: string } | null {
  // The agent binary is argv[0], or argv[1] when launched through an interpreter
  // (python venv script, node). Shells that merely contain the word are ignored.
  const candidates = argv.slice(0, 2).map(basename)
  const executable = candidates.find((c) => AGENT_EXECUTABLES.has(c))
  if (!executable) return null
  if (candidates[0] === 'sh' || candidates[0] === 'bash') return null

  let name: string = executable
  const home = env.HERMES_HOME ?? ''
  const worker = home.match(/\/profiles\/([^/]+)\/?$/)?.[1]
  if (executable === 'hermes' && worker) name = `hermes · ${worker}`

  const q = argv.findIndex((arg) => arg === '-q' || arg === '--query')
  let task = 'No task description'
  if (q >= 0 && argv[q + 1]) task = argv[q + 1].split('\n')[0].trim().slice(0, MAX_TASK_CHARS)
  else if (argv.includes('--tui')) task = 'Interactive session (TUI)'
  return { name, task: task || 'No task description' }
}

function readNul(path: string): Array<string> {
  return readFileSync(path, 'utf8').split('\0').filter(Boolean)
}

function readEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {}
  try {
    for (const entry of readNul(path)) {
      const eq = entry.indexOf('=')
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
  } catch {
    // Other users' processes are not readable; the name just loses its worker id.
  }
  return env
}

function startTicks(statPath: string): number | null {
  const stat = readFileSync(statPath, 'utf8')
  // comm may contain spaces/parens: fields after the LAST ')' start at field 3 (state).
  const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const ticks = Number(rest[19]) // field 22 (starttime) is index 19 counting from field 3
  return Number.isFinite(ticks) ? ticks : null
}

export function scanCliAgents(input: {
  procRoot?: string
  bootTimeSec?: number
  clockTicks?: number
  nowSec?: number
} = {}): Array<CliAgent> {
  const procRoot = input.procRoot ?? '/proc'
  const clockTicks = input.clockTicks ?? 100
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000)
  let bootTimeSec = input.bootTimeSec
  if (bootTimeSec === undefined) {
    try {
      const btime = readFileSync(join(procRoot, 'stat'), 'utf8').match(/^btime\s+(\d+)/m)
      bootTimeSec = btime ? Number(btime[1]) : nowSec
    } catch {
      bootTimeSec = nowSec
    }
  }

  const agents: Array<CliAgent> = []
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue
    const dir = join(procRoot, entry)
    try {
      const argv = readNul(join(dir, 'cmdline'))
      const found = classifyAgentProcess(argv, readEnv(join(dir, 'environ')))
      if (!found) continue
      const ticks = startTicks(join(dir, 'stat'))
      const runtimeSeconds = ticks === null ? 0 : Math.max(0, nowSec - (bootTimeSec + Math.floor(ticks / clockTicks)))
      agents.push({ pid: Number(entry), ...found, runtimeSeconds, status: 'running' })
    } catch {
      // Process exited while we were reading it.
    }
  }
  return agents.sort((a, b) => a.runtimeSeconds - b.runtimeSeconds)
}
