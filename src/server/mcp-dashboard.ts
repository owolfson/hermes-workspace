/**
 * Adapter for the dashboard's real MCP probe (POST /api/mcp/servers/{name}/test,
 * hermes-dashboard v0.21.1). The workspace's "fallback mode" Test button used to
 * shell out to a bundled `hermes mcp test` CLI whose HERMES_HOME is the workspace's
 * own, so it could never see the agent's servers and always answered
 * `status: unknown, tools: []`. The dashboard runs the probe against the agent's
 * actual config and returns the real tool list.
 */

export type McpTestResult = {
  ok: boolean
  status: 'connected' | 'failed' | 'unknown'
  latencyMs: number | null
  discoveredTools: Array<{ name: string; description: string }>
  error: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function mapDashboardMcpTest(
  httpStatus: number,
  raw: unknown,
  latencyMs: number,
): McpTestResult {
  const body = isRecord(raw) ? raw : {}
  const tools: McpTestResult['discoveredTools'] = []
  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (!isRecord(t) || typeof t.name !== 'string' || !t.name) continue
      tools.push({
        name: t.name,
        description: typeof t.description === 'string' ? t.description : '',
      })
    }
  }
  const ok = httpStatus >= 200 && httpStatus < 300 && body.ok === true
  if (ok) {
    return { ok: true, status: 'connected', latencyMs, discoveredTools: tools, error: null }
  }
  const message =
    (typeof body.error === 'string' && body.error) ||
    (typeof body.detail === 'string' && body.detail) ||
    `MCP test failed (HTTP ${httpStatus})`
  return { ok: false, status: 'failed', latencyMs, discoveredTools: tools, error: message }
}
