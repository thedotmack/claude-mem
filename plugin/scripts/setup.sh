#!/usr/bin/env bash
#
# claude-mem Setup Hook
# Ensures data directory exists and binary is executable
#

set -euo pipefail

# Use CLAUDE_PLUGIN_ROOT if available, otherwise detect from script location
if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ROOT="$(dirname "$SCRIPT_DIR")"
else
  ROOT="$CLAUDE_PLUGIN_ROOT"
fi

BINARY="$ROOT/scripts/claude-mem"
DATA_DIR="$HOME/.claude-mem"

# Colors (when terminal supports it)
if [[ -t 2 ]]; then
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  NC='\033[0m'
else
  GREEN='' YELLOW='' NC=''
fi

log_ok()   { echo -e "${GREEN}✓${NC} $*" >&2; }
log_warn() { echo -e "${YELLOW}⚠${NC} $*" >&2; }

# 1. Create data directory
if [[ ! -d "$DATA_DIR" ]]; then
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  log_ok "Created data directory: $DATA_DIR"
fi

# 2. Ensure binary is executable
if [[ -f "$BINARY" ]]; then
  chmod +x "$BINARY"
else
  log_warn "Binary not found at $BINARY — build required"
fi

exit 0
