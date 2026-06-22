# syntax=docker/dockerfile:1.6
# Hermes Workspace — production Docker image
# Publishes to ghcr.io/outsourc-e/hermes-workspace
#
# Build locally:
#   docker build -t hermes-workspace .
# Run:
#   docker run -p 3000:3000 -e HERMES_API_URL=http://host.docker.internal:8642 hermes-workspace
# Or pull pre-built:
#   docker pull ghcr.io/outsourc-e/hermes-workspace:latest
#
FROM tianon/gosu:1.17-bookworm AS gosu_source
# ─── build stage ─────────────────────────────────────────────────────────
FROM node:22-slim AS build
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install deps (cache-friendly: copy only manifests first)
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# Copy sources and build
COPY . .
RUN pnpm build

# ─── hermes CLI stage (Conductor/Swarm native workers) ───────────────────
# Conductor's "Native Workspace Swarm" spawns `hermes --tui --profile <worker>`
# child processes (swarm-lifecycle.ts). The workspace container therefore needs
# the hermes-agent CLI on PATH. Installed from PyPI into an isolated venv, pinned
# to match the running agent (0.16.0). Python 3.11 (the install script's target)
# is the node:22-slim base, so the relocated venv works in the runtime stage.
FROM node:22-slim AS hermescli
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/hermes-cli \
 && /opt/hermes-cli/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/hermes-cli/bin/pip install --no-cache-dir hermes-agent==0.16.0

# ─── runtime stage ────────────────────────────────────────────────────────
FROM node:22-slim
# python3 is required by scripts/pty-helper.py (terminal feature). Originally
# added in PR #185 for issue #161; regressed by the 2026-05-01 rename commit
# efcb7d14 and re-added here per issue #259.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl tini python3 tmux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r workspace && useradd -r -g workspace -u 10010 -m workspace

COPY --from=gosu_source /gosu /usr/local/bin/gosu

# hermes CLI for Conductor/Swarm native workers (venv from the hermescli stage).
# The venv's python shebang resolves to the runtime's /usr/bin/python3 (3.11).
COPY --from=hermescli /opt/hermes-cli /opt/hermes-cli
RUN ln -sf /opt/hermes-cli/bin/hermes /usr/local/bin/hermes

WORKDIR /app

# Copy build artefacts + runtime deps.
# server-entry.js is the Node HTTP server that wraps the TanStack Start fetch
# handler exported by dist/server/server.js. Without it, `node dist/server/server.js`
# imports the handler module, runs top-level code, and exits (code 0) because
# nothing keeps the event loop alive — see issue #129.
COPY --from=build --chown=workspace:workspace /app/dist ./dist
COPY --from=build --chown=workspace:workspace /app/node_modules ./node_modules
COPY --from=build --chown=workspace:workspace /app/package.json ./package.json
COPY --from=build --chown=workspace:workspace /app/server-entry.js ./server-entry.js
COPY --from=build --chown=workspace:workspace /app/skills ./skills
COPY --chown=workspace:workspace docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    HERMES_API_URL=http://hermes-agent:8642 \
    HERMES_CLI_PATH=/usr/local/bin/hermes

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/ >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--max-old-space-size=2048", "server-entry.js"]
