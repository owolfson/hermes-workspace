import { describe, expect, it, vi } from 'vitest'
import { probeReachable } from './hermes-world-reachability'

describe('probeReachable', () => {
  it('is true when the host answers (any response, even an opaque no-cors one)', async () => {
    const fetchImpl = vi.fn(async () => ({ type: 'opaque' }) as unknown as Response)
    await expect(probeReachable('https://play.example/x', { fetchImpl })).resolves.toBe(true)
    // no-cors is what lets a cross-origin host be probed at all, and a network failure still rejects
    expect(fetchImpl).toHaveBeenCalledWith('https://play.example/x', expect.objectContaining({ mode: 'no-cors', cache: 'no-store' }))
  })

  it('is false when the network request fails (host down, no route, DNS)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(probeReachable('https://play.example/x', { fetchImpl })).resolves.toBe(false)
  })

  it('is false when the host never answers within the timeout, and aborts the request', async () => {
    let aborted = false
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    )
    await expect(probeReachable('https://play.example/x', { fetchImpl: fetchImpl as never, timeoutMs: 30 })).resolves.toBe(false)
    expect(aborted).toBe(true)
  })
})
