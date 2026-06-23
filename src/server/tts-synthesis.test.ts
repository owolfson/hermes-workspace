import { describe, expect, test } from 'vitest'
import {
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
})

describe('concatWav', () => {
  test('concatenates PCM payloads of multiple WAVs', () => {
    const a = makeWav([1, 2, 3])
    const b = makeWav([4, 5])
    const out = concatWav([a, b])
    expect(wavSamples(out)).toEqual([1, 2, 3, 4, 5])
  })

  test('rewrites RIFF and data sizes to match merged payload', () => {
    const out = concatWav([makeWav([1, 2, 3]), makeWav([4, 5])])
    expect(out.readUInt32LE(40)).toBe(5 * 2) // data size
    expect(out.readUInt32LE(4)).toBe(36 + 5 * 2) // RIFF size
  })

  test('returns the single buffer unchanged when given one', () => {
    const a = makeWav([1, 2, 3])
    expect(concatWav([a]).equals(a)).toBe(true)
  })
})

describe('trimTrailingSilence', () => {
  test('drops trailing near-zero samples', () => {
    const loud = [12000, -12000, 12000]
    const silence = new Array(5000).fill(0)
    const wav = makeWav([...loud, ...silence])
    const trimmed = trimTrailingSilence(wav)
    // Keeps the loud part; trailing silence largely removed.
    expect(wavSamples(trimmed).length).toBeLessThan(loud.length + silence.length)
    expect(wavSamples(trimmed).length).toBeGreaterThanOrEqual(loud.length)
  })

  test('leaves audio without trailing silence intact', () => {
    const wav = makeWav([10000, -10000, 10000, -10000])
    expect(wavSamples(trimTrailingSilence(wav)).length).toBe(4)
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
      exaggeration: 0.5,
      cfg_weight: 0.3,
      temperature: 0.8,
    })
  })

  test('uses the configured voice for the local provider', () => {
    const t = resolveTtsTarget({ tts: { provider: 'local', voice: 'claude' } }, {}, {})
    expect(t.ok && t.voice).toBe('claude')
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
