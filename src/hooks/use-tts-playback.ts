import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  initialBufferWait,
  speechWeight,
  type ChunkProgress,
} from '../lib/tts-schedule'

// Singleton playback controller: only one message speaks at a time, and any
// component can read/drive the shared state. Audio is decoded from the WAV the
// /api/tts route returns (chatterbox-turbo via the local speaches backend).

export type TtsPlaybackState = 'idle' | 'loading' | 'playing'

type Snapshot = { key: string | null; state: TtsPlaybackState }

let snapshot: Snapshot = { key: null, state: 'idle' }
let currentAudio: HTMLAudioElement | null = null
let currentUrl: string | null = null
let currentPlayResolve: (() => void) | null = null
let currentAbort: AbortController | null = null
let reqCounter = 0

const listeners = new Set<() => void>()

function emit(next: Snapshot) {
  snapshot = next
  for (const l of listeners) l()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return snapshot
}

function teardownAudio() {
  // Cancel in-flight synthesis so abandoned chunks don't queue on the GPU
  // ahead of whatever plays next.
  if (currentAbort) {
    currentAbort.abort()
    currentAbort = null
  }
  if (currentAudio) {
    currentAudio.onended = null
    currentAudio.onerror = null
    currentAudio.pause()
    currentAudio.src = ''
    currentAudio = null
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl)
    currentUrl = null
  }
  // Unblock any awaited playback so the synth loop can exit promptly.
  if (currentPlayResolve) {
    const resolve = currentPlayResolve
    currentPlayResolve = null
    resolve()
  }
}

export function stopSpeaking() {
  reqCounter++
  teardownAudio()
  emit({ key: null, state: 'idle' })
}

async function fetchChunkBlob(
  text: string,
  voice: string | undefined,
  myReq: number,
  signal: AbortSignal,
): Promise<Blob | null> {
  if (myReq !== reqCounter) return null
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
      signal,
    })
    if (myReq !== reqCounter || !res.ok) return null
    return await res.blob()
  } catch {
    return null
  }
}

// Never buffer longer than this before the first chunk: if the server is too slow
// to keep up at all, some pauses beat a long silence before anything plays.
const MAX_INITIAL_BUFFER_MS = 10_000

const nowSec = () => performance.now() / 1000

/** Audio length of a PCM WAV blob from its header (byte rate at offset 28). */
async function wavSeconds(blob: Blob): Promise<number | undefined> {
  try {
    const head = new DataView(await blob.slice(0, 44).arrayBuffer())
    const byteRate = head.getUint32(28, true)
    return byteRate > 0 ? (blob.size - 44) / byteRate : undefined
  } catch {
    return undefined
  }
}

function playBlob(blob: Blob, myReq: number): Promise<void> {
  return new Promise((resolve) => {
    if (myReq !== reqCounter) {
      resolve()
      return
    }
    const url = URL.createObjectURL(blob)
    currentUrl = url
    const audio = new Audio(url)
    currentAudio = audio
    currentPlayResolve = resolve
    const finish = () => {
      if (currentUrl === url) {
        URL.revokeObjectURL(url)
        currentUrl = null
      }
      if (currentPlayResolve === resolve) currentPlayResolve = null
      resolve()
    }
    audio.onended = finish
    audio.onerror = finish
    audio.play().catch(() => finish())
  })
}

/**
 * Synthesize and play `text` progressively: the server returns a chunk plan,
 * then every chunk is synthesised back-to-back while the earlier ones play — the
 * GPU never idles waiting on playback — and playback starts once enough is
 * buffered that later chunks arrive before they are needed (no mid-reply pauses). Re-calling with the same `key` while busy
 * toggles playback off (stop button).
 */
