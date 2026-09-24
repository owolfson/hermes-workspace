import { describe, expect, it } from 'vitest'
import { resolveNetworkUrl } from './network-url'

describe('resolveNetworkUrl', () => {
  it('uses the host the browser actually reached us on, with its scheme', () => {
    expect(resolveNetworkUrl({ host: '192.168.1.10:8443', protocol: 'https' })).toEqual({
      url: 'https://192.168.1.10:8443',
      source: 'lan',
    })
  })

  it('classifies tailscale addresses and .ts.net names', () => {
    expect(resolveNetworkUrl({ host: '100.101.2.3:3000', protocol: 'http' }).source).toBe('tailscale')
    expect(resolveNetworkUrl({ host: 'box.tail1234.ts.net', protocol: 'https' }).source).toBe('tailscale')
  })

  it('classifies private ranges as lan and loopback as localhost', () => {
    expect(resolveNetworkUrl({ host: '10.0.0.5:3000', protocol: 'http' }).source).toBe('lan')
    expect(resolveNetworkUrl({ host: '172.20.1.1', protocol: 'http' }).source).toBe('lan')
    expect(resolveNetworkUrl({ host: 'localhost:3000', protocol: 'http' }).source).toBe('localhost')
    expect(resolveNetworkUrl({ host: '127.0.0.1:3000', protocol: 'http' }).source).toBe('localhost')
  })

  it('falls back to the requested port when the host header has none', () => {
    expect(resolveNetworkUrl({ host: '192.168.1.10', protocol: 'http', port: '3000' }).url).toBe('http://192.168.1.10:3000')
  })

  it('prefers a configured public url', () => {
    expect(resolveNetworkUrl({ host: 'localhost:3000', protocol: 'http', publicUrl: 'https://hermes.example.com/' })).toEqual({
      url: 'https://hermes.example.com',
      source: 'lan',
    })
  })
})
