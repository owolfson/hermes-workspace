/**
 * Jobs API proxy — forwards to Hermes Agent FastAPI /api/jobs
 */
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  BEARER_TOKEN,
  CLAUDE_API,
  CLAUDE_UPGRADE_INSTRUCTIONS,
  dashboardFetch,
  ensureGatewayProbed,
} from '../../server/gateway-capabilities'
import {
  createProfileCronJob,
  lastRunSuccess,
  listProfileCronJobs,
} from '../../server/hermes-cron-profiles'
import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'
import { swrBust, swrCached } from '../../server/swr-cache'

function authHeaders(): Record<string, string> {
  return BEARER_TOKEN ? { Authorization: `Bearer ${BEARER_TOKEN}` } : {}
}

/**
 * Normalise the jobs response so callers always receive `{ jobs: [...] }`.
 *
 * Some Hermes gateway versions return a bare array instead of the expected
 * `{ jobs: [] }` envelope. This helper wraps bare arrays so the workspace UI
 * never has to special-case both shapes.
 */
async function jobsResponse(res: Response): Promise<Response> {
  const text = await res.text()
  if (!res.ok) {
    return new Response(text, {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const data = JSON.parse(text) as unknown
    const normalized = Array.isArray(data) ? { jobs: data } : data
    return new Response(JSON.stringify(normalized), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch {
    return new Response(text, {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

/**
 * Aggregate cron jobs across sources. The operator's real Hermes cron lives
 * in the AGENT (/opt/data/cron), surfaced via the dashboard's /api/cron/jobs
 * — NOT in the workspace's local profile dirs. In a split-container deploy
 * listProfileCronJobs() is therefore empty, so merge in the gateway/dashboard
 * cron jobs too.
 */
async function buildAggregateJobs(): Promise<Array<Record<string, unknown>>> {
  const localJobs = listProfileCronJobs()
  let gatewayJobs: Array<Record<string, unknown>> = []
  try {
    const caps = await ensureGatewayProbed()
    if (caps.jobs && caps.dashboard.available) {
      const res = await dashboardFetch('/api/cron/jobs')
      if (res.ok) {
        const data = (await res.json()) as unknown
        const arr = Array.isArray(data)
          ? data
          : ((data as { jobs?: unknown })?.jobs ?? [])
        if (Array.isArray(arr)) {
          // The dashboard's raw job dicts carry last_status ("ok" / "failed" /
          // "blocked_config" / ...), not the last_run_success boolean the
          // ClaudeJob type (and the Jobs tab's status badge) expects — that
          // mapping only ever ran inside listProfileCronJobs() for the local
          // (non-dashboard) profile path, which real operator jobs never hit
          // in a split-container deploy. Without it every job showed "Last
          // run unknown" regardless of whether it actually succeeded.
          gatewayJobs = (arr as Array<Record<string, unknown>>).map((job) => ({
            ...job,
            last_run_success: lastRunSuccess(job),
          }))
        }
      }
    }
  } catch {
    // best-effort — fall back to local-only on any gateway error
  }
  const keyOf = (j: Record<string, unknown>): string =>
    String((j.id as string) ?? (j.name as string) ?? '')
  const seen = new Set(gatewayJobs.map(keyOf))
  return [
    ...gatewayJobs,
    ...localJobs.filter(
      (j) => !seen.has(keyOf(j as unknown as Record<string, unknown>)),
    ),
  ]
}

export const Route = createFileRoute('/api/claude-jobs')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
          })
        }
        const url = new URL(request.url)
        const aggregateProfiles = url.searchParams.get('profiles') !== 'active'
        if (aggregateProfiles) {
          // The dashboard's /api/cron/jobs can take 5-12s while its analytics
          // rollup holds the GIL — cache the aggregate (SWR) so the Jobs tab
          // opens instantly.
          const mergedJobs = await swrCached(
            'claude-jobs:aggregate',
            20_000,
            () => buildAggregateJobs(),
          )
          return new Response(JSON.stringify({ jobs: mergedJobs }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        const capabilities = await ensureGatewayProbed()
        if (!capabilities.jobs) {
          return new Response(
            JSON.stringify({
              ...createCapabilityUnavailablePayload('jobs'),
              items: [],
              jobs: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const params = url.searchParams.toString()
        const res = capabilities.dashboard.available
          ? await dashboardFetch(`/api/cron/jobs${params ? `?${params}` : ''}`)
          : await fetch(`${CLAUDE_API}/api/jobs${params ? `?${params}` : ''}`, {
              headers: authHeaders(),
            })
        return jobsResponse(res)
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
          })
        }
        const body = await request.text()
        let parsedBody: Record<string, unknown> = {}
        try {
          parsedBody = body ? (JSON.parse(body) as Record<string, unknown>) : {}
        } catch {
          return new Response(
            JSON.stringify({ ok: false, error: 'Invalid JSON body' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const profile =
          typeof parsedBody.profile === 'string' && parsedBody.profile.trim()
            ? parsedBody.profile.trim()
            : null
        if (profile) {
          try {
            const result = createProfileCronJob(profile, parsedBody)
            swrBust('claude-jobs')
            return new Response(JSON.stringify(result), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          } catch (error) {
            return new Response(
              JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
              { status: 400, headers: { 'Content-Type': 'application/json' } },
            )
          }
        }
        const capabilities = await ensureGatewayProbed()
        if (!capabilities.jobs) {
          return new Response(
            JSON.stringify({
              ...createCapabilityUnavailablePayload('jobs', {
                error: `Gateway does not support /api/jobs. ${CLAUDE_UPGRADE_INSTRUCTIONS}`,
              }),
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const res = capabilities.dashboard.available
          ? await dashboardFetch('/api/cron/jobs', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
            })
          : await fetch(`${CLAUDE_API}/api/jobs`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders() },
              body,
            })
        if (res.ok) swrBust('claude-jobs')
        return new Response(await res.text(), {
          status: res.status,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
  },
})
