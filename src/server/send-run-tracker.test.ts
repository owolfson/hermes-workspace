import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  abortActiveSendRun,
  hasActiveSendRun,
  registerActiveSendRun,
  unregisterActiveSendRun,
} from './send-run-tracker'

describe('active send runs registry', () => {
  beforeEach(() => {
    unregisterActiveSendRun('r1')
    unregisterActiveSendRun('r2')
  })

  it('tracks registered runs', () => {
    expect(hasActiveSendRun('r1')).toBe(false)
    registerActiveSendRun('r1')
    expect(hasActiveSendRun('r1')).toBe(true)
    unregisterActiveSendRun('r1')
    expect(hasActiveSendRun('r1')).toBe(false)
  })

  it('ignores empty ids', () => {
    registerActiveSendRun('')
    expect(hasActiveSendRun('')).toBe(false)
    expect(hasActiveSendRun(null)).toBe(false)
  })

  it('aborts a registered run through its abort handle, once', () => {
    const abort = vi.fn()
    registerActiveSendRun('r1', abort)
    expect(abortActiveSendRun('r1')).toBe(true)
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('reports false when the run has no abort handle or is unknown', () => {
    registerActiveSendRun('r2')
    expect(abortActiveSendRun('r2')).toBe(false)
    expect(abortActiveSendRun('nope')).toBe(false)
  })

  it('drops the abort handle when the run is unregistered', () => {
    const abort = vi.fn()
    registerActiveSendRun('r1', abort)
    unregisterActiveSendRun('r1')
    expect(abortActiveSendRun('r1')).toBe(false)
    expect(abort).not.toHaveBeenCalled()
  })

  it('does not throw if the abort handle throws', () => {
    registerActiveSendRun('r1', () => {
      throw new Error('already closed')
    })
    expect(abortActiveSendRun('r1')).toBe(true)
  })
})
