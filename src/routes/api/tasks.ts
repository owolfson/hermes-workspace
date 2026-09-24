import { createFileRoute } from '@tanstack/react-router'
import { Route as HermesTasksRoute } from './hermes-tasks'

// The local task store (stores/task-store.ts, Swarm2 kanban) talks to /api/tasks;
// the data lives in the same store /api/hermes-tasks serves, so share its handlers.
export const Route = createFileRoute('/api/tasks')({
  server: { handlers: (HermesTasksRoute.options as any).server.handlers },
})
