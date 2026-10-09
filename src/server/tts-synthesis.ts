// Text-to-speech synthesis helpers (output voice).
//
// Mirrors the proven chatterbox-turbo production pipeline used by the Telegram
// bot (reference_chatterbox_production_pipeline.md): sentence-boundary chunking
// at <=300 chars, per-chunk WAV synthesis at exag=0.50 / cfg=0.30 / temp=0.80,
// lossless WAV concat, then a trailing-silence trim to drop chatterbox's
// hallucinated tails. Kept dependency-free (no ffmpeg) so it runs inside the
// stock node:22-slim runtime image.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_LOCAL_BASE_URL = 'http://192.168.1.187:5126/v1'
const DEFAULT_LOCAL_MODEL = 'chatterbox-turbo'
const DEFAULT_LOCAL_VOICE = 'anushri'
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini-tts'
const DEFAULT_OPENAI_VOICE = 'nova'

// chatterbox hallucinates above ~300 chars and emits gibberish below ~25.
// On the 1080 synthesis runs at about real time, so while chunk N plays,
// chunk N+1 is being made: it only arrives in time if it is no longer than
// chunk N. Evenly sized ~100-char chunks kept every gap under ~1 s when
// simulated against real replies (greedy packing left 2-4 s gaps).
const TARGET_CHUNK_CHARS = 100
const MAX_CHUNK_CHARS = 130
const MIN_CHUNK_CHARS = 25

type RecordLike = Record<string, unknown>

// Knobs Chatterbox *Turbo* actually honours (it ignores exaggeration,
// cfg_weight and min_p), plus pace, which speaches/kokoro apply as `speed`.
export type TtsParams = {
  temperature: number
  top_p: number
  top_k: number
  rep_penalty: number
  speed: number
}

export type ResolvedTtsTarget = {
  ok: true
  provider: 'local' | 'openai' | 'kokoro'
  baseUrl: string
  model: string
  voice: string
  apiKey: string
  params: TtsParams
}

export type ResolvedTtsError = {
  ok: false
  error: string
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readRecord(value: unknown): RecordLike {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordLike)
    : {}
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

const MIN_SPEED = 0.5
const MAX_SPEED = 2

/** Voice knobs: config (UI sliders) → env → defaults matching speaches. */
function readTtsParams(
  tts: RecordLike,
  env: Record<string, string | undefined>,
): TtsParams {
  const knob = (key: string, envKey: string, fallback: number) =>
    readNumber(tts[key], readNumber(env[envKey], fallback))
  return {
    temperature: knob('temperature', 'TTS_TEMPERATURE', 0.8),
    top_p: knob('top_p', 'TTS_TOP_P', 0.95),
    top_k: Math.round(knob('top_k', 'TTS_TOP_K', 600)),
    rep_penalty: knob('rep_penalty', 'TTS_REP_PENALTY', 1.2),
    speed: Math.min(
      MAX_SPEED,
      Math.max(MIN_SPEED, knob('speed', 'TTS_SPEED', 1)),
    ),
  }
}

export function parseEnvText(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex <= 0) continue
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) env[key] = value
  }
  return env
}

