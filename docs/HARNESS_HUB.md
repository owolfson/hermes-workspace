# Harness Hub

Harness Hub is Hermes Workspace's compatibility layer for external agent
runtimes. Hermes Workspace remains the UI and source of truth for native Hermes
sessions; AionCore supplies ACP discovery and process compatibility for other
local harnesses.

## Current integration

- Chat opens on a command center that combines native Hermes activity, external
  harness sessions, tasks waiting for review, and recent completions.
- The Chat navigation expands into All Agents, Hermes, Codex, Grok, OpenClaw,
  and any other installed AionCore runtimes.
- External conversations can be created, reopened, and continued in the Hermes
  Workspace chat UI.
- The Assistants screen is reserved for persistent-agent configuration; live
  activity and harness diagnostics live in Chat.
- Each runtime can be tested without exposing AionCore directly to the browser.
- The desktop app starts AionCore as a child process and stops it when Hermes
  Workspace exits.
- Companion state is isolated under the Hermes Workspace application data
  directory.
- Existing Hermes themes, sessions, approvals, and agent-team UI are unchanged.

## Binary discovery

The desktop app checks these sources in order:

1. `AIONCORE_BIN`
2. A bundled `resources/bundled-aioncore/<platform>-<arch>/aioncore` binary
3. `vendor/aioncore/<platform>-<arch>/aioncore` during development
4. The verified AionUi application bundle path on macOS

Set `AIONCORE_URL` to use an already-running local or remote companion instead.
When that variable is present, Hermes Workspace will not launch another local
process. `AIONCORE_WORK_DIR` overrides the default `~/workspace` working root.

## Docker image

The Docker image bundles AionCore (checksum-verified release binary) plus the
`claude`, `gemini` and `codex` CLIs, and `docker/entrypoint.sh` supervises
`aioncore --local --host 127.0.0.1 --port 25808` next to the server. Knobs:

- `AIONCORE_ENABLED=0` skips it; `AIONCORE_URL` uses an external companion instead.
- `AIONCORE_DATA_DIR` (default `/app/.runtime/aioncore`) holds its database,
  npx adapter cache and logs — keep it on a volume.
- `AIONCORE_WORK_DIR` (default `~/workspace`) is where harness conversations run.

Credentials are runtime-only: `CLAUDE_CODE_OAUTH_TOKEN` for Claude, a mounted
`~/.gemini` for Gemini, a mounted `~/.codex` (config.toml + provider key env)
for Codex.

## Security boundary

The renderer only talks to authenticated Hermes Workspace API routes. Runtime
and conversation IDs are validated server-side, response payloads are
allowlisted, messages are size-limited, and conversation creation is limited to
installed, enabled conversational runtimes. AionCore remains bound to localhost
by default.

## Next milestone

The next layer replaces short polling with AionCore's live event stream and maps
tool calls, approval prompts, artifacts, and team runs into the same command
center. Remote ACP endpoints can then be registered through Tailscale without
replacing the native Hermes session database.
