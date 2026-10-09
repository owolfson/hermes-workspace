import { describe, expect, it } from 'vitest'
import { formatModelName } from './format-model-name'

describe('formatModelName', () => {
  it('shows unmapped ids exactly as the provider names them', () => {
    expect(formatModelName('qwen3.8-27b-dense')).toBe('qwen3.8-27b-dense')
    expect(formatModelName('llm7/gemini-3.8-flash-high')).toBe('gemini-3.8-flash-high')
    expect(formatModelName('local-qwen/qwen3.8-27b-dense')).toBe('qwen3.8-27b-dense')
  })

  it('keeps curated names for mapped ids', () => {
    expect(formatModelName('anthropic/claude-sonnet-4-6')).toBe('Claude Sonnet 4.6')
  })
})
