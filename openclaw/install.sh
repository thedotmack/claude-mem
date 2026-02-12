#!/usr/bin/env bash
set -euo pipefail

# claude-mem OpenClaw Plugin Installer
# Installs the claude-mem persistent memory plugin for OpenClaw gateways.
# Usage: bash install.sh [--non-interactive]

###############################################################################
# Constants
###############################################################################

readonly MIN_BUN_VERSION="1.1.14"
readonly INSTALLER_VERSION="1.0.0"
readonly NON_INTERACTIVE="${1:-}"

###############################################################################
# Color utilities — auto-detect terminal color support
###############################################################################

if [[ -t 1 ]] && [[ "${TERM:-}" != "dumb" ]]; then
  readonly COLOR_RED='\033[0;31m'
  readonly COLOR_GREEN='\033[0;32m'
  readonly COLOR_YELLOW='\033[0;33m'
  readonly COLOR_BLUE='\033[0;34m'
  readonly COLOR_MAGENTA='\033[0;35m'
  readonly COLOR_CYAN='\033[0;36m'
  readonly COLOR_BOLD='\033[1m'
  readonly COLOR_RESET='\033[0m'
else
  readonly COLOR_RED=''
  readonly COLOR_GREEN=''
  readonly COLOR_YELLOW=''
  readonly COLOR_BLUE=''
  readonly COLOR_MAGENTA=''
  readonly COLOR_CYAN=''
  readonly COLOR_BOLD=''
  readonly COLOR_RESET=''
fi

info()    { echo -e "${COLOR_BLUE}ℹ${COLOR_RESET}  $*"; }
success() { echo -e "${COLOR_GREEN}✓${COLOR_RESET}  $*"; }
warn()    { echo -e "${COLOR_YELLOW}⚠${COLOR_RESET}  $*"; }
error()   { echo -e "${COLOR_RED}✗${COLOR_RESET}  $*" >&2; }

prompt_user() {
  if [[ "$NON_INTERACTIVE" == "--non-interactive" ]]; then
    error "Cannot prompt in non-interactive mode: $*"
    return 1
  fi
  if [[ ! -t 0 ]]; then
    error "Cannot prompt when stdin is not a terminal: $*"
    return 1
  fi
  echo -en "${COLOR_CYAN}?${COLOR_RESET}  $* "
}

###############################################################################
# Banner
###############################################################################

print_banner() {
  echo -e "${COLOR_MAGENTA}${COLOR_BOLD}"
  cat << 'BANNER'
   ┌─────────────────────────────────────────┐
   │    claude-mem  ×  OpenClaw              │
   │    Persistent Memory Plugin Installer   │
   └─────────────────────────────────────────┘
BANNER
  echo -e "${COLOR_RESET}"
  info "Installer v${INSTALLER_VERSION}"
  echo ""
}

###############################################################################
# Platform detection
###############################################################################

PLATFORM=""
IS_WSL=false

detect_platform() {
  local uname_out
  uname_out="$(uname -s)"

  case "${uname_out}" in
    Darwin*)
      PLATFORM="macos"
      ;;
    Linux*)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        PLATFORM="linux"
        IS_WSL=true
      else
        PLATFORM="linux"
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*)
      PLATFORM="windows"
      ;;
    *)
      error "Unsupported platform: ${uname_out}"
      exit 1
      ;;
  esac

  info "Detected platform: ${PLATFORM}${IS_WSL:+ (WSL)}"
}

###############################################################################
# Version comparison — returns 0 if $1 >= $2
###############################################################################

version_gte() {
  local v1="$1" v2="$2"
  local -a parts1 parts2
  IFS='.' read -ra parts1 <<< "$v1"
  IFS='.' read -ra parts2 <<< "$v2"

  for i in 0 1 2; do
    local p1="${parts1[$i]:-0}"
    local p2="${parts2[$i]:-0}"
    if (( p1 > p2 )); then return 0; fi
    if (( p1 < p2 )); then return 1; fi
  done
  return 0
}

###############################################################################
# Bun detection and installation
# Translated from plugin/scripts/smart-install.js patterns
###############################################################################

BUN_PATH=""

