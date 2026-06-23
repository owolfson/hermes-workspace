import { useEffect, useState, useSyncExternalStore } from 'react'

// Singleton playback controller: only one message speaks at a time, and any
// component can read/drive the shared state. Audio is decoded from the WAV the
// /api/tts route returns (chatterbox-turbo via the local speaches backend).

export type TtsPlaybackState = 'idle' | 'loading' | 'playing'

type Snapshot = { key: string | null; state: TtsPlaybackState }

let snapshot: Snapshot = { key: null, state: 'idle' }
let currentAudio: HTMLAudioElement | null = null
let currentUrl: string | null = null
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
    currentAudio.pause()
    currentAudio.src = ''
    currentAudio = null
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl)
    currentUrl = null
  }
}

export function stopSpeaking() {
  reqCounter++
  teardownAudio()
  emit({ key: null, state: 'idle' })
}

/**
 * Synthesize and play `text`. Re-calling with the same `key` while it is busy
 * toggles playback off (so the speaker button doubles as a stop button).
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
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: opts.voice }),
    })
    if (myReq !== reqCounter) return
    if (!res.ok) {
      emit({ key: null, state: 'idle' })
      return
    }
    const blob = await res.blob()
    if (myReq !== reqCounter) return

    const url = URL.createObjectURL(blob)
    currentUrl = url
    const audio = new Audio(url)
    currentAudio = audio
    audio.onended = () => {
      if (myReq === reqCounter) {
        teardownAudio()
        emit({ key: null, state: 'idle' })
      }
    }
    audio.onerror = () => {
      if (myReq === reqCounter) {
        teardownAudio()
        emit({ key: null, state: 'idle' })
      }
    }
    emit({ key, state: 'playing' })
    await audio.play().catch(() => {
      if (myReq === reqCounter) emit({ key: null, state: 'idle' })
    })
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
