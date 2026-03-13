#!/bin/sh
# bun-exec-runner.sh - Avoid grandchild SIGKILL in Claude Code sandbox (#1249)
#
# Problem: Claude Code sandbox kills bun when spawned as node→bun grandchild.
# Solution: Find bun and `exec` it directly, replacing this shell process so
# bun becomes a direct child of Claude Code instead of a grandchild.
#
# On Linux, falls back to node bun-runner.js for stdin pipe compatibility (#646).

# Resolve directory of this script (works with symlinks)
_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"

# Find bun: check PATH first, then common install locations
_find_bun() {
  _B="$(command -v bun 2>/dev/null)" && [ -n "$_B" ] && echo "$_B" && return
  [ -x "$HOME/.bun/bin/bun" ] && echo "$HOME/.bun/bin/bun" && return
  [ -x "/opt/homebrew/bin/bun" ] && echo "/opt/homebrew/bin/bun" && return
  [ -x "/usr/local/bin/bun" ] && echo "/usr/local/bin/bun" && return
  [ -x "/home/linuxbrew/.linuxbrew/bin/bun" ] && echo "/home/linuxbrew/.linuxbrew/bin/bun" && return
  echo ""
}

_OS="$(uname 2>/dev/null)"

# macOS: exec bun directly to avoid sandbox SIGKILL on grandchild process (#1249)
# Linux: skip exec path — Bun has pipe fd compatibility issues with Claude Code stdin (#646)
if [ "$_OS" = "Darwin" ]; then
  _BUN="$(_find_bun)"
  if [ -n "$_BUN" ]; then
    exec "$_BUN" "$@"
  fi
fi

# Fallback: use node bun-runner.js (handles stdin buffering for Linux #646,
# and handles case where bun is not yet installed on macOS)
exec node "$_DIR/bun-runner.js" "$@"
