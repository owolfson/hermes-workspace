import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { requireLocalOrAuth } from '../../server/auth-middleware'
import { listMemoryFiles } from '../../server/memory-browser'

export const Route = createFileRoute('/api/memory')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!requireLocalOrAuth(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        // Memory is sourced entirely from the local filesystem via
        // memory-browser.ts (reads $HERMES_HOME/MEMORY.md + memory/ +
        // memories/), matching the always-true `memory` capability. The old
        // implementation proxied the gateway's /api/memory, which this
        // split-container gateway (hermes-agent 0.17) doesn't serve — every
        // call 404'd and this route returned 500.
        try {
          return json({ files: listMemoryFiles() })
        } catch (err) {
          return json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          )
        }
      },
    },
  },
})
