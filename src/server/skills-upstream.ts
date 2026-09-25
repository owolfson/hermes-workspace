/**
 * Adapters between the dashboard's skills API (hermes-dashboard v0.21.1) and the
 * shapes the workspace UI was written against. The UI predates these endpoints:
 * it expects `{ items }` for per-profile skills and its own SkillSearchResult for
 * hub search, while the dashboard returns a bare list and skills.sh index rows.
 */

export type SkillSearchResult = {
  id: string
  name: string
  description: string
  author: string
  category: string
  tags: Array<string>
  source: string
  trust: string
  installCommand: string
  installed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function listFrom(raw: unknown, keys: Array<string>): Array<unknown> {
  if (Array.isArray(raw)) return raw
  if (isRecord(raw)) {
    for (const key of keys) {
      if (Array.isArray(raw[key])) return raw[key] as Array<unknown>
    }
  }
  return []
}

/** GET /api/skills?profile=<name> (bare list) -> `{ items }` for the Skills screen. */
export function toProfileSkillsPayload(raw: unknown): {
  items: Array<Record<string, unknown>>
} {
  return { items: listFrom(raw, ['items', 'skills']).filter(isRecord) }
}

/** GET /api/skills/hub/search rows -> the UI's SkillSearchResult[]. */
export function mapHubSearchResults(
  raw: unknown,
  installedNames: ReadonlySet<string>,
): Array<SkillSearchResult> {
  const out: Array<SkillSearchResult> = []
  for (const row of listFrom(raw, ['results', 'items']).filter(isRecord)) {
    const name = text(row.name)
    const identifier = text(row.identifier) || name
    if (!name && !identifier) continue
    const repo = text(row.repo)
    out.push({
      id: identifier,
      name: name || identifier,
      description: text(row.description),
      author: repo.includes('/') ? repo.split('/')[0] : '',
      category: '',
      tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
      source: text(row.source),
      trust: text(row.trust_level),
      installCommand: `hermes skills install ${identifier}`,
      installed: installedNames.has(name),
    })
  }
  return out
}

/** Hub identifiers / installed skill names: path-ish tokens only, no whitespace or shell metacharacters. */
const SKILL_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._@:/+-]{0,255}$/

export function isValidSkillIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SKILL_IDENTIFIER_RE.test(value) &&
    !value.includes('..')
  )
}

export type SkillScanDecision = {
  allow: boolean
  verdict: string
  reason: string
}

/**
 * Install gate over GET /api/skills/hub/scan. Community skills become
 * instructions for an agent with host-wide access, so this fails CLOSED: anything
 * other than an explicit `policy: "allow"` with no high/critical findings (including
 * a missing, malformed or unrelated scan result) refuses the install.
 */
export function evaluateSkillScan(raw: unknown): SkillScanDecision {
  if (!isRecord(raw) || typeof raw.policy !== 'string') {
    return {
      allow: false,
      verdict: 'unknown',
      reason: 'Security scan result was unavailable, so the skill was not installed.',
    }
  }
  const verdict = text(raw.verdict) || 'unknown'
  const why = text(raw.policy_reason) || text(raw.summary)
  const counts = isRecord(raw.severity_counts) ? raw.severity_counts : {}
  const severe = Number(counts.critical ?? 0) + Number(counts.high ?? 0)
  if (raw.policy !== 'allow') {
    return {
      allow: false,
      verdict,
      reason: `Blocked by security scan (${verdict}): ${why || 'policy did not allow this skill'}`,
    }
  }
  if (severe > 0) {
    return {
      allow: false,
      verdict,
      reason: `Blocked by security scan: ${severe} high/critical finding${severe === 1 ? '' : 's'}.`,
    }
  }
  return { allow: true, verdict, reason: why }
}
