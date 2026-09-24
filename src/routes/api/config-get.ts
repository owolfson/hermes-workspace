import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { getCapabilities } from '../../server/gateway-capabilities'
import { readHermesConfigFiles, resolveHermesConfigPaths } from '../../server/hermes-config-store'
import { maskSecrets } from '../../server/mask-secrets'

// Raw Hermes config for the Provider Setup pane, with credentials masked.
export const Route = createFileRoute('/api/config-get')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        if (!getCapabilities().config) {
          return json({ ok: false, error: 'Config API is not available on this gateway' }, { status: 503 })
        }
        try {
          const files = readHermesConfigFiles(resolveHermesConfigPaths())
          return json({ ok: true, payload: maskSecrets(files.config) })
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 })
        }
      },
    },
  },
})
