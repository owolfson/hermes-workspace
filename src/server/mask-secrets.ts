// Redact credentials from a config tree before it is sent to the browser.
// A key is treated as secret when it ends in api_key / token / secret / password /
// authorization (so max_tokens and api_key_env, which are not credentials, survive).
const SECRET_KEY = /(^|[_-])(api[_-]?key|token|secret|password|passwd|authorization)$/i

function maskValue(value: string): string {
  if (!value) return ''
  return value.length > 8 ? `••••${value.slice(-4)}` : '••••'
}

export function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = typeof entry === 'string' && SECRET_KEY.test(key) ? maskValue(entry) : maskSecrets(entry)
    }
    return out
  }
  return value
}
