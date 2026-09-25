import { describe, expect, it } from 'vitest'
import { evaluateSkillScan, isValidSkillIdentifier, mapHubSearchResults, toProfileSkillsPayload } from '../skills-upstream'

describe('toProfileSkillsPayload', () => {
  // Real shape from hermes-dashboard v0.21.1 GET /api/skills?profile=<name>: a bare list.
  const item = {
    name: 'architecture-diagram',
    description: 'Dark-themed SVG diagram',
    category: '.archived-unused-20260908',
    enabled: false,
    usage: 0,
    provenance: 'bundled',
  }

  it('wraps the dashboard bare list as { items } (what the Skills screen reads)', () => {
    expect(toProfileSkillsPayload([item])).toEqual({ items: [item] })
  })

  it('accepts {skills:[...]} and {items:[...]} envelopes from other dashboard versions', () => {
    expect(toProfileSkillsPayload({ skills: [item] })).toEqual({ items: [item] })
    expect(toProfileSkillsPayload({ items: [item] })).toEqual({ items: [item] })
  })

  it('never throws on garbage and drops non-object entries', () => {
    expect(toProfileSkillsPayload(null)).toEqual({ items: [] })
    expect(toProfileSkillsPayload('<html>')).toEqual({ items: [] })
    expect(toProfileSkillsPayload([item, null, 7, 'x'])).toEqual({ items: [item] })
  })
})

describe('mapHubSearchResults', () => {
  // Real shape from GET /api/skills/hub/search?q=github (skills.sh index).
  const raw = {
    results: [
      {
        name: 'github',
        description: 'Indexed by skills.sh from openclaw/openclaw',
        source: 'skills.sh',
        identifier: 'skills-sh/openclaw/openclaw/github',
        trust_level: 'community',
        repo: 'openclaw/openclaw',
        tags: [],
      },
    ],
  }

  it('maps hub results onto the fields the Skills UI renders', () => {
    const out = mapHubSearchResults(raw, new Set())
    expect(out).toEqual([
      {
        id: 'skills-sh/openclaw/openclaw/github',
        name: 'github',
        description: 'Indexed by skills.sh from openclaw/openclaw',
        author: 'openclaw',
        category: '',
        tags: [],
        source: 'skills.sh',
        trust: 'community',
        installCommand: 'hermes skills install skills-sh/openclaw/openclaw/github',
        installed: false,
      },
    ])
  })

  it('flags already-installed skills by name', () => {
    expect(mapHubSearchResults(raw, new Set(['github']))[0].installed).toBe(true)
  })

  it('accepts a bare array and skips entries with no name or identifier', () => {
    expect(mapHubSearchResults(raw.results, new Set())).toHaveLength(1)
    expect(mapHubSearchResults({ results: [{ description: 'x' }, null] }, new Set())).toEqual([])
    expect(mapHubSearchResults('nope', new Set())).toEqual([])
  })

  it('coerces tags to strings and tolerates a missing repo', () => {
    const out = mapHubSearchResults(
      { results: [{ name: 'a', identifier: 'a', tags: ['x', 3], source: 's' }] },
      new Set(),
    )
    expect(out[0].tags).toEqual(['x', '3'])
    expect(out[0].author).toBe('')
  })
})

describe('evaluateSkillScan (install gate — fail closed)', () => {
  // Real shape from GET /api/skills/hub/scan?identifier=skills-sh/openclaw/openclaw/github
  const clean = {
    name: 'github',
    identifier: 'skills-sh/openclaw/openclaw/github',
    trust_level: 'community',
    verdict: 'safe',
    summary: 'github: clean scan, no threats detected',
    policy: 'allow',
    policy_reason: 'Allowed (community source, safe verdict)',
    findings: [],
    severity_counts: { critical: 0, high: 0, medium: 0, low: 0 },
  }

  it('allows a clean scan whose policy is allow', () => {
    expect(evaluateSkillScan(clean)).toMatchObject({ allow: true, verdict: 'safe' })
  })

  it('blocks when policy is anything but allow, and explains why', () => {
    const r = evaluateSkillScan({ ...clean, verdict: 'caution', policy: 'block', policy_reason: 'Blocked (community source, caution verdict)' })
    expect(r.allow).toBe(false)
    expect(r.reason).toContain('caution')
    expect(r.reason).toContain('Blocked')
  })

  it('blocks on high/critical findings even if policy says allow (belt and braces)', () => {
    expect(evaluateSkillScan({ ...clean, severity_counts: { critical: 0, high: 1, medium: 0, low: 0 } }).allow).toBe(false)
    expect(evaluateSkillScan({ ...clean, severity_counts: { critical: 2, high: 0, medium: 0, low: 0 } }).allow).toBe(false)
  })

  it('fails closed on missing, malformed or unrelated scan output', () => {
    for (const bad of [null, undefined, 'oops', 42, [], {}, { policy: 'allowed-ish' }, { detail: 'not found' }]) {
      const r = evaluateSkillScan(bad)
      expect(r.allow).toBe(false)
      expect(r.reason.length).toBeGreaterThan(0)
    }
  })
})

describe('isValidSkillIdentifier', () => {
  it('accepts real hub identifiers and plain names', () => {
    expect(isValidSkillIdentifier('skills-sh/openclaw/openclaw/github')).toBe(true)
    expect(isValidSkillIdentifier('browse-sh/github.com/get-pr-review-st0euo')).toBe(true)
    expect(isValidSkillIdentifier('github')).toBe(true)
  })
  it('rejects empty, oversized, whitespace, traversal and shell metacharacters', () => {
    for (const bad of ['', ' ', 'a b', '../etc/passwd', 'a;rm -rf /', 'x$(id)', 'a|b', '`id`', 'x'.repeat(400), null, 5]) {
      expect(isValidSkillIdentifier(bad as unknown)).toBe(false)
    }
  })
})
