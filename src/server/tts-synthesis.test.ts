import { describe, expect, test } from 'vitest'
import {
  buildSpeechPayload,
  chunkSpeechText,
  cleanSpeechText,
  concatWav,
  resolveTtsTarget,
  trimTrailingSilence,
} from './tts-synthesis'

// ── Build a minimal 16-bit mono PCM WAV for tests ──────────────────────────
function makeWav(samples: number[], sampleRate = 24000): Buffer {
  const dataBytes = samples.length * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // fmt chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], 44 + i * 2)
  }
  return buf
}

function wavSamples(buf: Buffer): number[] {
  const dataSize = buf.readUInt32LE(40)
  const out: number[] = []
  for (let i = 0; i < dataSize / 2; i++) out.push(buf.readInt16LE(44 + i * 2))
  return out
}

describe('cleanSpeechText', () => {
  test('strips fenced code blocks', () => {
    expect(cleanSpeechText('Hello\n```js\nconst x = 1\n```\nbye')).toBe(
      'Hello bye',
    )
  })

  test('strips markdown emphasis and headers, keeps words', () => {
    expect(cleanSpeechText('# Title\n**bold** and _italic_ text')).toBe(
      'Title bold and italic text',
    )
  })

  test('reduces markdown links to their label', () => {
    expect(cleanSpeechText('see [the docs](https://example.com) now')).toBe(
      'see the docs now',
    )
  })

  test('drops bare URLs', () => {
    expect(cleanSpeechText('go to https://example.com/path today')).toBe(
      'go to today',
    )
  })

  test('collapses whitespace', () => {
    expect(cleanSpeechText('a\n\n  b   c')).toBe('a b c')
  })
})

describe('chunkSpeechText', () => {
  test('keeps short text as a single chunk', () => {
    expect(chunkSpeechText('Hello there.')).toEqual(['Hello there.'])
  })

  test('splits on sentence boundaries when over the limit', () => {
    const a = 'A'.repeat(200) + '.'
    const b = 'B'.repeat(200) + '.'
    expect(chunkSpeechText(`${a} ${b}`, 300)).toEqual([a, b])
  })

  test('merges a sub-25-char chunk into the previous chunk', () => {
    const a = 'A'.repeat(200) + '.'
    const tiny = 'Ok.'
    expect(chunkSpeechText(`${a} ${tiny}`, 300)).toEqual([`${a} ${tiny}`])
  })

  test('returns empty array for empty input', () => {
    expect(chunkSpeechText('   ')).toEqual([])
  })

  test('never opens with a tiny chunk (chatterbox garbles them)', () => {
    const long = 'L'.repeat(150) + '.'
    expect(chunkSpeechText(`Got it. ${long}`)).toEqual([`Got it. ${long}`])
  })

  test('cuts text into evenly sized ~100-char chunks', () => {
    const s = (c: string) => c.repeat(49) + '.'
    const [a, b, c, d, e, f, g, h] = 'ABCDEFGH'.split('').map(s)
    expect(chunkSpeechText([a, b, c, d, e, f, g, h].join(' '))).toEqual([
      `${a} ${b}`,
      `${c} ${d}`,
      `${e} ${f}`,
      `${g} ${h}`,
    ])
  })

  test('splits an over-long sentence at clause breaks', () => {
    const x = 'X'.repeat(50) + ','
    const y = 'Y'.repeat(50) + ','
    const z = 'Z'.repeat(50) + '.'
    expect(chunkSpeechText(`${x} ${y} ${z}`)).toEqual([`${x} ${y}`, z])
  })

  test('word-splits a clause longer than the limit', () => {
    const words = Array.from({ length: 40 }, () => 'word').join(' ') + '.'
    const chunks = chunkSpeechText(words)
    expect(chunks.length).toBe(2)
    expect(chunks.every((c) => c.length <= 130)).toBe(true)
    expect(chunks.join(' ')).toBe(words)
  })
})