export function readHermesEnv(
  envHome = process.env.HERMES_HOME ?? process.env.CLAUDE_HOME ?? join(homedir(), '.hermes'),
): Record<string, string> {
  const envPath = join(envHome, '.env')
  if (!existsSync(envPath)) return {}
  try {
    return parseEnvText(readFileSync(envPath, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Resolve where (and how) to synthesise speech from the saved Voice config.
 * Defaults to the local speaches-chatterbox backend so output works with no
 * keys or extra setup. `local` and `speaches` are treated as the same backend.
 */
export function resolveTtsTarget(
  config: RecordLike,
  runtimeEnv: Record<string, string | undefined> = process.env,
  hermesEnv: Record<string, string> = readHermesEnv(),
): ResolvedTtsTarget | ResolvedTtsError {
  const tts = readRecord(config.tts)
  // Missing provider => local, so voice output works out of the box.
  const provider = readString(tts.provider) || 'local'

  if (provider === 'openai') {
    const openai = readRecord(tts.openai)
    const apiKey =
      readString(runtimeEnv.VOICE_TOOLS_OPENAI_KEY) ||
      readString(hermesEnv.VOICE_TOOLS_OPENAI_KEY) ||
      readString(runtimeEnv.OPENAI_API_KEY) ||
      readString(hermesEnv.OPENAI_API_KEY)
    if (!apiKey) {
      return {
        ok: false,
        error: 'OpenAI TTS is configured but VOICE_TOOLS_OPENAI_KEY or OPENAI_API_KEY is missing.',
      }
    }
    return {
      ok: true,
      provider: 'openai',
      baseUrl:
        readString(runtimeEnv.TTS_OPENAI_BASE_URL) ||
        readString(hermesEnv.TTS_OPENAI_BASE_URL) ||
        DEFAULT_OPENAI_BASE_URL,
      model: readString(openai.model) || DEFAULT_OPENAI_MODEL,
      voice: readString(openai.voice) || DEFAULT_OPENAI_VOICE,
      apiKey,
      params: readTtsParams(tts, runtimeEnv),
    }
  }

  if (provider === 'kokoro') {
    // Kokoro Voice Lab — OpenAI-compatible TTS that can speak named blends
    // (e.g. "zuri"). No auth, runs on the 1080. Voice defaults to zuri.
    const kokoro = readRecord(tts.kokoro)
    return {
      ok: true,
      provider: 'kokoro',
      baseUrl:
        readString(runtimeEnv.TTS_KOKORO_BASE_URL) ||
        readString(hermesEnv.TTS_KOKORO_BASE_URL) ||
        readString(kokoro.baseUrl) ||
        readString(kokoro.base_url) ||
        'http://192.168.1.187:8770/v1',
      model: readString(tts.model) || readString(kokoro.model) || 'kokoro',
      voice: readString(tts.voice) || readString(kokoro.voice) || 'zuri',
      apiKey: readString(runtimeEnv.TTS_KOKORO_API_KEY) || 'no-auth',
      params: readTtsParams(tts, runtimeEnv),
    }
  }

  if (provider === 'local' || provider === 'speaches') {
    const local = readRecord(tts.local)
    return {
      ok: true,
      provider: 'local',
      baseUrl:
        readString(runtimeEnv.TTS_LOCAL_BASE_URL) ||
        readString(hermesEnv.TTS_LOCAL_BASE_URL) ||
        readString(local.baseUrl) ||
        readString(tts.baseUrl) ||
        DEFAULT_LOCAL_BASE_URL,
      model:
        readString(tts.model) ||
        readString(local.model) ||
        readString(runtimeEnv.TTS_LOCAL_MODEL) ||
        DEFAULT_LOCAL_MODEL,
      voice: readString(tts.voice) || readString(local.voice) || DEFAULT_LOCAL_VOICE,
      apiKey: readString(runtimeEnv.TTS_LOCAL_API_KEY) || 'no-auth',
      params: readTtsParams(tts, runtimeEnv),
    }
  }

  return {
    ok: false,
    error: `Configured TTS provider "${provider}" is not supported.`,
  }
}

/**
 * Build the OpenAI-style /audio/speech body for one chunk. Each backend only
 * gets the knobs it honours: chatterbox turbo (speaches) the sampling knobs
 * plus pace, kokoro pace only, OpenAI pace when it differs from 1x.
 */
export function buildSpeechPayload(
  target: ResolvedTtsTarget,
  input: string,
  voice: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: target.model,
    input,
    voice,
    response_format: 'wav',
  }
  const { params } = target
  if (target.provider === 'local') {
    payload.temperature = params.temperature
    payload.top_p = params.top_p
    payload.top_k = params.top_k
    payload.rep_penalty = params.rep_penalty
    payload.speed = params.speed
  } else if (target.provider === 'kokoro' || params.speed !== 1) {
    payload.speed = params.speed
  }
  return payload
}

/** Strip markdown / code / URLs so the reader speaks prose, not syntax. */
export function cleanSpeechText(text: string): string {
  let t = text
  // Fenced code blocks
  t = t.replace(/```[\s\S]*?```/g, ' ')
  // Inline code — keep contents, drop backticks
  t = t.replace(/`([^`]*)`/g, '$1')
  // Markdown links / images → label text
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  // Bare URLs
  t = t.replace(/https?:\/\/\S+/g, ' ')
  // Headers, blockquotes, list bullets at line start
  t = t.replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
  t = t.replace(/^[ \t]*>[ \t]?/gm, '')
  t = t.replace(/^[ \t]*[-*+][ \t]+/gm, '')
  // Emphasis / strikethrough markers
  t = t.replace(/[*_~]{1,3}/g, '')
  // Collapse whitespace
  t = t.replace(/\s+/g, ' ').trim()
  return t
}

/**
 * Sentence-boundary split into <=maxChars chunks; sub-25-char chunks are
 * merged into the previous chunk (matches the Telegram bot's _chunk_text).
 */
/** Split a sentence at , ; : and word-split any clause still over the limit. */
function splitClauses(sentence: string, maxChars: number): string[] {
  const out: string[] = []
  for (const clause of sentence.split(/(?<=[,;:])\s+/)) {
    let rest = clause
    while (rest.length > maxChars) {
      const cut = rest.lastIndexOf(' ', maxChars)
      if (cut < MIN_CHUNK_CHARS) break
      out.push(rest.slice(0, cut))
      rest = rest.slice(cut + 1)
    }
    out.push(rest)
  }
  return out
}

/**
 * Cut text into evenly sized chunks at sentence ends (clause/word breaks only
 * for sentences over the limit): pick the chunk count for ~targetChars each,
 * then close a chunk once it reaches its share of the text.
 */
export function chunkSpeechText(
  text: string,
  maxChars: number = MAX_CHUNK_CHARS,
  targetChars: number = TARGET_CHUNK_CHARS,
): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const pieces = trimmed
    .split(/(?<=[.!?])\s+/)
    .flatMap((sentence) =>
      sentence.length > maxChars ? splitClauses(sentence, maxChars) : [sentence],
    )
  const total = pieces.reduce((sum, piece) => sum + piece.length + 1, 0)
  const share = total / Math.max(1, Math.round(total / targetChars))

  const chunks: string[] = []
  let current = ''
  let consumed = 0
  for (const piece of pieces) {
    const candidate = current ? `${current} ${piece}` : piece
    const boundary = share * (chunks.length + 1)
    // A tiny chunk always absorbs the next piece rather than going out alone.
    const canClose = current.length >= MIN_CHUNK_CHARS
    if (canClose && (candidate.length > maxChars || consumed + piece.length / 2 > boundary)) {
      chunks.push(current)
      current = piece
    } else {
      current = candidate
    }
    consumed += piece.length + 1
  }
  if (current) {
    if (chunks.length && current.length < MIN_CHUNK_CHARS) {
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${current}`
    } else {
      chunks.push(current)
    }
  }
  return chunks
}

