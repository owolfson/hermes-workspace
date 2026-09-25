/**
 * Proxy for the dashboard's per-profile skills endpoint.
 *
 *   GET /api/profiles/skills?name=<profile>
 *     → dashboard GET /api/skills?profile=<profile>
 *   (v0.21.1 dashboards have no /api/profiles/<profile>/skills route; that
 *   path 404s. Fixed 2026-09-24 after an audit found it dead.)
 *
 * Pairs with NousResearch/hermes-agent#25116, which lets one dashboard
 * daemon edit `skills.disabled` across every installed profile. Without
 * this proxy the workspace can only manage the dashboard's currently
 * bound profile (whichever HERMES_HOME the daemon launched against),
 * matching the old single-profile constraint.
 *
 * The dashboard returns a lighter payload than `/api/skills` — just
 * `{name, description, category, path, enabled}` per entry, scoped to
 * the profile's own `skills/` directory. The frontend normalizes these
 * entries into the workspace's richer `SkillSummary` shape with safe
 * defaults for fields the dashboard doesn't supply at the profile scope.
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  dashboardFetch,
  ensureGatewayProbed,
} from '../../../server/gateway-capabilities'
import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'
import { toProfileSkillsPayload } from '../../../server/skills-upstream'

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export const Route = createFileRoute('/api/profiles/skills')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        const capabilities = await ensureGatewayProbed()
        if (!capabilities.skills || !capabilities.dashboard.available) {
          return json(
            {
              ...createCapabilityUnavailablePayload('skills'),
              items: [],
            },
            { status: 503 },
          )
        }

        try {
          const url = new URL(request.url)
          const profile = (url.searchParams.get('name') || '').trim()
          if (!profile || !PROFILE_NAME_RE.test(profile)) {
            return json(
              { error: 'A valid profile name is required' },
              { status: 400 },
            )
          }

          // hermes-dashboard v0.21.1 has no /api/profiles/<name>/skills (that route
          // came from an upstream PR this dashboard predates); per-profile skills
          // are GET /api/skills?profile=<name>, a bare list the UI wants as {items}.
          const response = await dashboardFetch(
            `/api/skills?profile=${encodeURIComponent(profile)}`,
            { signal: AbortSignal.timeout(30_000) },
          )
          const body = await response.text()
          if (!response.ok) {
            return json(
              {
                error:
                  body ||
                  `Dashboard profile skills request failed (${response.status})`,
              },
              { status: response.status },
            )
          }

          let parsed: unknown
          try {
            parsed = JSON.parse(body)
          } catch {
            return json(
              { error: 'Dashboard returned malformed JSON for profile skills' },
              { status: 502 },
            )
          }
          return json({ profile, ...toProfileSkillsPayload(parsed) })
        } catch (err) {
          return json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          )
        }
      },
    },
  },
})
