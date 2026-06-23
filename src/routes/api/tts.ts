import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  getClientIp,
  rateLimit,
  rateLimitResponse,
  safeErrorMessage,
} from '../../server/rate-limit'
import {
  readHermesConfigFiles,
  resolveHermesConfigPaths,
} from '../../server/hermes-config-store'
import {
  chunkSpeechText,
  cleanSpeechText,
  concatWav,
  resolveTtsTarget,
  trimTrailingSilence,
} from '../../server/tts-synthesis'

const MAX_TEXT_CHARS = 8000

export const Route = createFileRoute('/api/tts')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        const ip = getClientIp(request)
        if (!rateLimit(`tts:${ip}`, 30, 60_000)) {
          return rateLimitResponse()
        }

        try {
          const body = (await request.json().catch(() => ({}))) as {
            text?: unknown
            voice?: unknown
          }
          const rawText = typeof body.text === 'string' ? body.text : ''
          const overrideVoice =
            typeof body.voice === 'string' ? body.voice.trim() : ''

          const cleaned = cleanSpeechText(rawText).slice(0, MAX_TEXT_CHARS)
          if (!cleaned) {
            return json(
              { ok: false, error: 'Nothing to speak after cleaning text.' },
              { status: 400 },
            )
          }

          const config = readHermesConfigFiles(resolveHermesConfigPaths()).config
          const target = resolveTtsTarget(config)
          if (target.ok === false) {
            return json({ ok: false, error: target.error }, { status: 400 })
          }

          const voice = overrideVoice || target.voice
          const chunks = chunkSpeechText(cleaned)
          const wavChunks: Buffer[] = []

          for (const chunk of chunks) {
            const payload: Record<string, unknown> = {
              model: target.model,
              input: chunk,
              voice,
              response_format: 'wav',
            }
            // chatterbox-turbo voice-control knobs (ignored by other backends).
            if (target.provider === 'local') {
              payload.exaggeration = target.params.exaggeration
              payload.cfg_weight = target.params.cfg_weight
              payload.temperature = target.params.temperature
            }

            const upstream = await fetch(`${target.baseUrl}/audio/speech`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${target.apiKey}`,
              },
              body: JSON.stringify(payload),
            })

            if (!upstream.ok) {
              const detail = await upstream.text().catch(() => '')
              return json(
                {
                  ok: false,
                  error:
                    detail ||
                    `Speech synthesis failed (${upstream.status}).`,
                },
                { status: upstream.status === 401 ? 502 : upstream.status },
              )
            }

            const buf = Buffer.from(await upstream.arrayBuffer())
            if (buf.length > 44) wavChunks.push(buf)
          }

          if (wavChunks.length === 0) {
            return json(
              { ok: false, error: 'Speech provider returned no audio.' },
              { status: 502 },
            )
          }

          const audio = trimTrailingSilence(concatWav(wavChunks))

          return new Response(new Uint8Array(audio), {
            status: 200,
            headers: {
              'Content-Type': 'audio/wav',
              'Content-Length': String(audio.length),
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              'X-Tts-Provider': target.provider,
              'X-Tts-Voice': voice,
            },
          })
        } catch (error) {
          return json(
            { ok: false, error: safeErrorMessage(error) },
            { status: 500 },
          )
        }
      },
    },
  },
})