describe('resolveTtsTarget', () => {
  test('defaults to the local speaches backend with proven params', () => {
    const t = resolveTtsTarget({ tts: { provider: 'local' } }, {}, {})
    expect(t.ok).toBe(true)
    if (!t.ok) return
    expect(t.provider).toBe('local')
    expect(t.baseUrl).toBe('http://192.168.1.187:5126/v1')
    expect(t.model).toBe('chatterbox-turbo')
    expect(t.voice).toBe('anushri')
    expect(t.params).toEqual({
      temperature: 0.8,
      top_p: 0.95,
      top_k: 600,
      rep_penalty: 1.2,
      speed: 1,
    })
  })

  test('uses the configured voice for the local provider', () => {
    const t = resolveTtsTarget({ tts: { provider: 'local', voice: 'claude' } }, {}, {})
    expect(t.ok && t.voice).toBe('claude')
  })

  test('reads chatterbox turbo knobs and pace from config when present', () => {
    const t = resolveTtsTarget(
      {
        tts: {
          provider: 'local',
          temperature: 1.1,
          top_p: 0.8,
          top_k: 300,
          rep_penalty: 1.5,
          speed: 1.25,
        },
      },
      {},
      {},
    )
    expect(t.ok && t.params).toEqual({
      temperature: 1.1,
      top_p: 0.8,
      top_k: 300,
      rep_penalty: 1.5,
      speed: 1.25,
    })
  })

  test('config knobs override env, env overrides defaults', () => {
    const t = resolveTtsTarget(
      { tts: { provider: 'local', temperature: 0.9 } },
      { TTS_TOP_P: '0.85', TTS_TOP_K: '400', TTS_REP_PENALTY: '1.3', TTS_SPEED: '0.9' },
      {},
    )
    expect(t.ok && t.params).toEqual({
      temperature: 0.9, // from config
      top_p: 0.85, // from env
      top_k: 400, // from env
      rep_penalty: 1.3, // from env
      speed: 0.9, // from env
    })
  })

  test('clamps pace to the 0.5x-2x range', () => {
    const fast = resolveTtsTarget({ tts: { provider: 'local', speed: 5 } }, {}, {})
    const slow = resolveTtsTarget({ tts: { provider: 'kokoro', speed: 0.1 } }, {}, {})
    expect(fast.ok && fast.params.speed).toBe(2)
    expect(slow.ok && slow.params.speed).toBe(0.5)
  })

  test('kokoro honours the configured pace', () => {
    const t = resolveTtsTarget({ tts: { provider: 'kokoro', speed: 1.3 } }, {}, {})
    expect(t.ok && t.params.speed).toBe(1.3)
  })

  test('reads a configured local model override', () => {
    const t = resolveTtsTarget(
      { tts: { provider: 'local', model: 'chatterbox' } },
      {},
      {},
    )
    expect(t.ok && t.model).toBe('chatterbox')
  })

  test('lets env override the local base url', () => {
    const t = resolveTtsTarget(
      { tts: { provider: 'local' } },
      { TTS_LOCAL_BASE_URL: 'http://other:9000/v1' },
      {},
    )
    expect(t.ok && t.baseUrl).toBe('http://other:9000/v1')
  })

  test('treats missing provider as local (so output works out of the box)', () => {
    const t = resolveTtsTarget({}, {}, {})
    expect(t.ok && t.provider).toBe('local')
  })

  test('openai provider requires an api key', () => {
    const t = resolveTtsTarget({ tts: { provider: 'openai' } }, {}, {})
    expect(t.ok).toBe(false)
  })

  test('openai provider resolves with a key from env', () => {
    const t = resolveTtsTarget(
      { tts: { provider: 'openai', openai: { voice: 'nova' } } },
      { OPENAI_API_KEY: 'sk-test' },
      {},
    )
    expect(t.ok).toBe(true)
    if (!t.ok) return
    expect(t.provider).toBe('openai')
    expect(t.voice).toBe('nova')
    expect(t.apiKey).toBe('sk-test')
    expect(t.baseUrl).toBe('https://api.openai.com/v1')
  })
})

describe('buildSpeechPayload', () => {
  const local = resolveTtsTarget(
    {
      tts: {
        provider: 'local',
        temperature: 0.7,
        top_p: 0.9,
        top_k: 250,
        rep_penalty: 1.4,
        speed: 1.2,
      },
    },
    {},
    {},
  )

  test('local sends every chatterbox turbo knob plus pace', () => {
    if (!local.ok) throw new Error('expected ok')
    expect(buildSpeechPayload(local, 'Hello there.', 'tiffany')).toEqual({
      model: 'chatterbox-turbo',
      input: 'Hello there.',
      voice: 'tiffany',
      response_format: 'wav',
      temperature: 0.7,
      top_p: 0.9,
      top_k: 250,
      rep_penalty: 1.4,
      speed: 1.2,
    })
  })

  test('local never sends knobs turbo ignores', () => {
    if (!local.ok) throw new Error('expected ok')
    const p = buildSpeechPayload(local, 'Hi.', 'tiffany')
    expect(p).not.toHaveProperty('exaggeration')
    expect(p).not.toHaveProperty('cfg_weight')
  })

  test('kokoro sends pace only', () => {
    const k = resolveTtsTarget({ tts: { provider: 'kokoro', speed: 1.4 } }, {}, {})
    if (!k.ok) throw new Error('expected ok')
    expect(buildSpeechPayload(k, 'Hi.', 'zuri')).toEqual({
      model: 'kokoro',
      input: 'Hi.',
      voice: 'zuri',
      response_format: 'wav',
      speed: 1.4,
    })
  })

  test('openai omits speed at the default pace', () => {
    const o = resolveTtsTarget({ tts: { provider: 'openai' } }, { OPENAI_API_KEY: 'k' }, {})
    if (!o.ok) throw new Error('expected ok')
    expect(buildSpeechPayload(o, 'Hi.', 'nova')).not.toHaveProperty('speed')
  })
})