export async function speakText(
  text: string,
  opts: { key?: string; voice?: string } = {},
): Promise<void> {
  const key = opts.key ?? text.slice(0, 48)

  if (snapshot.key === key && snapshot.state !== 'idle') {
    stopSpeaking()
    return
  }

  reqCounter++
  const myReq = reqCounter
  teardownAudio()
  const controller = new AbortController()
  currentAbort = controller
  emit({ key, state: 'loading' })

  try {
    const planRes = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: opts.voice, plan: true }),
      signal: controller.signal,
    })
    if (myReq !== reqCounter) return
    if (!planRes.ok) {
      emit({ key: null, state: 'idle' })
      return
    }
    const plan = (await planRes.json()) as {
      chunks?: unknown
      voice?: unknown
    }
    if (myReq !== reqCounter) return

    const chunks = Array.isArray(plan.chunks)
      ? (plan.chunks.filter((c) => typeof c === 'string') as string[])
      : []
    const voice =
      opts.voice ?? (typeof plan.voice === 'string' ? plan.voice : undefined)
    if (chunks.length === 0) {
      emit({ key: null, state: 'idle' })
      return
    }

    // Producer: synthesise chunks one after another (the GPU serialises them
    // anyway) without waiting for playback. Consumer: play them in order.
    const progress: ChunkProgress[] = chunks.map((c) => ({
      chars: speechWeight(c),
    }))
    const blobs: Array<Promise<Blob | null>> = []
    let previous: Promise<unknown> = Promise.resolve()
    chunks.forEach((chunk, i) => {
      const next = previous.then(async () => {
        progress[i].startedAt = nowSec()
        const blob = await fetchChunkBlob(chunk, voice, myReq, controller.signal)
        progress[i].readyAt = nowSec()
        if (blob) progress[i].audioSec = await wavSeconds(blob)
        return blob
      })
      blobs.push(next)
      previous = next
    })
    let started = false
    for (let i = 0; i < blobs.length; i++) {
      const blob = await blobs[i]
      if (myReq !== reqCounter) return
      if (!blob) continue
      if (!started) {
        // Synthesis runs at ~real time, so a short opening chunk followed by a
        // longer one would leave a pause after it. Buffer just long enough
        // (re-estimated as chunks land) that later chunks arrive in time.
        started = true
        const pending = progress.slice(i)
        const deadline = performance.now() + MAX_INITIAL_BUFFER_MS
        while (performance.now() < deadline) {
          const wait = initialBufferWait(pending, nowSec())
          if (wait <= 0) break
          await new Promise((r) => setTimeout(r, Math.min(wait * 1000, 250)))
          if (myReq !== reqCounter) return
        }
      }
      if (snapshot.key !== key || snapshot.state !== 'playing') {
        emit({ key, state: 'playing' })
      }
      await playBlob(blob, myReq)
      if (myReq !== reqCounter) return
    }
    if (myReq === reqCounter) emit({ key: null, state: 'idle' })
  } catch {
    if (myReq === reqCounter) emit({ key: null, state: 'idle' })
  }
}

export function useTtsPlayback() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return { ...state, speak: speakText, stop: stopSpeaking }
}

// ── Voice settings (auto-speak + default voice) ────────────────────────────
// Cached so the many mounted MessageItem instances don't each re-fetch. The
// settings dialog dispatches `tts-settings-changed` after a save so this picks
// up changes without a reload.

export type TtsSettings = { autoSpeak: boolean; voice: string }

const TTS_SETTINGS_EVENT = 'tts-settings-changed'
let settingsCache: TtsSettings | null = null
let settingsPromise: Promise<TtsSettings> | null = null

async function fetchTtsSettings(): Promise<TtsSettings> {
  try {
    const res = await fetch('/api/hermes-config')
    const data = await res.json()
    const tts = (data?.config?.tts ?? {}) as Record<string, unknown>
    settingsCache = {
      autoSpeak: tts.autoSpeak === true,
      voice: typeof tts.voice === 'string' ? tts.voice : '',
    }
  } catch {
    settingsCache = { autoSpeak: false, voice: '' }
  }
  return settingsCache
}

export function notifyTtsSettingsChanged() {
  settingsCache = null
  settingsPromise = null
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(TTS_SETTINGS_EVENT))
  }
}

export function useTtsSettings(): TtsSettings {
  const [settings, setSettings] = useState<TtsSettings>(
    () => settingsCache ?? { autoSpeak: false, voice: '' },
  )

  useEffect(() => {
    let active = true
    const load = () => {
      if (settingsCache) {
        setSettings(settingsCache)
        return
      }
      if (!settingsPromise) settingsPromise = fetchTtsSettings()
      settingsPromise.then((s) => {
        if (active) setSettings(s)
      })
    }
    load()
    window.addEventListener(TTS_SETTINGS_EVENT, load)
    return () => {
      active = false
      window.removeEventListener(TTS_SETTINGS_EVENT, load)
    }
  }, [])

  return settings
}
