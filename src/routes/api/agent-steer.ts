import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'

// The gateway can steer a run through POST /v1/runs/{run_id}/steer, but that needs a
// gateway run id. This workspace streams chat in portable mode (/v1/responses), where
// the run id is minted locally and the gateway has no run to steer. Say so plainly
// instead of failing with a generic 500.
export const Route = createFileRoute('/api/agent-steer')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
        const message = typeof body.message === 'string' ? body.message.trim() : ''
        if (!message) return json({ ok: false, error: 'message required' }, { status: 400 })

        return json(
          {
            ok: false,
            code: 'steer_unsupported_in_portable_mode',
            error:
              'Steering a running agent is not available in portable chat mode. Stop the run and send your directive as a new message.',
          },
          { status: 501 },
        )
      },
    },
  },
})
