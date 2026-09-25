import { describe, expect, it } from 'vitest'
import { mapDashboardMcpTest } from '../mcp-dashboard'

// Real shapes from hermes-dashboard v0.21.1 POST /api/mcp/servers/{name}/test
// (captured live 2026-09-24 against the exchange/ogai/runpod servers).
describe('mapDashboardMcpTest', () => {
  it('maps a successful probe to connected + discovered tools', () => {
    const raw = {
      ok: true,
      tools: [
        { name: 'hl_account_state', description: 'Get Hyperliquid perp account', schema_chars: 212 },
        { name: 'hl_spot_balance', description: 'Get spot balances', schema_chars: 177 },
      ],
      prompts: 0,
      resources: 0,
    }
    expect(mapDashboardMcpTest(200, raw, 412)).toEqual({
      ok: true,
      status: 'connected',
      latencyMs: 412,
      discoveredTools: [
        { name: 'hl_account_state', description: 'Get Hyperliquid perp account' },
        { name: 'hl_spot_balance', description: 'Get spot balances' },
      ],
      error: null,
    })
  })

  it('maps ok:false to failed and surfaces the server error text', () => {
    const raw = { ok: false, error: 'Server returned an error response', tools: [] }
    expect(mapDashboardMcpTest(200, raw, 90)).toEqual({
      ok: false,
      status: 'failed',
      latencyMs: 90,
      discoveredTools: [],
      error: 'Server returned an error response',
    })
  })

  it('maps a 404 {detail} (unknown server) to failed with the detail as the error', () => {
    expect(mapDashboardMcpTest(404, { detail: "Server 'x' not found" }, 5)).toMatchObject({
      ok: false,
      status: 'failed',
      error: "Server 'x' not found",
    })
  })

  it('never throws on garbage; reports failed with a generic error', () => {
    for (const bad of [null, undefined, 'oops', 42, []]) {
      const r = mapDashboardMcpTest(500, bad, 1)
      expect(r.ok).toBe(false)
      expect(r.status).toBe('failed')
      expect(r.discoveredTools).toEqual([])
      expect(typeof r.error).toBe('string')
    }
  })

  it('tolerates tools with missing fields and skips unnamed ones', () => {
    const r = mapDashboardMcpTest(200, { ok: true, tools: [{ name: 'a' }, { description: 'no name' }, null] }, 1)
    expect(r.discoveredTools).toEqual([{ name: 'a', description: '' }])
    expect(r.status).toBe('connected')
  })
})
