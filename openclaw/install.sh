#!/usr/bin/env bash
set -euo pipefail

# claude-mem OpenClaw Plugin Installer
# Installs the claude-mem persistent memory plugin for OpenClaw gateways.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/thedotmack/claude-mem/main/openclaw/install.sh | bash
#   # Or with options:
#   curl -fsSL https://raw.githubusercontent.com/thedotmack/claude-mem/main/openclaw/install.sh | bash -s -- --provider=gemini --api-key=YOUR_KEY
#   # Direct execution:
#   bash install.sh [--non-interactive] [--upgrade] [--provider=claude|gemini|openrouter] [--api-key=KEY]

###############################################################################
# Constants
###############################################################################

readonly MIN_BUN_VERSION="1.1.14"
readonly INSTALLER_VERSION="1.0.0"

###############################################################################
# Argument parsing
###############################################################################

NON_INTERACTIVE=""
CLI_PROVIDER=""
CLI_API_KEY=""
UPGRADE_MODE=""
CLI_BRANCH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive)
      NON_INTERACTIVE="true"
      shift
      ;;
    --upgrade)
      UPGRADE_MODE="true"
      shift
      ;;
    --branch=*)
      CLI_BRANCH="${1#--branch=}"
      shift
      ;;
    --branch)
      CLI_BRANCH="${2:-}"
      shift 2
      ;;
    --provider=*)
      CLI_PROVIDER="${1#--provider=}"
      shift
      ;;
    --provider)
      CLI_PROVIDER="${2:-}"
      shift 2
      ;;
    --api-key=*)
      CLI_API_KEY="${1#--api-key=}"
      shift
      ;;
    --api-key)
      CLI_API_KEY="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

###############################################################################
# TTY detection — ensure interactive prompts work under curl | bash
# When piped, stdin reads from curl's output, not the terminal.
# We open /dev/tty on fd 3 and read interactive input from there.
###############################################################################

TTY_FD=0

setup_tty() {
  if [[ -t 0 ]]; then
    # stdin IS a terminal — use it directly
    TTY_FD=0
  elif [[ -e /dev/tty ]]; then
    # stdin is piped (curl | bash) but /dev/tty is available
    exec 3</dev/tty
    TTY_FD=3
  else
    # No terminal available at all
    if [[ "$NON_INTERACTIVE" != "true" ]]; then
      echo "Error: No terminal available for interactive prompts." >&2
      echo "Use --non-interactive or run directly: bash install.sh" >&2
      exit 1
    fi
  fi
}

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
  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    error "Cannot prompt in non-interactive mode: $*"
    return 1
  fi
  echo -en "${COLOR_CYAN}?${COLOR_RESET}  $* "
}

# Read a line from the terminal (works even when stdin is piped from curl)
# Callers always pass -r via $@; shellcheck can't see through the delegation
read_tty() {
  # shellcheck disable=SC2162
  read "$@" <&"$TTY_FD"
}

###############################################################################
# Global cleanup trap — removes temp directories on unexpected exit
###############################################################################

CLEANUP_DIRS=()

register_cleanup_dir() {
  CLEANUP_DIRS+=("$1")
}

cleanup_on_exit() {
  local exit_code=$?
  for dir in "${CLEANUP_DIRS[@]+"${CLEANUP_DIRS[@]}"}"; do
    if [[ -d "$dir" ]]; then
      rm -rf "$dir"
    fi
  done
  if [[ $exit_code -ne 0 ]]; then
    echo "" >&2
    error "Installation failed (exit code: ${exit_code})"
    error "Any temporary files have been cleaned up."
    error "Fix the issue above and re-run the installer."
  fi
}

trap cleanup_on_exit EXIT

###############################################################################
# Prerequisite checks
###############################################################################

check_git() {
  if command -v git &>/dev/null; then
    return 0
  fi

  error "git is not installed"
  echo "" >&2
  case "${PLATFORM:-}" in
    macos)
      error "Install git on macOS with:"
      error "  xcode-select --install"
      error "  # or: brew install git"
      ;;
    linux)
      error "Install git on Linux with:"
      error "  sudo apt install git        # Debian/Ubuntu"
      error "  sudo dnf install git        # Fedora/RHEL"
      error "  sudo pacman -S git          # Arch"
      ;;
    *)
      error "Please install git and re-run this installer."
      ;;
  esac
  exit 1
}

###############################################################################
# Port conflict detection — check if port 37777 is already in use
###############################################################################

check_port_37777() {
  local port_in_use=""

  # Try lsof first (macOS/Linux)
  if command -v lsof &>/dev/null; then
    if lsof -i :37777 -sTCP:LISTEN &>/dev/null; then
      port_in_use="true"
    fi
  # Fallback to ss (Linux)
  elif command -v ss &>/dev/null; then
    if ss -tlnp 2>/dev/null | grep -q ':37777 '; then
      port_in_use="true"
    fi
  # Fallback to curl probe
  elif command -v curl &>/dev/null; then
    local response
    response="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:37777/api/health" 2>/dev/null)" || true
    if [[ "$response" == "200" ]]; then
      port_in_use="true"
    fi
  fi

  if [[ "$port_in_use" == "true" ]]; then
    return 0  # port IS in use
  fi
  return 1  # port is free
}

