import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { getHermesRoot } from './claude-paths'

const SCRIPT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_SCRIPT_BYTES = 64 * 1024
const REDACTED = '«redacted»'

// Identifier fragments that mark an assignment's value as secret.
const SECRET_IDENT = '[A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|credential)[A-Za-z0-9_.-]*'

// Provider-shaped tokens are masked wherever they appear, not just in assignments.
const TOKEN_SHAPES = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /0x[a-fA-F0-9]{64}\b/g,
]
const BEARER_LITERAL = /(Bearer\s+)(?![$({])[A-Za-z0-9._~+/=-]{20,}/g
// NAME = "value" / NAME: "value" — the identifier must NOT sit inside a string
// literal (lookbehind), else `startswith("X_TOKEN=")` reads as an assignment
// and the closing quote of the literal gets mistaken for the value's opening.
const QUOTED_ASSIGN = new RegExp(
  `((?<!["'])\\b${SECRET_IDENT}\\s*[:=]\\s*)(["'])([^"'\\n]{12,})\\2`,
  'gi',
)
// "name": "value" / 'name': 'value' — quoted key, colon only (dict / JSON)
const QUOTED_KEY_ASSIGN = new RegExp(
  `((["'])${SECRET_IDENT}\\2\\s*:\\s*)(["'])([^"'\\n]{12,})\\3`,
  'gi',
)
// export NAME=value (unquoted shell), skipping $VAR / $(cmd) / quoted forms
const SHELL_ASSIGN = new RegExp(
  `(\\b${SECRET_IDENT}=)(?![$("'])([^\\s#;&|]{12,})`,
  'gi',
)

/** Mask secret-shaped literals; returns the text and how many were masked. */
function redactWithCount(text: string): { text: string; count: number } {
  let count = 0
  const bump = () => {
    count += 1
    return REDACTED
  }
  let out = text
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, bump)
  out = out.replace(BEARER_LITERAL, (_m, pre: string) => pre + bump())
  out = out.replace(
    QUOTED_ASSIGN,
    (_m, pre: string, quote: string) => `${pre}${quote}${bump()}${quote}`,
  )
  out = out.replace(
    QUOTED_KEY_ASSIGN,
    (_m, pre: string, _q: string, quote: string) =>
      `${pre}${quote}${bump()}${quote}`,
  )
  out = out.replace(SHELL_ASSIGN, (_m, pre: string) => pre + bump())
  return { text: out, count }
}

export function redactSecrets(text: string): string {
  return redactWithCount(text).text
}

export type JobScript = {
  name: string
  content: string
  size: number
  truncated: boolean
  redactions: number
}

export type JobScriptResult =
  | { ok: true; script: JobScript }
  | {
      ok: false
      reason: 'invalid-name' | 'not-found' | 'not-a-file' | 'unreadable'
      name: string
    }

/**
 * Where the agent's job scripts live, as seen from this container. The agent's
 * $HERMES_HOME/scripts (/opt/data/scripts on hermes-agent) is reachable here
 * only through a host bind mount, so a split-container deploy sets
 * HERMES_AGENT_SCRIPTS_DIR; co-located installs fall back to our own home.
 */
export function resolveScriptsDir(): string {
  const fromEnv = process.env.HERMES_AGENT_SCRIPTS_DIR?.trim()
  return fromEnv || join(getHermesRoot(), 'scripts')
}

/**
 * Read a cron job's script by the name the job declares. Only a bare file
 * name is accepted (no separators, no traversal), the read is size-capped, and
 * secret-shaped literals are masked before anything leaves the server.
 */
export function readJobScript(
  scriptField: unknown,
  dir: string = resolveScriptsDir(),
): JobScriptResult {
  const name = typeof scriptField === 'string' ? scriptField.trim() : ''
  if (!SCRIPT_NAME_RE.test(name) || name.includes('..')) {
    return { ok: false, reason: 'invalid-name', name: name || String(scriptField) }
  }

  let fd: number
  try {
    fd = openSync(join(dir, name), 'r')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return {
      ok: false,
      reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'unreadable',
      name,
    }
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return { ok: false, reason: 'not-a-file', name }
    const length = Math.min(stat.size, MAX_SCRIPT_BYTES)
    const buf = Buffer.alloc(length)
    const read = length > 0 ? readSync(fd, buf, 0, length, 0) : 0
    const { text, count } = redactWithCount(buf.subarray(0, read).toString('utf8'))
    return {
      ok: true,
      script: {
        name,
        content: text,
        size: stat.size,
        truncated: stat.size > MAX_SCRIPT_BYTES,
        redactions: count,
      },
    }
  } catch {
    return { ok: false, reason: 'unreadable', name }
  } finally {
    closeSync(fd)
  }
}
