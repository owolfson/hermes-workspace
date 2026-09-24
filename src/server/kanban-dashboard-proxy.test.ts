import { beforeEach, describe, expect, it, vi } from 'vitest'

const dashboardFetch = vi.fn()

vi.mock('./gateway-capabilities', () => ({
  CLAUDE_DASHBOARD_URL: 'http://dashboard.test:9119',
  dashboardFetch: (...args: Array<unknown>) => dashboardFetch(...args),
  // Old, bearer-only auth path. The proxy must not depend on it any more.
  fetchDashboardToken: vi.fn(async () => ''),
}))

import { fetchDashboardKanbanBoard } from './kanban-dashboard-proxy'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('kanban dashboard proxy authentication', () => {
  beforeEach(() => {
    dashboardFetch.mockReset()
    vi.restoreAllMocks()
  })

  it('calls the dashboard through the shared authenticated helper (session-cookie login), not a bare fetch', async () => {
    // The dashboard answers 401 {"reason":"no_cookie"} to any request that does not
    // carry the session cookie, which turned /api/claude-tasks and /api/swarm-kanban
    // into HTTP 500 for every user.
    const bareFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json({ error: 'unauthenticated', reason: 'no_cookie' }, 401))
    dashboardFetch.mockResolvedValue(json({ columns: [{ name: 'todo', tasks: [] }] }))

    const board = await fetchDashboardKanbanBoard()

    expect(board.columns[0].name).toBe('todo')
    expect(dashboardFetch).toHaveBeenCalledTimes(1)
    expect(String(dashboardFetch.mock.calls[0][0])).toContain('/api/plugins/kanban/board')
    expect(bareFetch).not.toHaveBeenCalled()
  })

  it('forwards the board query param', async () => {
    dashboardFetch.mockResolvedValue(json({ columns: [] }))
    await fetchDashboardKanbanBoard('ops')
    expect(String(dashboardFetch.mock.calls[0][0])).toContain('board=ops')
  })

  it('throws with the status and body when the dashboard still refuses', async () => {
    dashboardFetch.mockResolvedValue(json({ detail: 'Unauthorized', reason: 'no_cookie' }, 401))
    await expect(fetchDashboardKanbanBoard()).rejects.toThrow(/401.*no_cookie/)
  })
})