// ── WAV (PCM) helpers ──────────────────────────────────────────────────────

type WavInfo = {
  sampleRate: number
  channels: number
  bitsPerSample: number
  dataOffset: number
  dataSize: number
}

function readWavInfo(buf: Buffer): WavInfo {
  // Walk the RIFF chunks to locate fmt + data (don't assume a 44-byte header).
  let channels = 1
  let sampleRate = 24000
  let bitsPerSample = 16
  let dataOffset = -1
  let dataSize = 0
  let offset = 12 // skip "RIFF"<size>"WAVE"
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2)
      sampleRate = buf.readUInt32LE(body + 4)
      bitsPerSample = buf.readUInt16LE(body + 14)
    } else if (id === 'data') {
      dataOffset = body
      dataSize = Math.min(size, buf.length - body)
      break
    }
    offset = body + size + (size % 2) // chunks are word-aligned
  }
  if (dataOffset < 0) {
    // Not a parseable WAV — treat the whole buffer past 44 bytes as PCM.
    dataOffset = Math.min(44, buf.length)
    dataSize = buf.length - dataOffset
  }
  return { sampleRate, channels, bitsPerSample, dataOffset, dataSize }
}

function buildWav(pcm: Buffer, info: WavInfo): Buffer {
  const byteRate = (info.sampleRate * info.channels * info.bitsPerSample) / 8
  const blockAlign = (info.channels * info.bitsPerSample) / 8
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(info.channels, 22)
  header.writeUInt32LE(info.sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(info.bitsPerSample, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Lossless concat of same-format PCM WAVs into one canonical WAV. */
export function concatWav(buffers: Buffer[]): Buffer {
  const valid = buffers.filter((b) => b && b.length > 44)
  if (valid.length === 0) return Buffer.alloc(0)
  if (valid.length === 1) return valid[0]

  const first = readWavInfo(valid[0])
  const payloads = valid.map((b) => {
    const info = readWavInfo(b)
    return b.subarray(info.dataOffset, info.dataOffset + info.dataSize)
  })
  return buildWav(Buffer.concat(payloads), first)
}

/**
 * Trim trailing near-silence (chatterbox's hallucinated tail) from a 16-bit
 * PCM WAV, keeping a short pad so speech isn't clipped.
 */
export function trimTrailingSilence(
  wav: Buffer,
  options: { thresholdDb?: number; padMs?: number } = {},
): Buffer {
  const info = readWavInfo(wav)
  if (info.bitsPerSample !== 16) return wav

  const threshold = 32768 * Math.pow(10, (options.thresholdDb ?? -50) / 20)
  const padSamples = Math.round(
    ((options.padMs ?? 150) / 1000) * info.sampleRate * info.channels,
  )

  const pcm = wav.subarray(info.dataOffset, info.dataOffset + info.dataSize)
  const sampleCount = Math.floor(pcm.length / 2)
  let lastLoud = -1
  for (let i = sampleCount - 1; i >= 0; i--) {
    if (Math.abs(pcm.readInt16LE(i * 2)) > threshold) {
      lastLoud = i
      break
    }
  }
  if (lastLoud < 0) return wav // all silence — leave untouched

  const keep = Math.min(sampleCount, lastLoud + 1 + padSamples)
  if (keep >= sampleCount) return wav

  const trimmedPcm = pcm.subarray(0, keep * 2)
  return buildWav(Buffer.from(trimmedPcm), info)
}
