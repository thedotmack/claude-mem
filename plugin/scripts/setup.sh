#!/usr/bin/env bash
#
# claude-mem Setup Hook
# Ensures dependencies are installed before plugin runs
#

set -euo pipefail

# Use CLAUDE_PLUGIN_ROOT if available, otherwise detect from script location
if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ROOT="$(dirname "$SCRIPT_DIR")"
else
  ROOT="$CLAUDE_PLUGIN_ROOT"
fi

MARKER="$ROOT/.install-version"
PKG_JSON="$ROOT/package.json"

# Colors (when terminal supports it)
if [[ -t 2 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  NC='\033[0m' # No Color
else
  RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

log_info()  { echo -e "${BLUE}ℹ${NC} $*" >&2; }
log_ok()    { echo -e "${GREEN}✓${NC} $*" >&2; }
log_warn()  { echo -e "${YELLOW}⚠${NC} $*" >&2; }
log_error() { echo -e "${RED}✗${NC} $*" >&2; }

#
# Detect Bun - check PATH and common locations
#
find_bun() {
  # Try PATH first
  if command -v bun &>/dev/null; then
    echo "bun"
    return 0
  fi
  
  # Check common install locations
  local paths=(
    "$HOME/.bun/bin/bun"
    "/usr/local/bin/bun"
    "/opt/homebrew/bin/bun"
  )
  
  for p in "${paths[@]}"; do
    if [[ -x "$p" ]]; then
      echo "$p"
      return 0
    fi
  done
  
  return 1
}

#
# Detect uv - check PATH and common locations
#
find_uv() {
  # Try PATH first
  if command -v uv &>/dev/null; then
    echo "uv"
    return 0
  fi
  
  # Check common install locations
  local paths=(
    "$HOME/.local/bin/uv"
    "$HOME/.cargo/bin/uv"
    "/usr/local/bin/uv"
    "/opt/homebrew/bin/uv"
  )
  
  for p in "${paths[@]}"; do
    if [[ -x "$p" ]]; then
      echo "$p"
      return 0
    fi
  done
  
  return 1
}

#
# Get package.json version
#
get_pkg_version() {
  if [[ -f "$PKG_JSON" ]]; then
    # Simple grep-based extraction (no jq dependency)
    grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$PKG_JSON" | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
  fi
}

#
# Get marker version (if exists)
#
get_marker_version() {
  if [[ -f "$MARKER" ]]; then
    grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$MARKER" | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
  fi
}

#
# Get marker's recorded bun version
#
get_marker_bun() {
  if [[ -f "$MARKER" ]]; then
    grep -o '"bun"[[:space:]]*:[[:space:]]*"[^"]*"' "$MARKER" | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
  fi
}

#
# Check if install is needed
#
needs_install() {
  # No node_modules? Definitely need install
  if [[ ! -d "$ROOT/node_modules" ]]; then
    return 0
  fi
  
  # No marker? Need install
  if [[ ! -f "$MARKER" ]]; then
    return 0
  fi
  
  local pkg_ver marker_ver bun_ver marker_bun
  pkg_ver=$(get_pkg_version)
  marker_ver=$(get_marker_version)
  
  # Version mismatch? Need install
  if [[ "$pkg_ver" != "$marker_ver" ]]; then
    return 0
  fi
  
  # Bun version changed? Need install
  if BUN_PATH=$(find_bun); then
    bun_ver=$("$BUN_PATH" --version 2>/dev/null || echo "")
    marker_bun=$(get_marker_bun)
    if [[ -n "$bun_ver" && "$bun_ver" != "$marker_bun" ]]; then
      return 0
    fi
  fi
  
  # All good, no install needed
  return 1
}

#
# Write version marker after successful install
#
write_marker() {
  local bun_ver uv_ver pkg_ver
  pkg_ver=$(get_pkg_version)
  bun_ver=$("$BUN_PATH" --version 2>/dev/null || echo "unknown")
  
  if UV_PATH=$(find_uv); then
    uv_ver=$("$UV_PATH" --version 2>/dev/null | head -1 || echo "unknown")
  else
    uv_ver="not-installed"
  fi
  
  cat > "$MARKER" <<EOF
{
  "version": "$pkg_ver",
  "bun": "$bun_ver",
  "uv": "$uv_ver",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
}

#
# Main
#

# 1. Check for Bun
BUN_PATH=$(find_bun) || true
if [[ -z "$BUN_PATH" ]]; then
  log_error "Bun runtime not found!"
  echo "" >&2
  echo "claude-mem requires Bun to run. Please install it:" >&2
  echo "" >&2
  echo "  curl -fsSL https://bun.sh/install | bash" >&2
  echo "" >&2
  echo "Or on macOS with Homebrew:" >&2
  echo "" >&2
  echo "  brew install oven-sh/bun/bun" >&2
  echo "" >&2
  echo "Then restart your terminal and try again." >&2
  exit 1
fi

BUN_VERSION=$("$BUN_PATH" --version 2>/dev/null || echo "unknown")
log_ok "Bun $BUN_VERSION found at $BUN_PATH"

# 2. Check for uv (optional - for Python/Chroma support)
UV_PATH=$(find_uv) || true
if [[ -z "$UV_PATH" ]]; then
  log_warn "uv not found (optional - needed for Python/Chroma vector search)"
  echo "  To install: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
else
  UV_VERSION=$("$UV_PATH" --version 2>/dev/null | head -1 || echo "unknown")
  log_ok "uv $UV_VERSION found"
fi

# 3. Install dependencies if needed
if needs_install; then
  log_info "Installing dependencies with Bun..."
  
  if ! "$BUN_PATH" install --cwd "$ROOT"; then
    log_error "Failed to install dependencies"
    exit 1
  fi
  
  write_marker
  log_ok "Dependencies installed ($(get_pkg_version))"
else
  log_ok "Dependencies up to date ($(get_marker_version))"
fi

exit 0
