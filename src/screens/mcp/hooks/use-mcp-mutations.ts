import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  McpClientInput,
  McpDiscoveredTool,
  McpServer,
  McpTestResult,
  McpToolMode,
} from '@/types/mcp'

async function postJson<T>(path: string, body: unknown, method: 'POST' | 'PUT' | 'DELETE' = 'POST'): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (method !== 'DELETE') init.body = JSON.stringify(body)
  const res = await fetch(path, init)
  const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string }
  if (!res.ok || (json as { ok?: boolean }).ok === false) {
    throw new Error(json.error || `Request failed (${res.status})`)
  }
  return json
}

export function useTestMcpServer() {
  return useMutation<McpTestResult, Error, { name: string } | McpClientInput>({
    // A failed probe (ok:false, status:'failed', error:'...') is a valid RESULT to
    // show on the card, not an exception — postJson would have thrown on it, which
    // skipped the list refresh and surfaced as an uncaught error. Only responses
    // with no result shape at all (auth failure, gateway error) still throw.
    mutationFn: async (payload) => {
      const res = await fetch('/api/mcp/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = (await res.json().catch(() => null)) as
        | (Partial<McpTestResult> & { error?: string })
        | null
      if (json && typeof json === 'object' && typeof json.status === 'string') {
        return json as McpTestResult
      }
      throw new Error(json?.error || `Request failed (${res.status})`)
    },
  })
}

export function useDiscoverMcpTools() {
  return useMutation<{ ok: boolean; tools: Array<McpDiscoveredTool> }, Error, McpClientInput>({
    mutationFn: (payload) =>
      postJson<{ ok: boolean; tools: Array<McpDiscoveredTool> }>('/api/mcp/discover', payload),
  })
}

export function useUpsertMcpServer() {
  const qc = useQueryClient()
  // Inline `& { bearerToken? }` keeps the secret-bearing shape unexported —
  // no client module re-exports a type containing `bearerToken` or
  // `oauth.clientSecret`. Server-side `parseMcpServerInput` re-validates and
  // strips before persistence.
  return useMutation<
    { ok: boolean; server: McpServer },
    Error,
    McpClientInput & { bearerToken?: string }
  >({
    mutationFn: (payload) =>
      postJson<{ ok: boolean; server: McpServer }>('/api/mcp', payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp', 'servers'] }),
  })
}

export interface ConfigureInput {
  name: string
  enabled?: boolean
  toolMode?: McpToolMode
  includeTools?: Array<string>
  excludeTools?: Array<string>
}

export function useConfigureMcpServer() {
  const qc = useQueryClient()
  return useMutation<{ ok: boolean; server: McpServer }, Error, ConfigureInput>({
    mutationFn: (payload) => postJson<{ ok: boolean; server: McpServer }>('/api/mcp/configure', payload, 'PUT'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp', 'servers'] }),
  })
}

export function useDeleteMcpServer() {
  const qc = useQueryClient()
  return useMutation<{ ok: boolean }, Error, { name: string }>({
    mutationFn: ({ name }) => postJson<{ ok: boolean }>(`/api/mcp/${encodeURIComponent(name)}`, null, 'DELETE'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp', 'servers'] }),
  })
}
