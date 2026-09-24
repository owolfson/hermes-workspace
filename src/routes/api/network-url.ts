import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { resolveNetworkUrl } from '../../server/network-url'

// The address to open from a phone (QR code in the mobile setup modal).
export const Route = createFileRoute('/api/network-url')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        const url = new URL(request.url)
        const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host
        const protocol = request.headers.get('x-forwarded-proto') ?? url.protocol
        return json(
          resolveNetworkUrl({
            host,
            protocol,
            port: url.searchParams.get('port'),
            publicUrl: process.env.HERMES_WORKSPACE_PUBLIC_URL,
          }),
        )
      },
    },
  },
})
