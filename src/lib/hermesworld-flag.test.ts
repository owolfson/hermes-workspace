import { describe, expect, it } from 'vitest'
import { isHermesWorldEnabled, withoutHermesWorld } from './hermesworld-flag'

describe('HermesWorld kill switch', () => {
  it('is on unless the flag is exactly "0" (opt-out)', () => {
    expect(isHermesWorldEnabled(undefined)).toBe(true)
    expect(isHermesWorldEnabled('')).toBe(true)
    expect(isHermesWorldEnabled('1')).toBe(true)
    expect(isHermesWorldEnabled('0')).toBe(false)
  })

  const items = [{ id: 'chat' }, { id: 'playground' }, { id: 'files' }]

  it('removes only the HermesWorld entry when disabled, keeping order', () => {
    expect(withoutHermesWorld(items, false).map((i) => i.id)).toEqual(['chat', 'files'])
  })

  it('keeps everything when enabled, without aliasing the input', () => {
    const out = withoutHermesWorld(items, true)
    expect(out.map((i) => i.id)).toEqual(['chat', 'playground', 'files'])
    expect(out).not.toBe(items)
  })
})
