#!/bin/bash
set -euo pipefail

# claude-mem installer bootstrap
# Usage: curl -fsSL https://install.cmem.ai | bash
#   or:  curl -fsSL https://install.cmem.ai | bash -s -- --provider=gemini --api-key=YOUR_KEY

INSTALLER_URL="https://install.cmem.ai/installer.js"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

error() { echo -e "${RED}Error: $1${NC}" >&2; exit 1; }
info() { echo -e "${CYAN}$1${NC}"; }

# Check Node.js
if ! command -v node &> /dev/null; then
  error "Node.js is required but not found. Install from https://nodejs.org"
fi

NODE_VERSION=$(node -v | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  error "Node.js >= 18 required. Current: v${NODE_VERSION}"
fi

info "claude-mem installer (Node.js v${NODE_VERSION})"

# Create temp file for installer
TMPFILE=$(mktemp "${TMPDIR:-/tmp}/claude-mem-installer.XXXXXX.mjs")

# Cleanup on exit
cleanup() {
  rm -f "$TMPFILE"
}
trap cleanup EXIT INT TERM

# Download installer
info "Downloading installer..."
if command -v curl &> /dev/null; then
  curl -fsSL "$INSTALLER_URL" -o "$TMPFILE"
elif command -v wget &> /dev/null; then
  wget -q "$INSTALLER_URL" -O "$TMPFILE"
else
  error "curl or wget required to download installer"
fi

# Run installer with TTY access
# When piped (curl | bash), stdin is the script. We need to reconnect to the terminal.
if [ -t 0 ]; then
  # Already have TTY (script was downloaded and run directly)
  node "$TMPFILE" "$@"
else
  # Piped execution -- reconnect stdin to terminal
  node "$TMPFILE" "$@" </dev/tty
fi
