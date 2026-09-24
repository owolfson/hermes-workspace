import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { scanCliAgents } from '../../server/cli-agents'

// Agent CLI processes (hermes workers, claude, codex, ...) running in this container.
export const Route = createFileRoute('/api/cli-agents')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        try {
          return json({ ok: true, agents: scanCliAgents() })
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error), agents: [] }, { status: 500 })
        }
      },
    },
  },
})