find_bun_path() {
  # Try PATH first
  if command -v bun &>/dev/null; then
    BUN_PATH="$(command -v bun)"
    return 0
  fi

  # Check common installation paths (handles fresh installs before PATH reload)
  local -a bun_paths=(
    "${HOME}/.bun/bin/bun"
    "/usr/local/bin/bun"
    "/opt/homebrew/bin/bun"
  )

  for candidate in "${bun_paths[@]}"; do
    if [[ -x "$candidate" ]]; then
      BUN_PATH="$candidate"
      return 0
    fi
  done

  BUN_PATH=""
  return 1
}

check_bun() {
  if ! find_bun_path; then
    return 1
  fi

  # Verify minimum version
  local bun_version
  bun_version="$("$BUN_PATH" --version 2>/dev/null)" || return 1

  if version_gte "$bun_version" "$MIN_BUN_VERSION"; then
    success "Bun ${bun_version} found at ${BUN_PATH}"
    return 0
  else
    warn "Bun ${bun_version} is below minimum required version ${MIN_BUN_VERSION}"
    return 1
  fi
}

install_bun() {
  info "Installing Bun runtime..."

  if ! curl -fsSL https://bun.sh/install | bash; then
    error "Failed to install Bun automatically"
    error "Please install manually:"
    error "  curl -fsSL https://bun.sh/install | bash"
    error "  Or: brew install oven-sh/bun/bun (macOS)"
    error "Then restart your terminal and re-run this installer."
    exit 1
  fi

  # Re-detect after install (installer may have placed it in ~/.bun/bin)
  if ! find_bun_path; then
    error "Bun installation completed but binary not found in expected locations"
    error "Please restart your terminal and re-run this installer."
    exit 1
  fi

  local bun_version
  bun_version="$("$BUN_PATH" --version 2>/dev/null)" || true
  success "Bun ${bun_version} installed at ${BUN_PATH}"
}

###############################################################################
# uv detection and installation
# Translated from plugin/scripts/smart-install.js patterns
###############################################################################

UV_PATH=""

find_uv_path() {
  # Try PATH first
  if command -v uv &>/dev/null; then
    UV_PATH="$(command -v uv)"
    return 0
  fi

  # Check common installation paths (handles fresh installs before PATH reload)
  local -a uv_paths=(
    "${HOME}/.local/bin/uv"
    "${HOME}/.cargo/bin/uv"
    "/usr/local/bin/uv"
    "/opt/homebrew/bin/uv"
  )

  for candidate in "${uv_paths[@]}"; do
    if [[ -x "$candidate" ]]; then
      UV_PATH="$candidate"
      return 0
    fi
  done

  UV_PATH=""
  return 1
}

check_uv() {
  if ! find_uv_path; then
    return 1
  fi

  local uv_version
  uv_version="$("$UV_PATH" --version 2>/dev/null)" || return 1
  success "uv ${uv_version} found at ${UV_PATH}"
  return 0
}

install_uv() {
  info "Installing uv (Python package manager for Chroma support)..."

  if ! curl -LsSf https://astral.sh/uv/install.sh | sh; then
    error "Failed to install uv automatically"
    error "Please install manually:"
    error "  curl -LsSf https://astral.sh/uv/install.sh | sh"
    error "  Or: brew install uv (macOS)"
    error "Then restart your terminal and re-run this installer."
    exit 1
  fi

  # Re-detect after install
  if ! find_uv_path; then
    error "uv installation completed but binary not found in expected locations"
    error "Please restart your terminal and re-run this installer."
    exit 1
  fi

  local uv_version
  uv_version="$("$UV_PATH" --version 2>/dev/null)" || true
  success "uv ${uv_version} installed at ${UV_PATH}"
}

###############################################################################
# Main
###############################################################################

main() {
  print_banner
  detect_platform

  # --- Step 1: Bun ---
  echo ""
  info "Checking dependencies..."
  echo ""

  if ! check_bun; then
    install_bun
  fi

  # --- Step 2: uv ---
  if ! check_uv; then
    install_uv
  fi

  echo ""
  success "All dependencies satisfied"
}

main "$@"
