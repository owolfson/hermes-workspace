export type DebugAnalysis = {
  summary: string
  rootCause: string
  suggestedCommands: Array<{ command: string; description: string }>
}

const MAX_TERMINAL_CHARS = 6_000
const MAX_COMMANDS = 5

const SYSTEM = [
  'You are a terminal debugging assistant. You are given the recent output of a terminal session.',
  'Explain what went wrong. Reply with ONLY one JSON object, no prose, in this shape:',
  '{"summary": string, "rootCause": string, "suggestedCommands": [{"command": string, "description": string}]}',
  'Suggest at most 5 safe, concrete commands. Never suggest destructive commands (rm -rf, force pushes, dropping data).',
].join('\n')

type Provider = { api?: unknown; api_key?: unknown; default_model?: unknown }

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** The OpenAI-compatible endpoint + model the workspace itself is configured to chat with. */
export function resolveLlmEndpoint(config: Record<string, unknown>): { baseUrl: string; apiKey: string; model: string } | null {
  const providerId = typeof config.provider === 'string' ? config.provider : ''
  const provider = asRecord(asRecord(config.providers)?.[providerId]) as Provider | null
  const baseUrl = typeof provider?.api === 'string' ? provider.api.replace(/\/+$/, '') : ''
  if (!baseUrl) return null
  const modelBlock = asRecord(config.model)
  const model =
    (typeof config.model === 'string' && config.model) ||
    (typeof modelBlock?.default === 'string' && modelBlock.default) ||
    (typeof provider?.default_model === 'string' && provider.default_model) ||
    ''
  if (!model) return null
  return { baseUrl, apiKey: typeof provider?.api_key === 'string' ? provider.api_key : '', model }
}

export function buildDebugMessages(terminalOutput: string): Array<{ role: 'system' | 'user'; content: string }> {
  const tail = terminalOutput.length > MAX_TERMINAL_CHARS ? terminalOutput.slice(-MAX_TERMINAL_CHARS) : terminalOutput
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Recent terminal output:\n\n${tail}\n\nReturn the JSON now.` },
  ]
}

export function parseDebugAnalysis(raw: string): DebugAnalysis | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  const obj = asRecord(parsed)
  const summary = typeof obj?.summary === 'string' ? obj.summary.trim() : ''
  const rootCause = typeof obj?.rootCause === 'string' ? obj.rootCause.trim() : ''
  if (!summary || !rootCause) return null
  const suggestedCommands: DebugAnalysis['suggestedCommands'] = []
  for (const entry of Array.isArray(obj?.suggestedCommands) ? obj.suggestedCommands : []) {
    const item = asRecord(entry)
    const command = typeof item?.command === 'string' ? item.command.trim() : ''
    const description = typeof item?.description === 'string' ? item.description.trim() : ''
    if (command && description) suggestedCommands.push({ command, description })
    if (suggestedCommands.length === MAX_COMMANDS) break
  }
  return { summary, rootCause, suggestedCommands }
}
