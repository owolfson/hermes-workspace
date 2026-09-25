import type { DashboardOverview } from './dashboard-aggregator'

/**
 * The overview aggregate is cached for ~10 minutes because each rebuild costs the
 * dashboard 20-40s of GIL-heavy work. But each section is fetched independently and
 * goes null when its request fails — and right after a workspace restart the
 * dashboard is busy, so /api/model/info (etc.) can time out. A degraded build cached
 * for the full TTL made the dashboard say "Active model: Offline" and "0 skills
 * installed" for ten minutes when nothing was actually wrong.
 *
 * Degraded results therefore live only briefly (long enough to protect the dashboard
 * from a rebuild storm, short enough to self-heal on the client's next few polls).
 */
export function isDegradedOverview(
  overview: Pick<DashboardOverview, 'status' | 'modelInfo' | 'analytics' | 'cron'>,
): boolean {
  return (
    overview.status === null ||
    overview.modelInfo === null ||
    overview.analytics === null ||
    overview.cron === null
  )
}

/** `resolvedAt` to record so the entry stays fresh for ttlMs (healthy) or degradedTtlMs (degraded). */
export function effectiveResolvedAt(
  overview: Pick<DashboardOverview, 'status' | 'modelInfo' | 'analytics' | 'cron'>,
  now: number,
  ttlMs: number,
  degradedTtlMs: number,
): number {
  return isDegradedOverview(overview) ? now - (ttlMs - degradedTtlMs) : now
}
