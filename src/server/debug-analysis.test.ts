import { describe, expect, it } from 'vitest'
import { buildDebugMessages, parseDebugAnalysis, resolveLlmEndpoint } from './debug-analysis'

describe('resolveLlmEndpoint', () => {
  const config = {
    model: 'qwen3.8-27b-dense',
    provider: 'local-qwen',
    providers: {
      'local-qwen': { api: 'http://llm-router:8083/v1', api_key: 'local', default_model: 'qwen3.8-27b-dense' },
      'hermes-gateway': { api: 'http://agent-gateway:8642/v1', api_key: 'tok' },
    },
  }

  it('uses the active provider from the config, with its key and model', () => {
    expect(resolveLlmEndpoint(config)).toEqual({
      baseUrl: 'http://llm-router:8083/v1',
      apiKey: 'local',
      model: 'qwen3.8-27b-dense',
    })
  })

  it('reads the model from a model block and falls back to the provider default', () => {
    expect(resolveLlmEndpoint({ ...config, model: { default: 'other' } })?.model).toBe('other')
    expect(resolveLlmEndpoint({ ...config, model: undefined })?.model).toBe('qwen3.8-27b-dense')
  })

  it('returns null when no usable provider is configured', () => {
    expect(resolveLlmEndpoint({})).toBeNull()
    expect(resolveLlmEndpoint({ provider: 'x', providers: {} })).toBeNull()
  })
})

describe('buildDebugMessages', () => {
  it('keeps only the tail of very long terminal output', () => {
    const messages = buildDebugMessages('A'.repeat(10_000) + 'THE-END')
    const user = messages[messages.length - 1].content
    expect(user).toContain('THE-END')
    expect(user.length).toBeLessThan(7_000)
  })
})

describe('parseDebugAnalysis', () => {
  const valid = {
    summary: 'Build failed',
    rootCause: 'Missing dependency',
    suggestedCommands: [{ command: 'npm install', description: 'Install deps' }],
  }

  it('parses a plain JSON object', () => {
    expect(parseDebugAnalysis(JSON.stringify(valid))).toEqual(valid)
  })

  it('extracts JSON wrapped in prose or a code fence', () => {
    expect(parseDebugAnalysis('Sure!\n```json\n' + JSON.stringify(valid) + '\n```\nHope that helps')).toEqual(valid)
  })

  it('drops malformed commands and caps the list', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ command: `cmd${i}`, description: `d${i}` }))
    const parsed = parseDebugAnalysis(JSON.stringify({ ...valid, suggestedCommands: [{ command: 'x' }, 'nope', ...many] }))
    expect(parsed?.suggestedCommands).toHaveLength(5)
    expect(parsed?.suggestedCommands[0]).toEqual({ command: 'cmd0', description: 'd0' })
  })

  it('returns null when summary or root cause is missing, or nothing parses', () => {
    expect(parseDebugAnalysis(JSON.stringify({ summary: 'x' }))).toBeNull()
    expect(parseDebugAnalysis('no json here')).toBeNull()
    expect(parseDebugAnalysis('{broken')).toBeNull()
  })
})
