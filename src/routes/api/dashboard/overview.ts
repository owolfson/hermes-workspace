/**
 * GET /api/dashboard/overview
 *
 * Aggregates the data the Workspace dashboard renders:
 *   - gateway status (running, active_agents, restart_requested)
 *   - connected platforms (api_server, telegram, discord, etc.)
 *   - cron summary (total / paused / running / next_run_at)
 *   - achievements (recent unlocks + total unlocked count)
 *   - current model info (provider, model, context length, capabilities)
 *   - analytics rollup (last N days, top models, optional cost)
 *
 * Each section is independent: a single missing endpoint or auth
 * failure leaves that section at `null` and the dashboard hides the
 * card. The aggregation runs server-side so the client makes one
 * request instead of six, and we get a single auth surface.
 */
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  dashboardFetch,
  gatewayFetch,
} from '../../../server/gateway-capabilities'
import {
  buildDashboardOverview,
  type DashboardFetcher,
  type DashboardOverview,
} from '../../../server/dashboard-aggregator'

const overviewFetcher: DashboardFetcher = (path) => dashboardFetch(path)
// Gateway fetcher hits the gateway URL (8645/8642), which is where
// `/health/detailed` lives. The Hermes Agent confirmed `active_agents`
// from this endpoint is the canonical “currently running” count.
const overviewGatewayFetcher: DashboardFetcher = (path) => gatewayFetch(path)

// Server-side memo with in-flight coalescing and stale-while-revalidate.
// The analytics section of the aggregate can take ~40-70s on the
// hermes-dashboard side (SessionDB rollup over thousands of sessions), and
// every open tab refetches every 30s — without this, concurrent requests
// stack aggregations, the dashboard container saturates, and the capability
// probe starts timing out (the UI then degrades to "backend does not support
// the sessions API").
//
// Semantics:
//   - In-flight builds are always shared (never start a second identical one).
//   - TTL counts from RESOLUTION, not build start — the build itself can
//     exceed the TTL, and counting from start would expire every entry
//     before it ever served a hit.
//   - Once a key has resolved once, staleness never blocks: a stale hit is
//     served the last good overview immediately while a rebuild runs in the
//     background. Only the first-ever request for a key (e.g. right after a
//     container restart) waits the full build time.
//   - Failed rebuilds keep serving the previous good overview and retry on
//     the next request; a failed FIRST build is dropped so the next request
//     retries from scratch.
type OverviewCacheEntry = {
  resolvedAt: number | null
  promise: Promise<DashboardOverview>
  lastGood: DashboardOverview | null
}
const overviewCache = new Map<string, OverviewCacheEntry>()
const OVERVIEW_TTL_MS = 30_000

export const Route = createFileRoute('/api/dashboard/overview')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const url = new URL(request.url)
          const days = Number(url.searchParams.get('days') ?? '30')
          const limit = Number(url.searchParams.get('achievements') ?? '3')
          const logsLimit = Number(url.searchParams.get('logs') ?? '24')
          const analyticsWindowDays =
            Number.isFinite(days) && days > 0 ? days : 30
          const achievementsLimit =
            Number.isFinite(limit) && limit > 0 ? Math.min(limit, 12) : 3
          const logsLimitNorm =
            Number.isFinite(logsLimit) && logsLimit > 0
              ? Math.min(logsLimit, 100)
              : 24

          const cacheKey = `${analyticsWindowDays}:${achievementsLimit}:${logsLimitNorm}`
          const now = Date.now()
          let entry = overviewCache.get(cacheKey)
          const inFlight = entry !== undefined && entry.resolvedAt === null
          const fresh =
            entry !== undefined &&
            entry.resolvedAt !== null &&
            now - entry.resolvedAt < OVERVIEW_TTL_MS
          if (!entry || (!fresh && !inFlight)) {
            const promise = buildDashboardOverview({
              fetcher: overviewFetcher,
              gatewayFetcher: overviewGatewayFetcher,
              analyticsWindowDays,
              achievementsLimit,
              logsLimit: logsLimitNorm,
            })
            const next: OverviewCacheEntry = {
              resolvedAt: null,
              promise,
              lastGood: entry?.lastGood ?? null,
            }
            overviewCache.set(cacheKey, next)
            promise.then(
              (result) => {
                next.resolvedAt = Date.now()
                next.lastGood = result
              },
              () => {
                if (next.lastGood !== null) {
                  // Keep serving the previous good overview; mark the entry
                  // expired so the next request kicks another rebuild.
                  next.resolvedAt = 0
                  next.promise = Promise.resolve(next.lastGood)
                } else if (overviewCache.get(cacheKey) === next) {
                  // First-ever build failed — drop it so the next request
                  // retries instead of caching the error.
                  overviewCache.delete(cacheKey)
                }
              },
            )
            entry = next
          }
          // Stale-while-revalidate: if a rebuild is in flight but we already
          // have a good overview, serve it now instead of blocking ~40-70s.
          const overview =
            entry.resolvedAt === null && entry.lastGood !== null
              ? entry.lastGood
              : await entry.promise
          return json(overview, {
            headers: {
              // The aggregate is cheap to recompute (parallel fans-out
              // upstream), but cache for a few seconds so a noisy client
              // doesn't hammer the dashboard. Stale-while-revalidate keeps
              // the UI snappy while fresh data lands.
              'Cache-Control':
                'private, max-age=5, stale-while-revalidate=20',
            },
          })
        } catch (err) {
          return json(
            {
              error:
                err instanceof Error ? err.message : 'overview build failed',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
