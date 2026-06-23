import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { safeErrorMessage } from '../../server/rate-limit'
import {
  readHermesConfigFiles,
  resolveHermesConfigPaths,
} from '../../server/hermes-config-store'
import { resolveTtsTarget } from '../../server/tts-synthesis'

const OPENAI_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']

type VoiceOption = { id: string; name: string }

function parseVoiceList(payload: unknown): VoiceOption[] {
  const record =
    payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  const list = Array.isArray(record.voices)
    ? record.voices
    : Array.isArray(record.data)
      ? record.data
      : []
  const voices: VoiceOption[] = []
  for (const entry of list) {
    if (typeof entry === 'string') {
      voices.push({ id: entry, name: entry })
    } else if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>
      const id = typeof e.id === 'string' ? e.id : typeof e.name === 'string' ? e.name : ''
      if (id) voices.push({ id, name: typeof e.name === 'string' ? e.name : id })
    }
  }
  return voices
}

export const Route = createFileRoute('/api/tts-voices')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        try {
          const config = readHermesConfigFiles(resolveHermesConfigPaths()).config
          const target = resolveTtsTarget(config)
          if (target.ok === false) {
            return json({ ok: false, error: target.error }, { status: 400 })
          }

          if (target.provider === 'openai') {
            return json({
              ok: true,
              provider: 'openai',
              voices: OPENAI_VOICES.map((v) => ({ id: v, name: v })),
            })
          }

          const upstream = await fetch(`${target.baseUrl}/audio/voices`, {
            headers: { Authorization: `Bearer ${target.apiKey}` },
          })
          if (!upstream.ok) {
            return json(
              {
                ok: false,
                error: `Voice list request failed (${upstream.status}).`,
              },
              { status: 502 },
            )
          }
          const voices = parseVoiceList(await upstream.json().catch(() => ({})))
          return json({ ok: true, provider: target.provider, voices })
        } catch (error) {
          return json({ ok: false, error: safeErrorMessage(error) }, { status: 500 })
        }
      },
    },
  },
})
