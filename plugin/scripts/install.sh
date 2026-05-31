#!/usr/bin/env bash
# One-shot installer for claude-mem hook-perf-patch v2.
# Spec: docs/04-tdd-implementation-plan.md Phase 4.2.
#
# What it does:
#   1. Copies daemon-server.mjs, hook-client.mjs, setup-tree-sitter.mjs into the
#      plugin cache scripts/ directory.
#   2. Patches hooks.json to route hook commands through hook-client.mjs (UDS path).
#   3. Patches codex-hooks.json: removes $SHELL prelude, drops bun-runner.js,
#      then applies UDS routing.
#   4. Stops any currently-running worker-service.cjs --daemon so the new daemon
#      can come up on first hook (auto-spawn).
#
# Idempotent: making backups via .uds-bak (only first run).
# Rollback: bash install.sh --rollback

set -euo pipefail

PLUGIN_CACHE="${PLUGIN_CACHE:-${HOME}/.claude/plugins/cache/thedotmack/claude-mem/13.3.0}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ROLLBACK=0
SETUP_TS=0
for arg in "$@"; do
  case "$arg" in
    --rollback)        ROLLBACK=1 ;;
    --setup-treesitter) SETUP_TS=1 ;;
  esac
done

if [[ ! -d "$PLUGIN_CACHE" ]]; then
  echo "ERROR: plugin cache not found at $PLUGIN_CACHE" >&2
  exit 2
fi

if [[ "$ROLLBACK" -eq 1 ]]; then
  echo "[install] rolling back hooks.json + codex-hooks.json"
  bun "$SRC/plugin-hook-perf-patch.v2.mjs" --rollback "$PLUGIN_CACHE/hooks/hooks.json" || true
  bun "$SRC/plugin-hook-perf-patch.v2.mjs" --rollback "$PLUGIN_CACHE/hooks/codex-hooks.json" || true
  echo "[install] removing daemon-server.mjs + hook-client.mjs (keeping setup-tree-sitter.mjs)"
  rm -f "$PLUGIN_CACHE/scripts/daemon-server.mjs"
  rm -f "$PLUGIN_CACHE/scripts/hook-client.mjs"
  echo "[install] killing UDS daemons (if any)"
  pkill -f 'daemon-server.mjs' 2>/dev/null || true
  echo "[install] DONE — restart Claude Code to pick up the original hooks."
  exit 0
fi

echo "[install] copying new scripts → $PLUGIN_CACHE/scripts/"
cp "$SRC/daemon-server.mjs"       "$PLUGIN_CACHE/scripts/daemon-server.mjs"
cp "$SRC/hook-client.mjs"         "$PLUGIN_CACHE/scripts/hook-client.mjs"
cp "$SRC/setup-tree-sitter.mjs"   "$PLUGIN_CACHE/scripts/setup-tree-sitter.mjs"
chmod +x "$PLUGIN_CACHE/scripts/daemon-server.mjs" \
         "$PLUGIN_CACHE/scripts/hook-client.mjs" \
         "$PLUGIN_CACHE/scripts/setup-tree-sitter.mjs"

echo "[install] patching hooks.json → UDS"
bun "$SRC/plugin-hook-perf-patch.v2.mjs" --target "$PLUGIN_CACHE/hooks/hooks.json" --apply-uds

echo "[install] cleaning + patching codex-hooks.json"
bun "$SRC/plugin-hook-perf-patch.v2.mjs" --target "$PLUGIN_CACHE/hooks/codex-hooks.json" --apply-codex-cleanup --apply-uds

if [[ "$SETUP_TS" -eq 1 ]]; then
  echo "[install] running tree-sitter setup (npm install)"
  bun "$PLUGIN_CACHE/scripts/setup-tree-sitter.mjs"
fi

echo "[install] stopping legacy worker-service daemon (will be replaced on first hook by UDS daemon)"
pkill -f 'worker-service.cjs --daemon' 2>/dev/null || true
pkill -f 'worker-service.cjs start' 2>/dev/null || true

echo
echo "[install] DONE."
echo "  Restart Claude Code to pick up the new hooks."
echo "  Validate via: bun $SRC/../tests/perf-probe-new.mjs"
echo "  Rollback via: bash $0 --rollback"
