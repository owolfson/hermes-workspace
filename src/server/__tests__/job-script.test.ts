import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJobScript, redactSecrets } from '../job-script'

// Synthetic, real-shaped values — the actual key that motivated this lives in
// morning_briefing.py (GATEWAY_KEY = "sk-or-v1-<64 hex>") and must never be
// copied into a test.
const FAKE_OR_KEY = `sk-or-v1-${'a1b2c3d4'.repeat(8)}`

describe('redactSecrets', () => {
  it('masks a quoted key assigned to a KEY-named variable, keeping the name', () => {
    const out = redactSecrets(`GATEWAY_KEY = "${FAKE_OR_KEY}"`)
    expect(out).not.toContain(FAKE_OR_KEY)
    expect(out).toContain('GATEWAY_KEY')
  })

  it('masks provider-shaped tokens wherever they appear', () => {
    const line = `curl -H "x: ${FAKE_OR_KEY}" https://example.test`
    expect(redactSecrets(line)).not.toContain(FAKE_OR_KEY)
    const gh = 'ghp_' + 'A'.repeat(36)
    expect(redactSecrets(`echo ${gh}`)).not.toContain(gh)
    const slack = 'xoxb-' + '1'.repeat(12) + '-abcdefghij'
    expect(redactSecrets(`t=${slack}`)).not.toContain(slack)
  })

  it('masks Bearer literals but not Bearer variables', () => {
    const lit = 'Bearer ' + 'z'.repeat(32)
    expect(redactSecrets(`Authorization: ${lit}`)).not.toContain('z'.repeat(32))
    expect(redactSecrets('Authorization: Bearer $TOKEN')).toContain('$TOKEN')
  })

  it('masks python dict style "api_key": "value"', () => {
    const out = redactSecrets(`{"api_key": "abcdefghijklmnop1234"}`)
    expect(out).not.toContain('abcdefghijklmnop1234')
    expect(out).toContain('api_key')
  })

  it('masks unquoted shell assignments but leaves $VAR / $(cmd) references alone', () => {
    expect(redactSecrets('export API_TOKEN=abcdefghijklmnop1234')).not.toContain(
      'abcdefghijklmnop1234',
    )
    expect(redactSecrets('API_TOKEN=$OTHER_TOKEN')).toBe('API_TOKEN=$OTHER_TOKEN')
    expect(redactSecrets('API_TOKEN=$(cat /run/secrets/t)')).toBe(
      'API_TOKEN=$(cat /run/secrets/t)',
    )
  })

  it('masks 64-hex private-key shapes', () => {
    const pk = '0x' + 'ab'.repeat(32)
    expect(redactSecrets(`PK="${pk}"`)).not.toContain(pk)
  })

  it('does not mangle code that merely mentions a secret-named string literal', () => {
    // Real shape from morning_briefing.py: the identifier sits INSIDE a string
    // literal, so the "=" and next quote are code, not an assignment.
    const src = `if ln.startswith("TELEGRAM_BOT_TOKEN="): tok = ln.split("=", 1)[1]`
    expect(redactSecrets(src)).toBe(src)
    const src2 = `env.get("API_KEY_NAME") == "something-quite-long-here"`
    expect(redactSecrets(src2)).toBe(src2)
  })

  it('leaves ordinary script text and public 40-hex addresses untouched', () => {
    const addr = '0x' + 'ab'.repeat(20)
    const src = [
      '#!/bin/bash',
      'TIMEOUT = 30',
      `ADDR = "${addr}"`,
      'curl -s http://hermes-agent:8642/health',
      'if key == "some-long-literal-string": pass',
    ].join('\n')
    expect(redactSecrets(src)).toBe(src)
  })
})

describe('readJobScript', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'job-script-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns redacted content, size, and a redaction count', () => {
    writeFileSync(join(dir, 'brief.py'), `GATEWAY_KEY = "${FAKE_OR_KEY}"\nprint("hi")\n`)
    const res = readJobScript('brief.py', dir)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.script.name).toBe('brief.py')
    expect(res.script.content).not.toContain(FAKE_OR_KEY)
    expect(res.script.content).toContain('print("hi")')
    expect(res.script.redactions).toBeGreaterThan(0)
  })

  it('rejects path traversal and non-string names without touching the fs', () => {
    for (const bad of ['../etc/passwd', '/etc/passwd', 'a/b.sh', '', '..', null, 42]) {
      const res = readJobScript(bad as unknown, dir)
      expect(res).toEqual({ ok: false, reason: 'invalid-name', name: expect.anything() })
    }
  })

  it('accepts a path-ish script field by basename only when it is a plain file name', () => {
    writeFileSync(join(dir, 'x.sh'), 'echo ok\n')
    expect(readJobScript('x.sh', dir).ok).toBe(true)
  })

  it('reports not-found and unreadable distinctly', () => {
    expect(readJobScript('missing.sh', dir)).toMatchObject({ ok: false, reason: 'not-found' })
    if (process.getuid && process.getuid() === 0) return // root can read 000 files
    writeFileSync(join(dir, 'locked.sh'), 'echo secret\n')
    chmodSync(join(dir, 'locked.sh'), 0o000)
    expect(readJobScript('locked.sh', dir)).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('truncates very large scripts and says so', () => {
    writeFileSync(join(dir, 'big.py'), 'x = 1\n'.repeat(40_000))
    const res = readJobScript('big.py', dir)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.script.truncated).toBe(true)
    expect(res.script.content.length).toBeLessThanOrEqual(64 * 1024)
  })
})
