#!/usr/bin/env bash
# Stop hook wrapper: resolves plugin root without CLAUDE_PLUGIN_ROOT.
# Claude Code does not inject CLAUDE_PLUGIN_ROOT for Stop hook contexts.
# setup.sh copies this file to ~/.claude-mem/stop-hook.sh and writes the
# resolved root to ~/.claude-mem/.plugin-root for fallback use here.
ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [[ -z "$ROOT" ]]; then
  STORED="${CLAUDE_MEM_DATA_DIR:-$HOME/.claude-mem}/.plugin-root"
  [[ -f "$STORED" ]] && ROOT="$(cat "$STORED")"
fi
[[ -z "$ROOT" ]] && { echo "stop-hook: plugin root unresolvable" >&2; exit 0; }
exec node "$ROOT/scripts/bun-runner.js" "$ROOT/scripts/worker-service.cjs" "$@"
