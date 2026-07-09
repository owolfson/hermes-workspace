/**
 * Tiny server-side stale-while-revalidate memo, shared by the hot tab
 * endpoints (sessions sidebar, skills, jobs) and modeled on the
 * /api/dashboard/overview cache.
 *
 * Why: the upstreams (hermes-agent session listing, hermes-dashboard
 * skills/cron) take 2-12s under load — the dashboard's analytics rollup
 * holds the Python GIL, so every endpoint it serves crawls while one runs.
 * The workspace re-fetched them on every tab switch, which is why "every
 * tab takes a while to load".
 *
 * Semantics (identical to the overview cache):
 *  - In-flight builds are always shared.
 *  - TTL counts from RESOLUTION, not build start.
 *  - Once a key has resolved once, staleness never blocks: stale hits get
 *    the last good value immediately while a rebuild runs in the background.
 *  - Failed rebuilds keep serving the previous good value and retry on the
 *    next request; a failed FIRST build is dropped so the next call retries.
 */

type SwrEntry = {
  resolvedAt: number | null
  promise: Promise<unknown>
  lastGood: unknown
  hasGood: boolean
}

const entries = new Map<string, SwrEntry>()

export async function swrCached<T>(
  key: string,
  ttlMs: number,
  build: () => Promise<T>,
): Promise<T> {
  const now = Date.now()
  let entry = entries.get(key)
  const inFlight = entry !== undefined && entry.resolvedAt === null
  const fresh =
    entry !== undefined &&
    entry.resolvedAt !== null &&
    now - entry.resolvedAt < ttlMs
  if (!entry || (!fresh && !inFlight)) {
    const promise = build()
    const next: SwrEntry = {
      resolvedAt: null,
      promise,
      lastGood: entry?.lastGood,
      hasGood: entry?.hasGood ?? false,
    }
    entries.set(key, next)
    promise.then(
      (result) => {
        next.resolvedAt = Date.now()
        next.lastGood = result
        next.hasGood = true
      },
      () => {
        if (next.hasGood) {
          // Serve the previous good value; mark expired so the next request
          // kicks another rebuild.
          next.resolvedAt = 0
          next.promise = Promise.resolve(next.lastGood)
        } else if (entries.get(key) === next) {
          entries.delete(key)
        }
      },
    )
    entry = next
  }
  if (entry.resolvedAt === null && entry.hasGood) {
    return entry.lastGood as T
  }
  return entry.promise as Promise<T>
}

/** Drop cached value(s) after a mutation so the next read rebuilds. */
export function swrBust(keyPrefix: string): void {
  for (const key of entries.keys()) {
    if (key === keyPrefix || key.startsWith(`${keyPrefix}:`)) {
      entries.delete(key)
    }
  }
}
