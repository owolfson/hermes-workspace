import { describe, expect, it } from 'vitest'
import { interpretActionStatus } from '../dashboard-actions'

// Real shapes captured from hermes-dashboard v0.21.1 GET /api/actions/{name}/status
// while installing/uninstalling a hub skill on 2026-09-25.
const running = {
  name: 'skills-install-browse-sh-github-com-get-pr-review-st0euo-2cb3f444',
  running: true,
  exit_code: null,
  pid: 37462,
  lines: ['', '=== skills-install-... started 2026-09-25 04:28:12 ===', '', 'Fetching: browse-sh/github.com/get-pr-review-st0euo'],
}
const installed = {
  ...running,
  running: false,
  exit_code: 0,
  lines: [
    '', '=== started ===', '', 'Fetching: browse-sh/github.com/get-pr-review-st0euo',
    'Quarantined to .hub/quarantine/get-pr-review', 'Running security scan...',
    'Verdict: SAFE', 'Decision: ALLOWED — Allowed (community source, safe verdict)',
    'Installed: get-pr-review', 'Files: SKILL.md',
  ],
}

describe('interpretActionStatus', () => {
  it('reports running while the process is alive', () => {
    expect(interpretActionStatus(running).state).toBe('running')
  })

  it('reports done on exit 0 and surfaces the "Installed:" summary line', () => {
    expect(interpretActionStatus(installed)).toEqual({ state: 'done', message: 'Installed: get-pr-review' })
  })

  it('surfaces "Uninstalled ..." for uninstall runs', () => {
    const r = interpretActionStatus({
      ...installed,
      lines: ['', '=== started ===', "Uninstalled 'get-pr-review' from get-pr-review"],
    })
    expect(r).toEqual({ state: 'done', message: "Uninstalled 'get-pr-review' from get-pr-review" })
  })

  it('reports failed on a non-zero exit and includes the tail of the output as the reason', () => {
    const r = interpretActionStatus({
      ...running,
      running: false,
      exit_code: 2,
      lines: ['Fetching: x', 'Running security scan...', 'Verdict: DANGEROUS', 'Decision: BLOCKED — policy'],
    })
    expect(r.state).toBe('failed')
    expect(r.message).toContain('BLOCKED')
  })

  it('treats a finished process with no exit code as failed (never as success)', () => {
    expect(interpretActionStatus({ ...running, running: false, exit_code: null }).state).toBe('failed')
  })

  it('reports unknown for garbage instead of throwing', () => {
    for (const bad of [null, undefined, 'x', 3, [], {}]) {
      expect(interpretActionStatus(bad).state).toBe('unknown')
    }
  })

  // Real capture 2026-09-25: uninstalling with a hub IDENTIFIER (which is not an
  // installed skill name) exits 0 and prints only "(may be a builtin)" — the CLI
  // did nothing. Reporting that as success is a silent false-positive.
  it('does NOT count an exit-0 no-op as a successful uninstall when the summary is expected', () => {
    const noop = { ...running, running: false, exit_code: 0, lines: ['', '=== started ===', '(may be a builtin)'] }
    expect(interpretActionStatus(noop).state).toBe('done') // default: legacy behaviour
    const r = interpretActionStatus(noop, { expect: 'Uninstalled' })
    expect(r.state).toBe('failed')
    expect(r.message).toContain('Nothing was uninstalled')
    expect(r.message).toContain('(may be a builtin)')
  })

  it('still counts a real uninstall as done when the summary is expected', () => {
    const ok = { ...running, running: false, exit_code: 0, lines: ["Uninstalled 'get-pr-review' from get-pr-review"] }
    expect(interpretActionStatus(ok, { expect: 'Uninstalled' })).toEqual({
      state: 'done',
      message: "Uninstalled 'get-pr-review' from get-pr-review",
    })
  })
})
