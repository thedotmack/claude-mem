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
# OpenClaw gateway detection
###############################################################################

OPENCLAW_PATH=""

find_openclaw() {
  # Try PATH first
  if command -v openclaw.mjs &>/dev/null; then
    OPENCLAW_PATH="$(command -v openclaw.mjs)"
    return 0
  fi

  # Check common installation paths
  local -a openclaw_paths=(
    "${HOME}/.openclaw/openclaw.mjs"
    "/usr/local/bin/openclaw.mjs"
    "/usr/local/lib/node_modules/openclaw/openclaw.mjs"
    "${HOME}/.npm-global/lib/node_modules/openclaw/openclaw.mjs"
  )

  # Also check for node_modules in common project locations
  if [[ -n "${NODE_PATH:-}" ]]; then
    openclaw_paths+=("${NODE_PATH}/openclaw/openclaw.mjs")
  fi

  for candidate in "${openclaw_paths[@]}"; do
    if [[ -f "$candidate" ]]; then
      OPENCLAW_PATH="$candidate"
      return 0
    fi
  done

  OPENCLAW_PATH=""
  return 1
}

check_openclaw() {
  if ! find_openclaw; then
    error "OpenClaw gateway not found"
    error ""
    error "The claude-mem plugin requires an OpenClaw gateway to be installed."
    error "Please install OpenClaw first:"
    error ""
    error "  npm install -g openclaw"
    error "  # or visit: https://openclaw.dev/docs/installation"
    error ""
    error "Then re-run this installer."
    exit 1
  fi

  success "OpenClaw gateway found at ${OPENCLAW_PATH}"
}

###############################################################################
# Plugin installation — clone, build, install, enable
# Flow based on openclaw/Dockerfile.e2e
###############################################################################

CLAUDE_MEM_REPO="https://github.com/thedotmack/claude-mem.git"

install_plugin() {
  local build_dir
  build_dir="$(mktemp -d)"

  # Ensure cleanup on exit from this function
  cleanup_build_dir() {
    if [[ -d "$build_dir" ]]; then
      rm -rf "$build_dir"
    fi
  }
  trap cleanup_build_dir EXIT

  info "Cloning claude-mem repository..."
  if ! git clone --depth 1 "$CLAUDE_MEM_REPO" "$build_dir/claude-mem" 2>&1; then
    error "Failed to clone claude-mem repository"
    error "Check your internet connection and try again."
    cleanup_build_dir
    exit 1
  fi

  local plugin_src="${build_dir}/claude-mem/openclaw"

  # Build the TypeScript plugin
  info "Building TypeScript plugin..."
  if ! (cd "$plugin_src" && NODE_ENV=development npm install --ignore-scripts 2>&1 && npx tsc 2>&1); then
    error "Failed to build the claude-mem OpenClaw plugin"
    error "Make sure Node.js and npm are installed."
    cleanup_build_dir
    exit 1
  fi

  # Create minimal installable package (matches Dockerfile.e2e pattern)
  local installable_dir="${build_dir}/claude-mem-installable"
  mkdir -p "${installable_dir}/dist"

  cp "${plugin_src}/dist/index.js" "${installable_dir}/dist/"
  cp "${plugin_src}/dist/index.d.ts" "${installable_dir}/dist/" 2>/dev/null || true
  cp "${plugin_src}/openclaw.plugin.json" "${installable_dir}/"

  # Generate the installable package.json with openclaw.extensions field
  node -e "
    const pkg = {
      name: 'claude-mem',
      version: '1.0.0',
      type: 'module',
      main: 'dist/index.js',
      openclaw: { extensions: ['./dist/index.js'] }
    };
    require('fs').writeFileSync('${installable_dir}/package.json', JSON.stringify(pkg, null, 2));
  "

  # Install the plugin using OpenClaw's CLI
  info "Installing claude-mem plugin into OpenClaw..."
  if ! node "$OPENCLAW_PATH" plugins install "$installable_dir" 2>&1; then
    error "Failed to install claude-mem plugin"
    error "Try manually: node ${OPENCLAW_PATH} plugins install <path>"
    cleanup_build_dir
    exit 1
  fi

  # Enable the plugin
  info "Enabling claude-mem plugin..."
  if ! node "$OPENCLAW_PATH" plugins enable claude-mem 2>&1; then
    error "Failed to enable claude-mem plugin"
    error "Try manually: node ${OPENCLAW_PATH} plugins enable claude-mem"
    cleanup_build_dir
    exit 1
  fi

  cleanup_build_dir
  trap - EXIT
  success "claude-mem plugin installed and enabled"
}

###############################################################################
# Memory slot configuration
# Sets plugins.slots.memory = "claude-mem" in ~/.openclaw/openclaw.json
###############################################################################

configure_memory_slot() {
  local config_dir="${HOME}/.openclaw"
  local config_file="${config_dir}/openclaw.json"

  mkdir -p "$config_dir"

  if [[ ! -f "$config_file" ]]; then
    # No config file exists — create one with the memory slot
    info "Creating OpenClaw configuration with claude-mem memory slot..."
    node -e "
      const config = {
        plugins: {
          slots: { memory: 'claude-mem' },
          entries: {
            'claude-mem': {
              enabled: true,
              config: {
                workerPort: 37777,
                syncMemoryFile: true
              }
            }
          }
        }
      };
      require('fs').writeFileSync('${config_file}', JSON.stringify(config, null, 2));
    "
    success "Created ${config_file} with memory slot set to claude-mem"
    return 0
  fi

  # Config file exists — update it to set the memory slot
  info "Updating OpenClaw configuration to use claude-mem memory slot..."

  # Use node for reliable JSON manipulation
  node -e "
    const fs = require('fs');
    const config = JSON.parse(fs.readFileSync('${config_file}', 'utf8'));

    // Ensure plugins structure exists
    if (!config.plugins) config.plugins = {};
    if (!config.plugins.slots) config.plugins.slots = {};
    if (!config.plugins.entries) config.plugins.entries = {};

    // Set memory slot to claude-mem
    config.plugins.slots.memory = 'claude-mem';

    // Ensure claude-mem entry exists and is enabled
    if (!config.plugins.entries['claude-mem']) {
      config.plugins.entries['claude-mem'] = {
        enabled: true,
        config: {
          workerPort: 37777,
          syncMemoryFile: true
        }
      };
    } else {
      config.plugins.entries['claude-mem'].enabled = true;
    }

    fs.writeFileSync('${config_file}', JSON.stringify(config, null, 2));
  "

  success "Memory slot set to claude-mem in ${config_file}"
}

###############################################################################
# Main
###############################################################################

main() {
  print_banner
  detect_platform

  # --- Step 1: Dependencies ---
  echo ""
  info "Checking dependencies..."
  echo ""

  if ! check_bun; then
    install_bun
  fi

  if ! check_uv; then
    install_uv
  fi

  echo ""
  success "All dependencies satisfied"

  # --- Step 2: OpenClaw gateway ---
  echo ""
  info "Locating OpenClaw gateway..."
  check_openclaw

  # --- Step 3: Plugin installation ---
  echo ""
  info "Installing claude-mem plugin..."
  install_plugin

  # --- Step 4: Memory slot configuration ---
  echo ""
  info "Configuring memory slot..."
  configure_memory_slot

  echo ""
  success "OpenClaw gateway detection and plugin installation complete"
}

main "$@"
