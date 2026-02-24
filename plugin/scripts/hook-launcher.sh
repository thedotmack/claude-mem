#!/usr/bin/env bash
#
# claude-mem Hook Launcher
#
# Resolves the plugin root without depending on ${CLAUDE_PLUGIN_ROOT} being
# injected by Claude Code's hook executor. Works around:
#   - anthropics/claude-code#24529 (all hooks on Linux)
#   - thedotmack/claude-mem#1215 (Stop hooks on macOS)
#
# Usage (from hooks.json):
#   bash "$HOME/.claude-mem/hook-launcher.sh" start
#   bash "$HOME/.claude-mem/hook-launcher.sh" hook claude-code context
#   bash "$HOME/.claude-mem/hook-launcher.sh" smart-install
#

set -euo pipefail

# 1. Use CLAUDE_PLUGIN_ROOT if Claude Code set it (forward-compatible)
ROOT="${CLAUDE_PLUGIN_ROOT:-}"

# 2. Fall back to .plugin-root written by setup.sh
if [[ -z "$ROOT" ]]; then
  ROOTFILE="${CLAUDE_MEM_DATA_DIR:-$HOME/.claude-mem}/.plugin-root"
  if [[ -f "$ROOTFILE" ]]; then
    ROOT="$(head -1 "$ROOTFILE" | tr -d '[:space:]')"
  fi
fi

# 3. Cannot resolve — exit gracefully (non-blocking)
if [[ -z "$ROOT" || ! -d "$ROOT" ]]; then
  exit 0
fi

export CLAUDE_PLUGIN_ROOT="$ROOT"

case "${1:-}" in
  smart-install)
    exec node "$ROOT/scripts/smart-install.js"
    ;;
  *)
    exec node "$ROOT/scripts/bun-runner.js" "$ROOT/scripts/worker-service.cjs" "$@"
    ;;
esac
