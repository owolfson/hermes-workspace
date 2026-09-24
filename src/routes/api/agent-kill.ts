import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { stopSessionRuns } from '../../server/agent-run-control'

export const Route = createFileRoute('/api/agent-kill')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
        const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
        if (!sessionKey) return json({ ok: false, error: 'sessionKey required' }, { status: 400 })

        try {
          const result = await stopSessionRuns(sessionKey)
          if (result.stopped === 0) {
            return json({ ok: false, error: 'No active run found for this session' }, { status: 404 })
          }
          return json({ ok: true, ...result })
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 })
        }
      },
    },
  },
})
