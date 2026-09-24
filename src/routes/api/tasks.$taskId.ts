import { createFileRoute } from '@tanstack/react-router'
import { Route as HermesTaskRoute } from './hermes-tasks.$taskId'

export const Route = createFileRoute('/api/tasks/$taskId')({
  server: { handlers: (HermesTaskRoute.options as any).server.handlers },
})
