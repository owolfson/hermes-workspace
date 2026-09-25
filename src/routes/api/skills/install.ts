import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  BEARER_TOKEN,
  CLAUDE_API,
  dashboardFetch,
  ensureGatewayProbed,
} from '../../../server/gateway-capabilities'
import {
  evaluateSkillScan,
  isValidSkillIdentifier,
} from '../../../server/skills-upstream'
import { waitForDashboardAction } from '../../../server/dashboard-actions'
import { swrBust } from '../../../server/swr-cache'

function authHeaders(): Record<string, string> {
  return BEARER_TOKEN ? { Authorization: `Bearer ${BEARER_TOKEN}` } : {}
}

export const Route = createFileRoute('/api/skills/install')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const body = (await request.json()) as {
            skillId?: string
            identifier?: string
            category?: string
            force?: boolean
          }
          const identifier =
            (body.identifier || body.skillId || '').trim()
          if (!identifier) {
            return json(
              { ok: false, error: 'identifier or skillId required' },
              { status: 400 },
            )
          }

          const capabilities = await ensureGatewayProbed()
          if (capabilities.dashboard.available) {
            // Real install via the dashboard's skills hub, behind its security scan.
            // `force` from the client is intentionally ignored: a community skill
            // becomes instructions for an agent with host-wide access, so a scan
            // that doesn't explicitly allow it (or can't run) is a hard stop.
            if (!isValidSkillIdentifier(identifier)) {
              return json(
                { ok: false, error: 'Invalid skill identifier.' },
                { status: 400 },
              )
            }
            let decision = evaluateSkillScan(null)
            try {
              const scanRes = await dashboardFetch(
                `/api/skills/hub/scan?identifier=${encodeURIComponent(identifier)}`,
                { signal: AbortSignal.timeout(120_000) },
              )
              decision = evaluateSkillScan(
                scanRes.ok ? await scanRes.json().catch(() => null) : null,
              )
            } catch {
              // decision stays fail-closed
            }
            if (!decision.allow) {
              return json(
                { ok: false, error: decision.reason, verdict: decision.verdict },
                { status: 403 },
              )
            }
            const installRes = await dashboardFetch('/api/skills/hub/install', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ identifier }),
              signal: AbortSignal.timeout(120_000),
            })
            const installBody = (await installRes.json().catch(() => ({}))) as Record<
              string,
              unknown
            >
            if (!installRes.ok) {
              const detail = installBody.detail ?? installBody.error
              return json(
                {
                  ok: false,
                  error:
                    typeof detail === 'string' && detail
                      ? detail
                      : `Install failed (HTTP ${installRes.status})`,
                },
                { status: installRes.status },
              )
            }
            // The dashboard install is asynchronous (fetch + quarantine + its own
            // security scan, ~1-2 min): wait for it, and only then invalidate the
            // list cache and report — otherwise the UI announces success before
            // anything is installed and can never see a failure.
            const actionName =
              typeof installBody.name === 'string' ? installBody.name : ''
            if (!actionName) {
              swrBust('skills')
              return json({
                ...installBody,
                ok: installBody.ok !== false,
                scan: { verdict: decision.verdict, reason: decision.reason },
              })
            }
            const outcome = await waitForDashboardAction(actionName, {
              expect: 'Installed',
            })
            swrBust('skills')
            if (outcome.state === 'done') {
              return json({
                ok: true,
                message: outcome.message,
                scan: { verdict: decision.verdict, reason: decision.reason },
              })
            }
            return json(
              {
                ok: false,
                error: outcome.timedOut
                  ? 'Still installing after 4 minutes — it may finish in the background; refresh the skills list shortly.'
                  : `Install failed: ${outcome.message}`,
              },
              { status: outcome.timedOut ? 504 : 500 },
            )
          }

          const response = await fetch(`${CLAUDE_API}/api/skills/install`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...authHeaders(),
            },
            body: JSON.stringify({
              identifier,
              category: body.category || '',
              force: Boolean(body.force),
            }),
            signal: AbortSignal.timeout(120_000),
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
                  : 'Failed to install skill',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
