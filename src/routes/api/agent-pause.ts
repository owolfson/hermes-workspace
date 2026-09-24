import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { findOpenMissionIdsForWorker, setSwarmMissionPaused } from '../../server/swarm-missions'

// Conductor Pause/Resume. The gateway has no way to freeze a model turn, so this is
// a durable mission-level hold: running workers finish their current turn, queued
// work is not released until resume. The response says so, so the UI/user is not misled.
export const Route = createFileRoute('/api/agent-pause')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
        const paused = body.pause === true
        const missionId = typeof body.missionId === 'string' ? body.missionId.trim() : ''
        const sessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : ''

        // Prefer the exact mission; otherwise every open mission that worker belongs to.
        const missionIds = missionId ? [missionId] : sessionKey ? findOpenMissionIdsForWorker(sessionKey) : []
        if (missionIds.length === 0) {
          return json({ ok: false, error: 'No open Conductor mission found to pause' }, { status: 404 })
        }

        const results = missionIds.map((id) => setSwarmMissionPaused({ missionId: id, paused, actor: 'conductor' }))
        if (results.every((result) => result === null)) {
          return json({ ok: false, error: 'Conductor mission not found' }, { status: 404 })
        }
        return json({
          ok: true,
          paused,
          missionIds,
          note: paused
            ? 'Mission held: running workers finish their current turn; queued work is not released until resume.'
            : 'Mission resumed.',
        })
      },
    },
  },
})