###############################################################################
# Upgrade detection — check if claude-mem is already installed
###############################################################################

is_claude_mem_installed() {
  # Check if the plugin directory exists with the worker script
  if find_claude_mem_install_dir 2>/dev/null; then
    return 0
  fi
  return 1
}

###############################################################################
# JSON manipulation helper — jq with python3/node fallback
# Usage: ensure_jq_or_fallback <json_file> <jq_filter> [jq_args...]
# For simple read operations, returns the result on stdout.
# For write operations, updates the file in-place.
###############################################################################

ensure_jq_or_fallback() {
  local json_file="$1"
  shift
  local jq_filter="$1"
  shift
  # remaining args are passed as jq --arg pairs

  if command -v jq &>/dev/null; then
    local tmp_file
    tmp_file="$(mktemp)"
    jq "$@" "$jq_filter" "$json_file" > "$tmp_file" && mv "$tmp_file" "$json_file"
    return $?
  fi

  if command -v python3 &>/dev/null; then
    # For complex jq filters, fall back to node instead
    # Python is used only for simple operations
    :
  fi

  # Fallback to node (always available — it's a dependency)
  # This is a passthrough; callers that need node-specific logic
  # should use node -e directly. This function is for jq compatibility.
  warn "jq not found — using node for JSON manipulation"
  return 1
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
IS_WSL=""

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
        IS_WSL="true"
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
  # Try PATH first — check both "openclaw" and "openclaw.mjs" binary names
  for bin_name in openclaw openclaw.mjs; do
    if command -v "$bin_name" &>/dev/null; then
      OPENCLAW_PATH="$(command -v "$bin_name")"
      return 0
    fi
  done

  # Check common installation paths
  local -a openclaw_paths=(
    "${HOME}/.openclaw/openclaw.mjs"
    "/usr/local/bin/openclaw.mjs"
    "/usr/local/bin/openclaw"
    "/usr/local/lib/node_modules/openclaw/openclaw.mjs"
    "${HOME}/.npm-global/lib/node_modules/openclaw/openclaw.mjs"
    "${HOME}/.npm-global/bin/openclaw"
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

# Run openclaw command — uses node for .mjs files, direct execution otherwise
run_openclaw() {
  if [[ "$OPENCLAW_PATH" == *.mjs ]]; then
    node "$OPENCLAW_PATH" "$@"
  else
    "$OPENCLAW_PATH" "$@"
  fi
}

###############################################################################
# Plugin installation — clone, build, install, enable
# Flow based on openclaw/Dockerfile.e2e
###############################################################################

CLAUDE_MEM_REPO="https://github.com/thedotmack/claude-mem.git"
CLAUDE_MEM_BRANCH="${CLI_BRANCH:-main}"

install_plugin() {
  # Check for git before attempting clone
  check_git

  # Remove existing plugin installation to allow clean re-install
  local existing_plugin_dir="${HOME}/.openclaw/extensions/claude-mem"
  if [[ -d "$existing_plugin_dir" ]]; then
    info "Removing existing claude-mem plugin at ${existing_plugin_dir}..."
    rm -rf "$existing_plugin_dir"
  fi

  local build_dir
  build_dir="$(mktemp -d)"
  register_cleanup_dir "$build_dir"

  info "Cloning claude-mem repository (branch: ${CLAUDE_MEM_BRANCH})..."
  if ! git clone --depth 1 --branch "$CLAUDE_MEM_BRANCH" "$CLAUDE_MEM_REPO" "$build_dir/claude-mem" 2>&1; then
    error "Failed to clone claude-mem repository"
    error "Check your internet connection and try again."
    exit 1
  fi

  local plugin_src="${build_dir}/claude-mem/openclaw"

  # Build the TypeScript plugin
  info "Building TypeScript plugin..."
  if ! (cd "$plugin_src" && NODE_ENV=development npm install --ignore-scripts 2>&1 && npx tsc 2>&1); then
    error "Failed to build the claude-mem OpenClaw plugin"
    error "Make sure Node.js and npm are installed."
    exit 1
  fi

  # Create minimal installable package (matches Dockerfile.e2e pattern)
  local installable_dir="${build_dir}/claude-mem-installable"
  mkdir -p "${installable_dir}/dist"

  cp "${plugin_src}/dist/index.js" "${installable_dir}/dist/"
  cp "${plugin_src}/dist/index.d.ts" "${installable_dir}/dist/" 2>/dev/null || true
  cp "${plugin_src}/openclaw.plugin.json" "${installable_dir}/"

  # Generate the installable package.json with openclaw.extensions field
  INSTALLER_PACKAGE_DIR="$installable_dir" node -e "
    const pkg = {
      name: 'claude-mem',
      version: '1.0.0',
      type: 'module',
      main: 'dist/index.js',
      openclaw: { extensions: ['./dist/index.js'] }
    };
    require('fs').writeFileSync(process.env.INSTALLER_PACKAGE_DIR + '/package.json', JSON.stringify(pkg, null, 2));
  "

  # Clean up stale claude-mem plugin entry before installing.
  # If the config references claude-mem but the plugin isn't installed,
  # OpenClaw's config validator blocks ALL CLI commands (including plugins install).
  # We temporarily remove the entry and save the config so `plugins install` can run,
  # then `plugins install` + `plugins enable` will re-create it properly.
  local oc_config="${HOME}/.openclaw/openclaw.json"
  local saved_plugin_config=""
  if [[ -f "$oc_config" ]]; then
    saved_plugin_config=$(INSTALLER_CONFIG_FILE="$oc_config" node -e "
      const fs = require('fs');
      const configPath = process.env.INSTALLER_CONFIG_FILE;
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const entry = config?.plugins?.entries?.['claude-mem'];
      if (entry || config?.plugins?.slots?.memory === 'claude-mem') {
        // Save the config block so we can restore it after install
        process.stdout.write(JSON.stringify(entry?.config || {}));
        // Remove the stale entry so OpenClaw CLI can run
        if (entry) delete config.plugins.entries['claude-mem'];
        // Also remove the slot reference — if the slot points to a plugin
        // that isn't in entries, OpenClaw's config validator rejects ALL commands
        if (config?.plugins?.slots?.memory === 'claude-mem') {
          delete config.plugins.slots.memory;
        }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      }
    " 2>/dev/null) || true
  fi

  # Install the plugin using OpenClaw's CLI
  info "Installing claude-mem plugin into OpenClaw..."
  if ! run_openclaw plugins install "$installable_dir" 2>&1; then
    error "Failed to install claude-mem plugin"
    error "Try manually: ${OPENCLAW_PATH} plugins install <path>"
    exit 1
  fi

  # Enable the plugin
  info "Enabling claude-mem plugin..."
  if ! run_openclaw plugins enable claude-mem 2>&1; then
    error "Failed to enable claude-mem plugin"
    error "Try manually: ${OPENCLAW_PATH} plugins enable claude-mem"
    exit 1
  fi

  # Restore saved plugin config (workerPort, syncMemoryFile, observationFeed, etc.)
  # from any pre-existing installation that was temporarily removed above.
  if [[ -n "$saved_plugin_config" && "$saved_plugin_config" != "{}" ]]; then
    info "Restoring previous plugin configuration..."
    INSTALLER_CONFIG_FILE="$oc_config" INSTALLER_SAVED_CONFIG="$saved_plugin_config" node -e "
      const fs = require('fs');
      const configPath = process.env.INSTALLER_CONFIG_FILE;
      const savedConfig = JSON.parse(process.env.INSTALLER_SAVED_CONFIG);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config?.plugins?.entries?.['claude-mem']) {
        config.plugins.entries['claude-mem'].config = savedConfig;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      }
    " 2>/dev/null || warn "Could not restore previous plugin config — configure manually"
  fi

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
    INSTALLER_CONFIG_FILE="$config_file" node -e "
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
      require('fs').writeFileSync(process.env.INSTALLER_CONFIG_FILE, JSON.stringify(config, null, 2));
    "
    success "Created ${config_file} with memory slot set to claude-mem"
    return 0
  fi

  # Config file exists — update it to set the memory slot
  info "Updating OpenClaw configuration to use claude-mem memory slot..."

  # Use node for reliable JSON manipulation
  INSTALLER_CONFIG_FILE="$config_file" node -e "
    const fs = require('fs');
    const configPath = process.env.INSTALLER_CONFIG_FILE;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

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
      // Remove unrecognized keys that cause OpenClaw config validation errors
      const allowedKeys = new Set(['enabled', 'config']);
      for (const key of Object.keys(config.plugins.entries['claude-mem'])) {
        if (!allowedKeys.has(key)) {
          delete config.plugins.entries['claude-mem'][key];
        }
      }
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  "

  success "Memory slot set to claude-mem in ${config_file}"
}

###############################################################################
# AI Provider setup — interactive provider selection
# Reads defaults from SettingsDefaultsManager.ts (single source of truth)
###############################################################################

AI_PROVIDER=""
AI_PROVIDER_API_KEY=""

mask_api_key() {
  local key="$1"
  local len=${#key}
  if (( len <= 4 )); then
    echo "****"
  else
    local masked_len=$((len - 4))
    local mask=""
    for (( i=0; i<masked_len; i++ )); do
      mask+="*"
    done
    echo "${mask}${key: -4}"
  fi
}

setup_ai_provider() {
  echo ""
  info "AI Provider Configuration"
  echo ""

  # Handle --provider flag (pre-selected via CLI)
  if [[ -n "$CLI_PROVIDER" ]]; then
    case "$CLI_PROVIDER" in
      claude)
        AI_PROVIDER="claude"
        success "Selected via --provider: Claude Max Plan (CLI authentication)"
        ;;
      gemini)
        AI_PROVIDER="gemini"
        AI_PROVIDER_API_KEY="${CLI_API_KEY}"
        if [[ -n "$AI_PROVIDER_API_KEY" ]]; then
          success "Selected via --provider: Gemini (API key set via --api-key)"
        else
          warn "Selected via --provider: Gemini (no API key — add later in ~/.claude-mem/settings.json)"
        fi
        ;;
      openrouter)
        AI_PROVIDER="openrouter"
        AI_PROVIDER_API_KEY="${CLI_API_KEY}"
        if [[ -n "$AI_PROVIDER_API_KEY" ]]; then
          success "Selected via --provider: OpenRouter (API key set via --api-key)"
        else
          warn "Selected via --provider: OpenRouter (no API key — add later in ~/.claude-mem/settings.json)"
        fi
        ;;
      *)
        error "Unknown provider: ${CLI_PROVIDER}"
        error "Valid providers: claude, gemini, openrouter"
        exit 1
        ;;
    esac
    return 0
  fi

  # Handle non-interactive mode (no --provider flag)
  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    info "Non-interactive mode: defaulting to Claude Max Plan (no API key needed)"
    AI_PROVIDER="claude"
    return 0
  fi

  echo -e "  Choose your AI provider for claude-mem:"
  echo ""
  echo -e "  ${COLOR_BOLD}1)${COLOR_RESET} Claude Max Plan ${COLOR_GREEN}(recommended)${COLOR_RESET}"
  echo -e "     Uses your existing subscription, no API key needed"
  echo ""
  echo -e "  ${COLOR_BOLD}2)${COLOR_RESET} Gemini"
  echo -e "     Free tier available — requires API key from ai.google.dev"
  echo ""
  echo -e "  ${COLOR_BOLD}3)${COLOR_RESET} OpenRouter"
  echo -e "     Pay-per-use — requires API key from openrouter.ai"
  echo ""

  local choice
  while true; do
    prompt_user "Enter choice [1/2/3] (default: 1):"
    read_tty -r choice
    choice="${choice:-1}"

    case "$choice" in
      1)
        AI_PROVIDER="claude"
        success "Selected: Claude Max Plan (CLI authentication)"
        break
        ;;
      2)
        AI_PROVIDER="gemini"
        echo ""
        prompt_user "Enter your Gemini API key (from https://ai.google.dev):"
        read_tty -rs AI_PROVIDER_API_KEY
        echo ""
        if [[ -z "$AI_PROVIDER_API_KEY" ]]; then
          warn "No API key provided — you can add it later in ~/.claude-mem/settings.json"
        else
          success "Gemini API key set ($(mask_api_key "$AI_PROVIDER_API_KEY"))"
        fi
        break
        ;;
      3)
        AI_PROVIDER="openrouter"
        echo ""
        prompt_user "Enter your OpenRouter API key (from https://openrouter.ai):"
        read_tty -rs AI_PROVIDER_API_KEY
        echo ""
        if [[ -z "$AI_PROVIDER_API_KEY" ]]; then
          warn "No API key provided — you can add it later in ~/.claude-mem/settings.json"
        else
          success "OpenRouter API key set ($(mask_api_key "$AI_PROVIDER_API_KEY"))"
        fi
        break
        ;;
      *)
        warn "Invalid choice. Please enter 1, 2, or 3."
        ;;
    esac
  done
}

