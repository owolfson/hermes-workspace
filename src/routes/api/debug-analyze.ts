import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { requireJsonContentType } from '../../server/rate-limit'
import { readHermesConfigFiles, resolveHermesConfigPaths } from '../../server/hermes-config-store'
import { buildDebugMessages, parseDebugAnalysis, resolveLlmEndpoint } from '../../server/debug-analysis'

// Terminal "Analyze" button: one bare LLM call (no agent tools) against the
// provider the workspace is configured to chat with.
export const Route = createFileRoute('/api/debug-analyze')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        const csrfCheck = requireJsonContentType(request)
        if (csrfCheck) return csrfCheck

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
        const terminalOutput = typeof body.terminalOutput === 'string' ? body.terminalOutput.trim() : ''
        if (!terminalOutput) return json({ ok: false, error: 'terminalOutput required' }, { status: 400 })

        const endpoint = resolveLlmEndpoint(readHermesConfigFiles(resolveHermesConfigPaths()).config)
        if (!endpoint) return json({ ok: false, error: 'No LLM provider is configured' }, { status: 503 })

        try {
          const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: endpoint.model,
              messages: buildDebugMessages(terminalOutput),
              stream: false,
              temperature: 0.2,
              max_tokens: 2048,
              // Reasoning tokens count against max_tokens; this is a short structured answer.
              chat_template_kwargs: { enable_thinking: false },
            }),
            signal: AbortSignal.timeout(120_000),
          })
          if (!res.ok) {
            const text = await res.text().catch(() => '')
            return json({ ok: false, error: `LLM HTTP ${res.status}: ${text.slice(0, 200)}` }, { status: 502 })
          }
          const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
          const analysis = parseDebugAnalysis(data.choices?.[0]?.message?.content ?? '')
          if (!analysis) return json({ ok: false, error: 'The model did not return a usable analysis' }, { status: 502 })
          return json(analysis)
        } catch (error) {
          return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 502 })
        }
      },
    },
  },
})
