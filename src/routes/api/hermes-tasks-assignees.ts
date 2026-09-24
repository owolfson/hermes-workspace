import { createFileRoute } from '@tanstack/react-router'
import { Route as ClaudeAssigneesRoute } from './claude-tasks-assignees'

// tasks-api.ts picks /api/hermes-tasks-assignees when the Hermes task backend wins
// its probe; the assignee list (agent profiles + human reviewer) is backend-agnostic.
export const Route = createFileRoute('/api/hermes-tasks-assignees')({
  server: { handlers: (ClaudeAssigneesRoute.options as any).server.handlers },
})