###############################################################################
# Write settings.json — creates ~/.claude-mem/settings.json with all defaults
# Schema: flat key-value (not nested { env: {...} })
# Defaults sourced from SettingsDefaultsManager.ts
###############################################################################

write_settings() {
  local settings_dir="${HOME}/.claude-mem"
  local settings_file="${settings_dir}/settings.json"

  mkdir -p "$settings_dir"

  # Pass provider and API key via environment variables to avoid shell-to-JS injection
  INSTALLER_AI_PROVIDER="$AI_PROVIDER" \
  INSTALLER_AI_API_KEY="$AI_PROVIDER_API_KEY" \
  INSTALLER_SETTINGS_FILE="$settings_file" \
  node -e "
    const fs = require('fs');
    const path = require('path');
    const homedir = require('os').homedir();
    const provider = process.env.INSTALLER_AI_PROVIDER;
    const apiKey = process.env.INSTALLER_AI_API_KEY || '';
    const settingsPath = process.env.INSTALLER_SETTINGS_FILE;

    // All defaults from SettingsDefaultsManager.ts
    const defaults = {
      CLAUDE_MEM_MODEL: 'claude-sonnet-4-5',
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
      CLAUDE_MEM_WORKER_PORT: '37777',
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion',
      CLAUDE_MEM_PROVIDER: 'claude',
      CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'cli',
      CLAUDE_MEM_GEMINI_API_KEY: '',
      CLAUDE_MEM_GEMINI_MODEL: 'gemini-2.5-flash-lite',
      CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: 'true',
      CLAUDE_MEM_OPENROUTER_API_KEY: '',
      CLAUDE_MEM_OPENROUTER_MODEL: 'xiaomi/mimo-v2-flash:free',
      CLAUDE_MEM_OPENROUTER_SITE_URL: '',
      CLAUDE_MEM_OPENROUTER_APP_NAME: 'claude-mem',
      CLAUDE_MEM_OPENROUTER_MAX_CONTEXT_MESSAGES: '20',
      CLAUDE_MEM_OPENROUTER_MAX_TOKENS: '100000',
      CLAUDE_MEM_DATA_DIR: path.join(homedir, '.claude-mem'),
      CLAUDE_MEM_LOG_LEVEL: 'INFO',
      CLAUDE_MEM_PYTHON_VERSION: '3.13',
      CLAUDE_CODE_PATH: '',
      CLAUDE_MEM_MODE: 'code',
      CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: 'true',
      CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: 'true',
      CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: 'true',
      CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: 'true',
      CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES: 'bugfix,feature,refactor,discovery,decision,change',
      CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS: 'how-it-works,why-it-exists,what-changed,problem-solution,gotcha,pattern,trade-off',
      CLAUDE_MEM_CONTEXT_FULL_COUNT: '5',
      CLAUDE_MEM_CONTEXT_FULL_FIELD: 'narrative',
      CLAUDE_MEM_CONTEXT_SESSION_COUNT: '10',
      CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: 'true',
      CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
      CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
      CLAUDE_MEM_EXCLUDED_PROJECTS: '',
      CLAUDE_MEM_FOLDER_MD_EXCLUDE: '[]'
    };

    // Build provider-specific overrides safely from environment variables
    const overrides = { CLAUDE_MEM_PROVIDER: provider };
    if (provider === 'claude') {
      overrides.CLAUDE_MEM_CLAUDE_AUTH_METHOD = 'cli';
    } else if (provider === 'gemini') {
      overrides.CLAUDE_MEM_GEMINI_API_KEY = apiKey;
      overrides.CLAUDE_MEM_GEMINI_MODEL = 'gemini-2.5-flash-lite';
    } else if (provider === 'openrouter') {
      overrides.CLAUDE_MEM_OPENROUTER_API_KEY = apiKey;
      overrides.CLAUDE_MEM_OPENROUTER_MODEL = 'xiaomi/mimo-v2-flash:free';
    }

    const settings = Object.assign(defaults, overrides);

    // If settings file already exists, merge (preserve user customizations)
    if (fs.existsSync(settingsPath)) {
      try {
        let existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        // Handle old nested schema
        if (existing.env && typeof existing.env === 'object') {
          existing = existing.env;
        }
        // Existing settings take priority, except for provider settings we just set
        for (const key of Object.keys(existing)) {
          if (!(key in overrides) && key in defaults) {
            settings[key] = existing[key];
          }
        }
      } catch (e) {
        // Corrupted file — overwrite with fresh defaults
      }
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  "

  success "Settings written to ${settings_file}"
}

###############################################################################
# Locate the installed claude-mem plugin directory
# Checks common OpenClaw and Claude Code plugin install paths
###############################################################################

CLAUDE_MEM_INSTALL_DIR=""

find_claude_mem_install_dir() {
  local -a search_paths=(
    "${HOME}/.openclaw/extensions/claude-mem"
    "${HOME}/.claude/plugins/marketplaces/thedotmack"
    "${HOME}/.openclaw/plugins/claude-mem"
  )

  for candidate in "${search_paths[@]}"; do
    if [[ -f "${candidate}/plugin/scripts/worker-service.cjs" ]]; then
      CLAUDE_MEM_INSTALL_DIR="$candidate"
      return 0
    fi
  done

  # Fallback: search for the worker script under common plugin roots
  local -a roots=(
    "${HOME}/.openclaw"
    "${HOME}/.claude/plugins"
  )
  for root in "${roots[@]}"; do
    if [[ -d "$root" ]]; then
      local found
      found="$(find "$root" -name "worker-service.cjs" -path "*/plugin/scripts/*" 2>/dev/null | head -n 1)" || true
      if [[ -n "$found" ]]; then
        # Strip /plugin/scripts/worker-service.cjs to get the install dir
        CLAUDE_MEM_INSTALL_DIR="${found%/plugin/scripts/worker-service.cjs}"
        return 0
      fi
    fi
  done

  CLAUDE_MEM_INSTALL_DIR=""
  return 1
}

###############################################################################
# Worker service startup
# Starts the claude-mem worker using bun in the background
###############################################################################

WORKER_PID=""

start_worker() {
  info "Starting claude-mem worker service..."

  if ! find_claude_mem_install_dir; then
    error "Cannot find claude-mem plugin installation directory"
    error "Expected worker-service.cjs in one of:"
    error "  ~/.openclaw/extensions/claude-mem/plugin/scripts/"
    error "  ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/"
    error ""
    error "Try reinstalling the plugin and re-running this installer."
    return 1
  fi

  local worker_script="${CLAUDE_MEM_INSTALL_DIR}/plugin/scripts/worker-service.cjs"
  local log_dir="${HOME}/.claude-mem/logs"
  local log_date
  log_date="$(date +%Y-%m-%d)"
  local log_file="${log_dir}/worker-${log_date}.log"

  mkdir -p "$log_dir"

  # Ensure bun path is available
  if [[ -z "$BUN_PATH" ]]; then
    if ! find_bun_path; then
      error "Bun not found — cannot start worker service"
      return 1
    fi
  fi

  # Start worker in background with nohup
  CLAUDE_MEM_WORKER_PORT=37777 nohup "$BUN_PATH" "$worker_script" \
    >> "$log_file" 2>&1 &
  WORKER_PID=$!

  # Write PID file for future management
  local pid_file="${HOME}/.claude-mem/worker.pid"
  mkdir -p "${HOME}/.claude-mem"
  INSTALLER_PID_FILE="$pid_file" INSTALLER_WORKER_PID="$WORKER_PID" node -e "
    const info = {
      pid: parseInt(process.env.INSTALLER_WORKER_PID, 10),
      port: 37777,
      startedAt: new Date().toISOString(),
      version: 'installer'
    };
    require('fs').writeFileSync(process.env.INSTALLER_PID_FILE, JSON.stringify(info, null, 2));
  "

  success "Worker process started (PID: ${WORKER_PID})"
  info "Logs: ${log_file}"
}

###############################################################################
# Health verification
# Polls http://localhost:37777/api/health up to 10 times with 1-second intervals
###############################################################################

verify_health() {
  local max_attempts=10
  local attempt=1
  local health_url="http://127.0.0.1:37777/api/health"

  info "Verifying worker health..."

  while (( attempt <= max_attempts )); do
    local response
    response="$(curl -s -o /dev/null -w "%{http_code}" "$health_url" 2>/dev/null)" || true

    if [[ "$response" == "200" ]]; then
      # Verify the response body contains status:ok
      local body
      body="$(curl -s "$health_url" 2>/dev/null)" || true
      if echo "$body" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
        success "Worker is healthy (port 37777)"
        return 0
      fi
    fi

    if (( attempt < max_attempts )); then
      info "Waiting for worker to start... (attempt ${attempt}/${max_attempts})"
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  warn "Worker health check timed out after ${max_attempts} attempts"
  warn "The worker may still be starting up. Check status with:"
  warn "  curl http://127.0.0.1:37777/api/health"
  warn "  Or check logs: ~/.claude-mem/logs/"
  return 1
}

###############################################################################
# Observation feed setup — optional interactive channel configuration
###############################################################################

FEED_CHANNEL=""
FEED_TARGET_ID=""
FEED_CONFIGURED=false

setup_observation_feed() {
  echo ""
  echo -e "  ${COLOR_BOLD}Real-Time Observation Feed${COLOR_RESET}"
  echo ""
  echo "  claude-mem can stream AI-compressed observations to a messaging"
  echo "  channel in real time. Every time an agent learns something,"
  echo "  you'll see it in your chat."
  echo ""

  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    info "Non-interactive mode: skipping observation feed setup"
    info "Configure later in ~/.openclaw/openclaw.json under"
    info "  plugins.entries.claude-mem.config.observationFeed"
    return 0
  fi

  prompt_user "Would you like to set up real-time observation streaming to a messaging channel? (y/n)"
  local answer
  read_tty -r answer
  answer="${answer:-n}"

  if [[ "${answer,,}" != "y" && "${answer,,}" != "yes" ]]; then
    echo ""
    info "Skipped observation feed setup."
    info "You can configure it later by re-running this installer or"
    info "editing ~/.openclaw/openclaw.json under"
    info "  plugins.entries.claude-mem.config.observationFeed"
    return 0
  fi

  echo ""
  echo -e "  ${COLOR_BOLD}Select your messaging channel:${COLOR_RESET}"
  echo ""
  echo -e "  ${COLOR_BOLD}1)${COLOR_RESET} Telegram"
  echo -e "  ${COLOR_BOLD}2)${COLOR_RESET} Discord"
  echo -e "  ${COLOR_BOLD}3)${COLOR_RESET} Slack"
  echo -e "  ${COLOR_BOLD}4)${COLOR_RESET} Signal"
  echo -e "  ${COLOR_BOLD}5)${COLOR_RESET} WhatsApp"
  echo -e "  ${COLOR_BOLD}6)${COLOR_RESET} LINE"
  echo ""

  local channel_choice
  while true; do
    prompt_user "Enter choice [1-6]:"
    read_tty -r channel_choice

    case "$channel_choice" in
      1)
        FEED_CHANNEL="telegram"
        echo ""
        echo -e "  ${COLOR_CYAN}How to find your Telegram chat ID:${COLOR_RESET}"
        echo "  Message @userinfobot on Telegram (https://t.me/userinfobot)"
        echo "  — it replies with your numeric chat ID."
        echo "  For groups, the ID is negative (e.g., -1001234567890)."
        break
        ;;
      2)
        FEED_CHANNEL="discord"
        echo ""
        echo -e "  ${COLOR_CYAN}How to find your Discord channel ID:${COLOR_RESET}"
        echo "  Enable Developer Mode (Settings → Advanced → Developer Mode),"
        echo "  right-click the target channel → Copy Channel ID"
        break
        ;;
      3)
        FEED_CHANNEL="slack"
        echo ""
        echo -e "  ${COLOR_CYAN}How to find your Slack channel ID:${COLOR_RESET}"
        echo "  Open the channel, click the channel name at top,"
        echo "  scroll to bottom — ID looks like C01ABC2DEFG"
        break
        ;;
      4)
        FEED_CHANNEL="signal"
        echo ""
        echo -e "  ${COLOR_CYAN}How to find your Signal target ID:${COLOR_RESET}"
        echo "  Use the phone number or group ID from your"
        echo "  OpenClaw Signal plugin config"
        break
        ;;
      5)
        FEED_CHANNEL="whatsapp"
        echo ""
        echo -e "  ${COLOR_CYAN}How to find your WhatsApp target ID:${COLOR_RESET}"
        echo "  Use the phone number or group JID from your"
        echo "  OpenClaw WhatsApp plugin config"
        break
        ;;
      6)
        FEED_CHANNEL="line"
        echo ""
        echo -e "  ${COLOR_CYAN}How to find your LINE target ID:${COLOR_RESET}"
        echo "  Use the user ID or group ID from the"
        echo "  LINE Developer Console"
        break
        ;;
      *)
        warn "Invalid choice. Please enter a number between 1 and 6."
        ;;
    esac
  done

  echo ""
  prompt_user "Enter your ${FEED_CHANNEL} target ID:"
  read_tty -r FEED_TARGET_ID

  if [[ -z "$FEED_TARGET_ID" ]]; then
    warn "No target ID provided — skipping observation feed setup."
    warn "You can configure it later in ~/.openclaw/openclaw.json"
    FEED_CHANNEL=""
    return 0
  fi

  success "Observation feed: ${FEED_CHANNEL} → ${FEED_TARGET_ID}"
  FEED_CONFIGURED=true
}

###############################################################################
# Write observation feed config into ~/.openclaw/openclaw.json
###############################################################################

write_observation_feed_config() {
  if [[ "$FEED_CONFIGURED" != "true" ]]; then
    return 0
  fi

  local config_file="${HOME}/.openclaw/openclaw.json"

  if [[ ! -f "$config_file" ]]; then
    warn "OpenClaw config file not found at ${config_file}"
    warn "Cannot write observation feed config."
    return 1
  fi

  info "Writing observation feed configuration..."

  # Use jq if available, fall back to python3, then node for JSON manipulation
  if command -v jq &>/dev/null; then
    local tmp_file
    tmp_file="$(mktemp)"
    jq --arg channel "$FEED_CHANNEL" --arg target "$FEED_TARGET_ID" '
      .plugins //= {} |
      .plugins.entries //= {} |
      .plugins.entries["claude-mem"] //= {"enabled": true, "config": {}} |
      .plugins.entries["claude-mem"].config //= {} |
      .plugins.entries["claude-mem"].config.observationFeed = {
        "enabled": true,
        "channel": $channel,
        "to": $target
      }
    ' "$config_file" > "$tmp_file" && mv "$tmp_file" "$config_file"
  elif command -v python3 &>/dev/null; then
    INSTALLER_FEED_CHANNEL="$FEED_CHANNEL" \
    INSTALLER_FEED_TARGET_ID="$FEED_TARGET_ID" \
    INSTALLER_CONFIG_FILE="$config_file" \
    python3 -c "
import json, os
config_path = os.environ['INSTALLER_CONFIG_FILE']
channel = os.environ['INSTALLER_FEED_CHANNEL']
target_id = os.environ['INSTALLER_FEED_TARGET_ID']

with open(config_path) as f:
    config = json.load(f)

config.setdefault('plugins', {})
config['plugins'].setdefault('entries', {})
config['plugins']['entries'].setdefault('claude-mem', {'enabled': True, 'config': {}})
config['plugins']['entries']['claude-mem'].setdefault('config', {})
config['plugins']['entries']['claude-mem']['config']['observationFeed'] = {
    'enabled': True,
    'channel': channel,
    'to': target_id
}

with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)
"
  else
    # Fallback to node (always available since it's a dependency)
    INSTALLER_FEED_CHANNEL="$FEED_CHANNEL" \
    INSTALLER_FEED_TARGET_ID="$FEED_TARGET_ID" \
    INSTALLER_CONFIG_FILE="$config_file" \
    node -e "
      const fs = require('fs');
      const configPath = process.env.INSTALLER_CONFIG_FILE;
      const channel = process.env.INSTALLER_FEED_CHANNEL;
      const targetId = process.env.INSTALLER_FEED_TARGET_ID;

      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      if (!config.plugins) config.plugins = {};
      if (!config.plugins.entries) config.plugins.entries = {};
      if (!config.plugins.entries['claude-mem']) {
        config.plugins.entries['claude-mem'] = { enabled: true, config: {} };
      }
      if (!config.plugins.entries['claude-mem'].config) {
        config.plugins.entries['claude-mem'].config = {};
      }

      config.plugins.entries['claude-mem'].config.observationFeed = {
        enabled: true,
        channel: channel,
        to: targetId
      };

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    "
  fi

  success "Observation feed config written to ${config_file}"
  echo ""
  echo -e "  ${COLOR_BOLD}Observation feed summary:${COLOR_RESET}"
  echo -e "  Channel: ${COLOR_CYAN}${FEED_CHANNEL}${COLOR_RESET}"
  echo -e "  Target:  ${COLOR_CYAN}${FEED_TARGET_ID}${COLOR_RESET}"
  echo -e "  Enabled: ${COLOR_GREEN}yes${COLOR_RESET}"
  echo ""
  info "Restart your OpenClaw gateway to activate the observation feed."
  info "You should see these log lines:"
  echo "  [claude-mem] Observation feed starting — channel: ${FEED_CHANNEL}, target: ${FEED_TARGET_ID}"
  echo ""
  info "After restarting, run /claude-mem-feed in any OpenClaw chat to verify"
  info "the feed is connected."
}

###############################################################################
# Completion summary
###############################################################################

print_completion_summary() {
  local provider_display=""
  case "$AI_PROVIDER" in
    claude)    provider_display="Claude Max Plan (CLI authentication)" ;;
    gemini)    provider_display="Gemini (gemini-2.5-flash-lite)" ;;
    openrouter) provider_display="OpenRouter (xiaomi/mimo-v2-flash:free)" ;;
    *)         provider_display="$AI_PROVIDER" ;;
  esac

  echo ""
  echo -e "${COLOR_MAGENTA}${COLOR_BOLD}"
  echo "  ┌──────────────────────────────────────────┐"
  echo "  │       Installation Complete!              │"
  echo "  └──────────────────────────────────────────┘"
  echo -e "${COLOR_RESET}"

  echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  Dependencies installed (Bun, uv)"
  echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  OpenClaw gateway detected"
  echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  claude-mem plugin installed and enabled"
  echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  Memory slot configured"
  echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  AI provider: ${COLOR_BOLD}${provider_display}${COLOR_RESET}"
  echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  Settings written to ~/.claude-mem/settings.json"

  if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  Worker running on port ${COLOR_BOLD}37777${COLOR_RESET} (PID: ${WORKER_PID})"
  else
    echo -e "  ${COLOR_YELLOW}⚠${COLOR_RESET}  Worker may not be running — check logs at ~/.claude-mem/logs/"
  fi

  if [[ "$FEED_CONFIGURED" == "true" ]]; then
    echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  Observation feed: ${COLOR_BOLD}${FEED_CHANNEL}${COLOR_RESET} → ${FEED_TARGET_ID}"
  else
    echo -e "  ${COLOR_YELLOW}─${COLOR_RESET}  Observation feed: not configured (optional)"
    echo -e "     Configure later in ~/.openclaw/openclaw.json under"
    echo -e "     plugins.entries.claude-mem.config.observationFeed"
  fi

  echo ""
  echo -e "  ${COLOR_BOLD}What's next?${COLOR_RESET}"
  echo ""
  echo -e "  ${COLOR_CYAN}1.${COLOR_RESET} Restart your OpenClaw gateway to load the plugin"
  echo -e "  ${COLOR_CYAN}2.${COLOR_RESET} Verify with ${COLOR_BOLD}/claude-mem-status${COLOR_RESET} in any OpenClaw chat"
  echo -e "  ${COLOR_CYAN}3.${COLOR_RESET} Check the viewer UI at ${COLOR_BOLD}http://localhost:37777${COLOR_RESET}"
  if [[ "$FEED_CONFIGURED" == "true" ]]; then
    echo -e "  ${COLOR_CYAN}4.${COLOR_RESET} Run ${COLOR_BOLD}/claude-mem-feed${COLOR_RESET} to check feed status"
  fi
  echo ""
  echo -e "  ${COLOR_BOLD}To re-run this installer:${COLOR_RESET}"
  echo "  bash <(curl -fsSL https://raw.githubusercontent.com/thedotmack/claude-mem/main/openclaw/install.sh)"
  echo ""
}

###############################################################################
# Main
###############################################################################

main() {
  setup_tty
  print_banner
  detect_platform

  # --- Step 1: Dependencies ---
  echo ""
  info "${COLOR_BOLD}[1/8]${COLOR_RESET} Checking dependencies..."
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
  info "${COLOR_BOLD}[2/8]${COLOR_RESET} Locating OpenClaw gateway..."
  check_openclaw

  # --- Step 3: Plugin installation (skip if upgrading and already installed) ---
  echo ""
  info "${COLOR_BOLD}[3/8]${COLOR_RESET} Installing claude-mem plugin..."

  if [[ "$UPGRADE_MODE" == "true" ]] && is_claude_mem_installed; then
    success "claude-mem already installed at ${CLAUDE_MEM_INSTALL_DIR}"
    info "Upgrade mode: skipping clone/build/register, updating settings only"
  else
    install_plugin
  fi

  # --- Step 4: Memory slot configuration ---
  echo ""
  info "${COLOR_BOLD}[4/8]${COLOR_RESET} Configuring memory slot..."
  configure_memory_slot

  # --- Step 5: AI provider setup ---
  echo ""
  info "${COLOR_BOLD}[5/8]${COLOR_RESET} AI provider setup..."
  setup_ai_provider

  # --- Step 6: Write settings ---
  echo ""
  info "${COLOR_BOLD}[6/8]${COLOR_RESET} Writing settings..."
  write_settings

  # --- Step 7: Start worker and verify ---
  echo ""
  info "${COLOR_BOLD}[7/8]${COLOR_RESET} Starting worker service..."

  if check_port_37777; then
    warn "Port 37777 is already in use (worker may already be running)"
    info "Checking if the existing service is healthy..."
    if verify_health; then
      success "Existing worker is healthy — skipping startup"
    else
      warn "Port 37777 is occupied but not responding to health checks"
      warn "Another process may be using this port. Stop it and re-run the installer,"
      warn "or change CLAUDE_MEM_WORKER_PORT in ~/.claude-mem/settings.json"
    fi
  else
    if start_worker; then
      verify_health || true
    else
      warn "Worker startup failed — you can start it manually later"
      warn "  cd ~/.claude/plugins/marketplaces/thedotmack && bun plugin/scripts/worker-service.cjs"
    fi
  fi

  # --- Step 8: Observation feed setup (optional) ---
  echo ""
  info "${COLOR_BOLD}[8/8]${COLOR_RESET} Observation feed setup..."
  setup_observation_feed
  write_observation_feed_config

  # --- Completion ---
  print_completion_summary
}

main "$@"
