/**
 * Can the browser reach this host at all? An iframe cannot tell us: when the host is down
 * Chrome renders its own error page INSIDE the frame and that document still fires onLoad,
 * so the embed looked "loaded" while showing a sad-face icon. A no-cors fetch does the job:
 * it resolves (opaque) for any HTTP response and rejects only on a network failure
 * (host down, no route, DNS), which is exactly the distinction we need.
 */
export async function probeReachable(
  url: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const { timeoutMs = 8_000, fetchImpl = fetch } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    await fetchImpl(url, { mode: 'no-cors', cache: 'no-store', signal: controller.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
