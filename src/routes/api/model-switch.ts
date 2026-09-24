import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { gatewayFetch } from '../../server/gateway-capabilities'

// Locks a session's model on the gateway (POST /api/sessions/{id}/model).
export const Route = createFileRoute('/api/model-switch')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
        const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''
        const model = typeof body.model === 'string' ? body.model.trim() : ''
        const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
        if (!sessionKey || !model) {
          return json({ ok: false, error: 'sessionKey and model required' }, { status: 400 })
        }

        try {
          const res = await gatewayFetch(`/api/sessions/${encodeURIComponent(sessionKey)}/model`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(provider ? { model, provider } : { model }),
          })
          const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>
          if (!res.ok) {
            const error =
              (payload.error as { message?: string } | undefined)?.message ??
              (typeof payload.error === 'string' ? payload.error : null) ??
              (typeof payload.detail === 'string' ? payload.detail : null) ??
              `Gateway responded with status ${res.status}`
            // A 4xx is the gateway rejecting the request (unknown session, default model
            // "lock", bad model): keep its status so the UI shows the real reason.
            return json({ ok: false, error }, { status: res.status >= 400 && res.status < 500 ? res.status : 502 })
          }
          return json({ ok: true, model, ...payload })
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 502 })
        }
      },
    },
  },
})
