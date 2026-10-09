import { describe, expect, test } from 'vitest'
import {
  DEFAULT_SYNTH_MODEL,
  initialBufferWait,
  speechWeight,
  type ChunkProgress,
} from './tts-schedule'

const M = DEFAULT_SYNTH_MODEL
const synth = (chars: number, speed = 1) =>
  speed * (M.overheadSec + M.secPerChar * chars)

// Owen's reply from 2026-10-08: a short opening sentence, then longer ones.
const OWEN = [31, 111, 90, 108, 125, 124, 75, 105, 29]

function firstReady(lens: number[], speed = 1): ChunkProgress[] {
  return lens.map((chars, i) =>
    i === 0 ? { chars, startedAt: 0, readyAt: synth(chars, speed) } : { chars },
  )
}

// Plays a reply the way the player does: the producer synthesises chunks back
// to back, the consumer waits `initialBufferWait` (re-checked every 0.25s)
// before chunk 0, then plays in order. Returns the silences between chunks.
function simulate(lens: number[], speed = 1, maxWaitSec = 10) {
  const ready: number[] = []
  let t = 0
  for (const chars of lens) {
    t += synth(chars, speed)
    ready.push(t)
  }
  let now = ready[0]
  const started = now
  for (;;) {
    const progress: ChunkProgress[] = lens.map((chars, i) => {
      const startedAt = i === 0 ? 0 : ready[i - 1]
      if (ready[i] <= now) {
        return { chars, startedAt, readyAt: ready[i], audioSec: chars * M.audioSecPerChar }
      }
      return startedAt <= now ? { chars, startedAt } : { chars }
    })
    const wait = initialBufferWait(progress, now)
    if (wait <= 0 || now - started >= maxWaitSec) break
    now += Math.min(wait, 0.25)
  }
  const gaps: number[] = []
  let playEnd = now + lens[0] * M.audioSecPerChar
  for (let i = 1; i < lens.length; i++) {
    const start = Math.max(playEnd, ready[i])
    gaps.push(start - playEnd)
    playEnd = start + lens[i] * M.audioSecPerChar
  }
  return { firstAudio: now, gaps }
}

describe('initialBufferWait', () => {
  test('a single chunk plays immediately', () => {
    expect(initialBufferWait([{ chars: 80, startedAt: 0, readyAt: 4 }], 4)).toBe(0)
  })

  test('nothing to wait for once every chunk is ready', () => {
    const all = [40, 120].map((chars, i) => ({
      chars,
      startedAt: i * 3,
      readyAt: i * 3 + 3,
      audioSec: chars * M.audioSecPerChar,
    }))
    expect(initialBufferWait(all, 6)).toBe(0)
  })

  test('short opening chunk before a long one: buffers instead of pausing after it', () => {
    const chunks = firstReady(OWEN)
    const wait = initialBufferWait(chunks, chunks[0].readyAt!)
    // chunk 1 needs ~6.5s of synthesis but chunk 0 only plays ~2.1s
    expect(wait).toBeGreaterThan(4)
    expect(wait).toBeLessThan(7)
  })

  test('a long opening chunk starts right away', () => {
    const chunks = firstReady([125, 90, 80])
    expect(initialBufferWait(chunks, chunks[0].readyAt!)).toBe(0)
  })

  test('a server running slower than the model waits longer', () => {
    const normal = firstReady(OWEN)
    const slow = firstReady(OWEN, 1.6)
    expect(initialBufferWait(slow, slow[0].readyAt!)).toBeGreaterThan(
      initialBufferWait(normal, normal[0].readyAt!) + 2,
    )
  })

  test('real audio durations override the per-character estimate', () => {
    const base: ChunkProgress[] = [
      { chars: 60, startedAt: 0, readyAt: 3.8 },
      { chars: 110, startedAt: 3.8 },
    ]
    const shortAudio = initialBufferWait(
      [{ ...base[0], audioSec: 2 }, base[1]],
      3.8,
    )
    const longAudio = initialBufferWait(
      [{ ...base[0], audioSec: 9 }, base[1]],
      3.8,
    )
    expect(shortAudio).toBeGreaterThan(0)
    expect(longAudio).toBe(0)
  })
})

describe('playback with the buffer (simulated against the measured model)', () => {
  test("Owen's reply plays with no pauses between chunks", () => {
    const { gaps, firstAudio } = simulate(OWEN)
    expect(Math.max(...gaps)).toBe(0)
    expect(firstAudio).toBeLessThan(9)
  })

  test('without the buffer the same reply pauses ~4s after the first sentence', () => {
    const { gaps } = simulate(OWEN, 1, 0)
    expect(gaps[0]).toBeGreaterThan(3.5)
  })

  test('the wait is capped when the server is too slow to ever keep up', () => {
    const { firstAudio } = simulate(OWEN, 2, 10)
    expect(firstAudio).toBeLessThanOrEqual(synth(31, 2) + 10.25)
  })
})

describe('speechWeight (spoken length, since speaches reads numbers and symbols out)', () => {
  test('plain prose weighs its length', () => {
    const t = 'Because the macro market is in a breakdown regime, we wait.'
    expect(speechWeight(t)).toBe(t.length)
  })

  test('prices, timeframes and tickers weigh about what they sound like', () => {
    // 124 raw chars that played for 18.4s in the browser (≈266 spoken chars at 69ms/char)
    const t =
      'Trading at $81,702 (below its 4H 20 EMA of $83,458 and 1H 50 EMA of $82,975). ETH & SOL: Both firmly below their 4H 20 EMAs.'
    expect(speechWeight(t)).toBeGreaterThan(230)
    expect(speechWeight(t)).toBeLessThan(310)
  })
})
