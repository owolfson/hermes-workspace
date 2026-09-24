export type NetworkUrlSource = 'tailscale' | 'lan' | 'localhost'

function hostname(host: string): string {
  return host.replace(/:\d+$/, '').toLowerCase()
}

function classify(host: string): NetworkUrlSource {
  const h = hostname(host)
  if (h === 'localhost' || h.startsWith('127.') || h === '::1' || h === '[::1]') return 'localhost'
  if (h.endsWith('.ts.net') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return 'tailscale'
  return 'lan'
}

/**
 * The address a phone should open. The workspace runs in a container, so its own
 * interfaces are docker-internal; the Host header is the one address known to work
 * from the user's network.
 */
export function resolveNetworkUrl(input: {
  host: string
  protocol: string
  port?: string | null
  publicUrl?: string | null
}): { url: string; source: NetworkUrlSource } {
  const publicUrl = input.publicUrl?.trim().replace(/\/+$/, '')
  if (publicUrl) return { url: publicUrl, source: classify(new URL(publicUrl).host) }
  const proto = input.protocol.replace(/:$/, '') || 'http'
  const host = /:\d+$/.test(input.host) || !input.port ? input.host : `${input.host}:${input.port}`
  return { url: `${proto}://${host}`, source: classify(input.host) }
}
