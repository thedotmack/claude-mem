#!/usr/bin/env bash

# Phase 10 — server-beta container entrypoint. The container ALWAYS runs the
# server-beta runtime; the legacy worker is never started here. Generation can
# be split into a separate `claude-mem server worker start` process by setting
# CLAUDE_MEM_GENERATION_DISABLED=true on this service and running the worker
# command in a sibling container.

set -euo pipefail

mkdir -p "$HOME/.claude" "$HOME/.claude-mem"

if [[ -n "${CLAUDE_MEM_CREDENTIALS_FILE:-}" ]]; then
  if [[ ! -f "$CLAUDE_MEM_CREDENTIALS_FILE" ]]; then
    echo "ERROR: CLAUDE_MEM_CREDENTIALS_FILE set but file missing: $CLAUDE_MEM_CREDENTIALS_FILE" >&2
    exit 1
  fi
  cp "$CLAUDE_MEM_CREDENTIALS_FILE" "$HOME/.claude/.credentials.json"
  chmod 600 "$HOME/.claude/.credentials.json"
fi

export PATH="/usr/local/bun/bin:/usr/local/share/npm-global/bin:$PATH"

# Mark this process tree as running inside Docker so server-beta env
# validation can refuse local-dev auth and require the full Postgres+Valkey
# configuration. /.dockerenv is also detected automatically; this is belt-
# and-suspenders for runtimes that don't expose it.
export CLAUDE_MEM_DOCKER=1
export CLAUDE_MEM_RUNTIME="${CLAUDE_MEM_RUNTIME:-server-beta}"

SERVER_BETA_SCRIPT="/opt/claude-mem/scripts/server-beta-service.cjs"

# Mode selection:
#   CLAUDE_MEM_CONTAINER_MODE=server (default) — HTTP server-beta, no worker
#   CLAUDE_MEM_CONTAINER_MODE=worker          — BullMQ generation worker only
#   CLAUDE_MEM_CONTAINER_MODE=shell           — fall through to "$@" for tooling
MODE="${CLAUDE_MEM_CONTAINER_MODE:-server}"

case "$MODE" in
  server)
    echo "[claude-mem] starting server-beta runtime (HTTP, no legacy worker)" >&2
    exec bun "$SERVER_BETA_SCRIPT" --daemon
    ;;
  worker)
    echo "[claude-mem] starting server-beta generation worker (no HTTP)" >&2
    # Force generation enabled in the worker process even if the env var was
    # set on the shared compose file; the worker IS the generation process.
    unset CLAUDE_MEM_GENERATION_DISABLED
    exec bun "$SERVER_BETA_SCRIPT" worker start
    ;;
  shell|tooling)
    if [[ $# -eq 0 ]]; then
      exec bash
    fi
    exec "$@"
    ;;
  *)
    echo "ERROR: unknown CLAUDE_MEM_CONTAINER_MODE=$MODE (expected: server, worker, shell)" >&2
    exit 1
    ;;
esac
