import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { scanCliAgents } from '../../server/cli-agents'

// The UI posts with no body, so JSON content-type CSRF protection does not apply;
// require any Origin header to match the host instead.
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).host === (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? new URL(request.url).host)
  } catch {
    return false
  }
}

export const Route = createFileRoute('/api/cli-agents/$pid/kill')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        if (!sameOrigin(request)) return json({ ok: false, error: 'Cross-origin request rejected' }, { status: 403 })

        const pid = Number(params.pid)
        if (!Number.isInteger(pid) || pid <= 1) return json({ ok: false, error: 'Invalid pid' }, { status: 400 })

        // Only ever signal a process the scanner itself reports as an agent CLI.
        if (!scanCliAgents().some((agent) => agent.pid === pid)) {
          return json({ ok: false, error: 'No such agent process' }, { status: 404 })
        }
        try {
          process.kill(pid, 'SIGTERM')
          return json({ ok: true, pid })
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 })
        }
      },
    },
  },
})
