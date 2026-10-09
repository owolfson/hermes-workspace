// How long to buffer before the first chunk of a spoken reply starts playing.
//
// Chatterbox Turbo on the GTX 1080 synthesises at roughly real time (it is CPU-bound
// in its per-token loop), and the player synthesises chunks back to back while earlier
// ones play. Chunk k is therefore late — an audible pause — whenever it finishes after
// everything before it has played, typically right after a short opening sentence
// that is followed by a long one. Waiting a little before the FIRST chunk moves that
// silence to the start, where it reads as "thinking" instead of a stall mid-sentence.

export type SynthModel = {
  /** fixed cost per chunk request (seconds) */
  overheadSec: number
  /** synthesis seconds per character */
  secPerChar: number
  /** seconds of audio per character, until real chunk durations are known */
  audioSecPerChar: number
}

// Fitted on live chunks (speaches-chatterbox, turbo, GTX 1080), speech ≈ 14.5 chars/s:
//   2026-10-08 stock token loop: synth = 0.59s + 53.3ms/char (RTF 0.8-1.0)
//   2026-10-09 CUDA-graph T3 decode: synth = 0.39s + 38.4ms/char (RTF 0.6-0.74; median err 12%, p90 39%)
// The player rescales by the speed it actually observes, so a stale model only costs start latency.
export const DEFAULT_SYNTH_MODEL: SynthModel = {
  overheadSec: 0.39,
  secPerChar: 0.0384,
  audioSecPerChar: 0.069,
}

/**
 * Approximate SPOKEN length of a chunk. speaches verbalises numbers and symbols
 * ("$81,702" -> "eighty-one thousand seven hundred two dollars", "4H" -> "four hour"),
 * so a price-heavy chunk takes ~2x the synthesis (and audio) its raw length suggests;
 * predicting from raw length left a 4s gap before such a chunk in a real-browser test.
 */
export function speechWeight(text: string): number {
  let w = text.length
  w += 4 * (text.match(/\d/g)?.length ?? 0) // a digit reads as ~5 chars ("seven", "thousand", ...)
  w += 7 * (text.match(/[$%]/g)?.length ?? 0) // "dollars", "percent"
  w += 3 * (text.match(/[&+]/g)?.length ?? 0) // "and", "plus"
  // all-caps tickers / acronyms (ETH, EMA) are spelled out letter by letter
  for (const m of text.match(/\b[A-Z]{2,5}s?\b/g) ?? []) w += m.replace(/s$/, '').length
  return w
}

export type ChunkProgress = {
  /** spoken length (`speechWeight`), the unit the model's per-char rates are in */
  chars: number
  /** when its synthesis request was sent (seconds, same clock as `now`) */
  startedAt?: number
  /** when its audio arrived */
  readyAt?: number
  /** real audio length once known */
  audioSec?: number
}

const MARGIN_SEC = 0.3
// Prediction error grows with how far ahead a chunk is expected, but per-chunk errors
// partly cancel, so it grows like the square root of the horizon (not linearly —
// linear over-buffered long replies into the cap in a real-browser test).
const MARGIN_SQRT = 0.25

/**
 * Seconds to keep buffering before chunk 0 plays (0 = start now). Predicts when
 * each pending chunk will arrive — the producer is sequential, scaled by how fast
 * the server has actually been on the chunks already done — and returns the
 * smallest delay after which no chunk would arrive later than it is needed.
 * Call it again as chunks complete; the estimate sharpens each time.
 */
export function initialBufferWait(
  chunks: ChunkProgress[],
  now: number,
  model: SynthModel = DEFAULT_SYNTH_MODEL,
): number {
  if (chunks.length <= 1) return 0
  const predict = (chars: number) => model.overheadSec + model.secPerChar * chars

  let actual = 0
  let predicted = 0
  let audio = 0
  let audioChars = 0
  for (const c of chunks) {
    if (c.startedAt !== undefined && c.readyAt !== undefined) {
      actual += c.readyAt - c.startedAt
      predicted += predict(c.chars)
    }
    if (c.audioSec !== undefined) {
      audio += c.audioSec
      audioChars += c.chars
    }
  }
  const speed = predicted > 0 ? Math.min(3, Math.max(0.5, actual / predicted)) : 1
  const audioPerChar = audioChars > 0 ? audio / audioChars : model.audioSecPerChar

  let need = 0
  let playedBefore = 0 // audio length of chunks before k
  let prevReady = now // when the producer gets to the next chunk (no margin: margins must not compound)
  for (const c of chunks) {
    let ready: number
    if (c.readyAt !== undefined) {
      ready = c.readyAt
      prevReady = Math.max(prevReady, ready)
    } else {
      const start = c.startedAt ?? prevReady
      const eta = Math.max(now, start + speed * predict(c.chars))
      prevReady = eta
      ready = eta + MARGIN_SEC + MARGIN_SQRT * Math.sqrt(eta - now)
    }
    need = Math.max(need, ready - playedBefore)
    playedBefore += c.audioSec ?? audioPerChar * c.chars
  }
  return Math.max(0, need - now)
}
