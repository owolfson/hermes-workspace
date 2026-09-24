import { describe, expect, it } from 'vitest'
import { maskSecrets } from './mask-secrets'

describe('maskSecrets', () => {
  it('masks credential-looking keys at any depth and keeps the last 4 chars', () => {
    const masked = maskSecrets({
      model: { default: 'qwen3.8-27b-dense', api_key: 'key-abcdefghijklmnop' },
      providers: { local: { api_key: 'Example_Local_Api_Token', base_url: 'http://x' } },
      list: [{ token: 'abcdef123456' }],
      auth: { password: 'hunter2hunter2', Authorization: 'Bearer abcdef123456' },
    }) as Record<string, any>
    expect(masked.model.default).toBe('qwen3.8-27b-dense')
    expect(masked.model.api_key).toBe('••••mnop')
    expect(masked.providers.local.api_key).toBe('••••oken')
    expect(masked.providers.local.base_url).toBe('http://x')
    expect(masked.list[0].token).toBe('••••3456')
    expect(masked.auth.password).toBe('••••ter2')
    expect(masked.auth.Authorization).toBe('••••3456')
  })

  it('fully masks short secrets and leaves empty ones empty', () => {
    const masked = maskSecrets({ api_key: 'abc', token: '', secret: 'abcdefgh' }) as Record<string, string>
    expect(masked.api_key).toBe('••••')
    expect(masked.token).toBe('')
    expect(masked.secret).toBe('••••')
  })

  it('does not mask non-secret keys that merely contain similar words, or non-strings', () => {
    const masked = maskSecrets({ max_tokens: 4096, tokens_used: 12, api_key_env: 'OPENAI_API_KEY', keyboard: 'x' }) as Record<string, unknown>
    expect(masked.max_tokens).toBe(4096)
    expect(masked.tokens_used).toBe(12)
    expect(masked.api_key_env).toBe('OPENAI_API_KEY')
    expect(masked.keyboard).toBe('x')
  })

  it('does not mutate its input', () => {
    const input = { api_key: 'abcdefghijkl' }
    maskSecrets(input)
    expect(input.api_key).toBe('abcdefghijkl')
  })
})
