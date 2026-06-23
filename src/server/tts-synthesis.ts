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
const MAX_CHUNK_CHARS = 300
const MIN_CHUNK_CHARS = 25

type RecordLike = Record<string, unknown>

export type TtsParams = {
  exaggeration: number
  cfg_weight: number
  temperature: number
}

export type ResolvedTtsTarget = {
  ok: true
  provider: 'local' | 'openai'
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
      params: { exaggeration: 0.5, cfg_weight: 0.3, temperature: 0.8 },
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
        readString(local.model) ||
        readString(runtimeEnv.TTS_LOCAL_MODEL) ||
        DEFAULT_LOCAL_MODEL,
      voice: readString(tts.voice) || readString(local.voice) || DEFAULT_LOCAL_VOICE,
      apiKey: readString(runtimeEnv.TTS_LOCAL_API_KEY) || 'no-auth',
      params: {
        exaggeration: readNumber(runtimeEnv.TTS_EXAGGERATION, 0.5),
        cfg_weight: readNumber(runtimeEnv.TTS_CFG_WEIGHT, 0.3),
        temperature: readNumber(runtimeEnv.TTS_TEMPERATURE, 0.8),
      },
    }
  }

  return {
    ok: false,
    error: `Configured TTS provider "${provider}" is not supported.`,
  }
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
export function chunkSpeechText(
  text: string,
  maxChars: number = MAX_CHUNK_CHARS,
): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const sentences = trimmed.split(/(?<=[.!?])\s+/)
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence
    if (candidate.length <= maxChars) {
      current = candidate
    } else {
      if (current) chunks.push(current)
      current = sentence
    }
  }
  if (current) chunks.push(current)

  const merged: string[] = []
  for (const chunk of chunks) {
    if (merged.length && chunk.length < MIN_CHUNK_CHARS) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${chunk}`
    } else {
      merged.push(chunk)
    }
  }
  return merged
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
