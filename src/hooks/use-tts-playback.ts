import { useEffect, useState, useSyncExternalStore } from 'react'

// Singleton playback controller: only one message speaks at a time, and any
// component can read/drive the shared state. Audio is decoded from the WAV the
// /api/tts route returns (chatterbox-turbo via the local speaches backend).

export type TtsPlaybackState = 'idle' | 'loading' | 'playing'

type Snapshot = { key: string | null; state: TtsPlaybackState }

let snapshot: Snapshot = { key: null, state: 'idle' }
let currentAudio: HTMLAudioElement | null = null
let currentUrl: string | null = null
let currentPlayResolve: (() => void) | null = null
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
): Promise<Blob | null> {
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice }),
    })
    if (myReq !== reqCounter || !res.ok) return null
    return await res.blob()
  } catch {
    return null
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
 * then each chunk is synthesised and played in order while the next is
 * prefetched — so audio starts after one chunk instead of the whole reply.
 * Re-calling with the same `key` while busy toggles playback off (stop button).
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
  emit({ key, state: 'loading' })

  try {
    const planRes = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: opts.voice, plan: true }),
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

    // Pipeline: prefetch chunk i+1's audio while chunk i plays.
    let nextBlob = fetchChunkBlob(chunks[0], voice, myReq)
    for (let i = 0; i < chunks.length; i++) {
      const blob = await nextBlob
      if (myReq !== reqCounter) return
      nextBlob =
        i + 1 < chunks.length
          ? fetchChunkBlob(chunks[i + 1], voice, myReq)
          : Promise.resolve(null)
      if (!blob) continue
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
