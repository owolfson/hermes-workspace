import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  BEARER_TOKEN,
  CLAUDE_API,
  dashboardFetch,
  ensureGatewayProbed,
} from '../../../server/gateway-capabilities'
import { isValidSkillIdentifier } from '../../../server/skills-upstream'
import { waitForDashboardAction } from '../../../server/dashboard-actions'
import { swrBust } from '../../../server/swr-cache'

function authHeaders(): Record<string, string> {
  return BEARER_TOKEN ? { Authorization: `Bearer ${BEARER_TOKEN}` } : {}
}

export const Route = createFileRoute('/api/skills/uninstall')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const body = (await request.json()) as {
            skillId?: string
            name?: string
          }
          const name = (body.name || body.skillId || '').trim()
          if (!name) {
            return json(
              { ok: false, error: 'name or skillId required' },
              { status: 400 },
            )
          }

          const capabilities = await ensureGatewayProbed()
          if (capabilities.dashboard.available) {
            if (!isValidSkillIdentifier(name)) {
              return json(
                { ok: false, error: 'Invalid skill name.' },
                { status: 400 },
              )
            }
            const res = await dashboardFetch('/api/skills/hub/uninstall', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name }),
              signal: AbortSignal.timeout(60_000),
            })
            const resBody = (await res.json().catch(() => ({}))) as Record<
              string,
              unknown
            >
            if (!res.ok) {
              const detail = resBody.detail ?? resBody.error
              return json(
                {
                  ok: false,
                  error:
                    typeof detail === 'string' && detail
                      ? detail
                      : `Uninstall failed (HTTP ${res.status})`,
                },
                { status: res.status },
              )
            }
            // Asynchronous on the dashboard too (fast, but not instant): wait, then
            // invalidate the list cache so the UI refresh reflects reality.
            const actionName = typeof resBody.name === 'string' ? resBody.name : ''
            if (!actionName) {
              swrBust('skills')
              return json({ ...resBody, ok: resBody.ok !== false })
            }
            const outcome = await waitForDashboardAction(actionName, {
              timeoutMs: 60_000,
              expect: 'Uninstalled',
            })
            swrBust('skills')
            if (outcome.state === 'done') {
              return json({ ok: true, message: outcome.message })
            }
            return json(
              {
                ok: false,
                error: outcome.timedOut
                  ? 'Still uninstalling after 60 seconds — refresh the skills list shortly.'
                  : `Uninstall failed: ${outcome.message}`,
              },
              { status: outcome.timedOut ? 504 : 500 },
            )
          }

          const response = await fetch(`${CLAUDE_API}/api/skills/uninstall`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...authHeaders(),
            },
            body: JSON.stringify({ name }),
            signal: AbortSignal.timeout(30_000),
          })

          const result = await response.json()
          return json(result, { status: response.status })
        } catch (error) {
          return json(
            {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to uninstall skill',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
