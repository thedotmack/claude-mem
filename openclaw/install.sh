#!/usr/bin/env bash
set -euo pipefail

# claude-mem OpenClaw Plugin Installer
# Installs the claude-mem persistent memory plugin for OpenClaw gateways.
#
# Usage:
#   curl -fsSL https://install.cmem.ai/openclaw.sh | bash
#   # Or with options:
#   curl -fsSL https://install.cmem.ai/openclaw.sh | bash -s -- --provider=gemini --api-key=YOUR_KEY
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
CLI_OPENCLAW_PROVIDER=""
CLI_OPENCLAW_API_KEY=""
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
    --openclaw-provider=*)
      CLI_OPENCLAW_PROVIDER="${1#--openclaw-provider=}"
      shift
      ;;
    --openclaw-provider)
      CLI_OPENCLAW_PROVIDER="${2:-}"
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
    --openclaw-api-key=*)
      CLI_OPENCLAW_API_KEY="${1#--openclaw-api-key=}"
      shift
      ;;
    --openclaw-api-key)
      CLI_OPENCLAW_API_KEY="${2:-}"
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
# Parse /api/health JSON response — extract worker metadata into globals
# Uses jq → python3 → node fallback chain (matching installer conventions)
# Sets: WORKER_VERSION, WORKER_AI_PROVIDER, WORKER_AI_AUTH_METHOD,
#        WORKER_INITIALIZED, WORKER_REPORTED_PID, WORKER_UPTIME
###############################################################################

parse_health_json() {
  local raw_json="$1"

  # Reset all health globals before parsing
  WORKER_VERSION=""
  WORKER_AI_PROVIDER=""
  WORKER_AI_AUTH_METHOD=""
  WORKER_INITIALIZED=""
  WORKER_REPORTED_PID=""
  WORKER_UPTIME=""

  if [[ -z "$raw_json" ]]; then
    return 0
  fi

  # Try jq first (fastest, most reliable)
  if command -v jq &>/dev/null; then
    WORKER_VERSION="$(echo "$raw_json" | jq -r '.version // empty' 2>/dev/null)" || true
    WORKER_AI_PROVIDER="$(echo "$raw_json" | jq -r '.ai.provider // empty' 2>/dev/null)" || true
    WORKER_AI_AUTH_METHOD="$(echo "$raw_json" | jq -r '.ai.authMethod // empty' 2>/dev/null)" || true
    WORKER_INITIALIZED="$(echo "$raw_json" | jq -r '.initialized // empty' 2>/dev/null)" || true
    WORKER_REPORTED_PID="$(echo "$raw_json" | jq -r '.pid // empty' 2>/dev/null)" || true
    WORKER_UPTIME="$(echo "$raw_json" | jq -r '.uptime // empty' 2>/dev/null)" || true
    return 0
  fi

  # Try python3 fallback
  if command -v python3 &>/dev/null; then
    local parsed
    parsed="$(INSTALLER_HEALTH_JSON="$raw_json" python3 -c "
import json, os, sys
try:
    data = json.loads(os.environ['INSTALLER_HEALTH_JSON'])
    ai = data.get('ai') or {}
    fields = [
        str(data.get('version', '')),
        str(ai.get('provider', '')),
        str(ai.get('authMethod', '')),
        str(data.get('initialized', '')),
        str(data.get('pid', '')),
        str(data.get('uptime', '')),
    ]
    sys.stdout.write('\n'.join(fields))
except Exception:
    sys.stdout.write('\n\n\n\n\n')
" 2>/dev/null)" || true

    if [[ -n "$parsed" ]]; then
      local -a health_fields
      IFS=$'\n' read -r -d '' -a health_fields <<< "$parsed" || true
      WORKER_VERSION="${health_fields[0]:-}"
      WORKER_AI_PROVIDER="${health_fields[1]:-}"
      WORKER_AI_AUTH_METHOD="${health_fields[2]:-}"
      WORKER_INITIALIZED="${health_fields[3]:-}"
      WORKER_REPORTED_PID="${health_fields[4]:-}"
      WORKER_UPTIME="${health_fields[5]:-}"
      # Normalize python's None/empty representations
      [[ "$WORKER_VERSION" == "None" ]] && WORKER_VERSION=""
      [[ "$WORKER_AI_PROVIDER" == "None" ]] && WORKER_AI_PROVIDER=""
      [[ "$WORKER_AI_AUTH_METHOD" == "None" ]] && WORKER_AI_AUTH_METHOD=""
      [[ "$WORKER_INITIALIZED" == "None" ]] && WORKER_INITIALIZED=""
      [[ "$WORKER_REPORTED_PID" == "None" ]] && WORKER_REPORTED_PID=""
      [[ "$WORKER_UPTIME" == "None" ]] && WORKER_UPTIME=""
    fi
    return 0
  fi

  # Fallback to node (always available — it's a dependency)
  local parsed
  parsed="$(INSTALLER_HEALTH_JSON="$raw_json" node -e "
    try {
      const data = JSON.parse(process.env.INSTALLER_HEALTH_JSON);
      const ai = data.ai || {};
      const fields = [
        data.version ?? '',
        ai.provider ?? '',
        ai.authMethod ?? '',
        data.initialized != null ? String(data.initialized) : '',
        data.pid != null ? String(data.pid) : '',
        data.uptime != null ? String(data.uptime) : '',
      ];
      process.stdout.write(fields.join('\n'));
    } catch (e) {
      process.stdout.write('\n\n\n\n\n');
    }
  " 2>/dev/null)" || true

  if [[ -n "$parsed" ]]; then
    local -a health_fields
    IFS=$'\n' read -r -d '' -a health_fields <<< "$parsed" || true
    WORKER_VERSION="${health_fields[0]:-}"
    WORKER_AI_PROVIDER="${health_fields[1]:-}"
    WORKER_AI_AUTH_METHOD="${health_fields[2]:-}"
    WORKER_INITIALIZED="${health_fields[3]:-}"
    WORKER_REPORTED_PID="${health_fields[4]:-}"
    WORKER_UPTIME="${health_fields[5]:-}"
  fi
}

###############################################################################
# Format uptime from milliseconds to human-readable (e.g., "2m 15s", "1h 23m")
###############################################################################

format_uptime_ms() {
  local ms="$1"
  local secs=$((ms / 1000))
  if (( secs >= 3600 )); then
    echo "$((secs / 3600))h $((secs % 3600 / 60))m"
  elif (( secs >= 60 )); then
    echo "$((secs / 60))m $((secs % 60))s"
  else
    echo "${secs}s"
  fi
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
PLUGIN_FRESHLY_INSTALLED=""

# Resolve the target extension directory.
# Priority: existing installPath from config > plugins.load.paths > default.
resolve_extension_dir() {
  local oc_config="${HOME}/.openclaw/openclaw.json"
  if [[ -f "$oc_config" ]] && command -v node &>/dev/null; then
    local existing_path
    existing_path="$(node -e "
      try {
        const c = require('$oc_config');
        const p = c?.plugins?.installs?.['claude-mem']?.installPath;
        if (p) console.log(p);
      } catch {}
    " 2>/dev/null)" || true
    if [[ -n "$existing_path" ]]; then
      echo "$existing_path"
      return
    fi
    local load_path
    load_path="$(node -e "
      try {
        const c = require('$oc_config');
        const paths = c?.plugins?.load?.paths || [];
        const p = paths.find(p => p.endsWith('/claude-mem'));
        if (p) console.log(p);
      } catch {}
    " 2>/dev/null)" || true
    if [[ -n "$load_path" ]]; then
      echo "$load_path"
      return
    fi
  fi
  echo "${HOME}/.openclaw/extensions/claude-mem"
}

CLAUDE_MEM_EXTENSION_DIR=""

install_plugin() {
  # Check for git before attempting clone
  check_git

  CLAUDE_MEM_EXTENSION_DIR="$(resolve_extension_dir)"

  # Remove existing plugin installation to allow clean re-install
  local existing_plugin_dir="$CLAUDE_MEM_EXTENSION_DIR"
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

  # ── Copy core plugin files (worker, hooks, scripts) to extension directory ──
  # The OpenClaw extension only contains the gateway hook (dist/index.js).
  # The actual worker service and Claude Code hooks live in the plugin/ directory
  # of the main repo. We copy them so find_claude_mem_install_dir() can locate
  # the worker-service.cjs and the worker runs the updated version.
  local extension_dir="$CLAUDE_MEM_EXTENSION_DIR"
  local repo_root="${build_dir}/claude-mem"

  if [[ -d "$extension_dir" && -d "${repo_root}/plugin" ]]; then
    info "Copying core plugin files to ${extension_dir}..."

    # Copy plugin/ directory (worker service, hooks, scripts, skills, UI)
    cp -R "${repo_root}/plugin" "${extension_dir}/"

    # Merge the canonical version from root package.json into the existing
    # extension package.json, preserving the openclaw.extensions field that
    # plugin discovery requires.
    local root_version
    root_version="$(node -e "console.log(require('${repo_root}/package.json').version)")"
    node -e "
      const fs = require('fs');
      const pkgPath = '${extension_dir}/package.json';
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.version = '${root_version}';
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    "

    success "Core plugin files updated at ${extension_dir}"
  else
    warn "Could not copy core plugin files — worker may need manual update"
  fi

  PLUGIN_FRESHLY_INSTALLED="true"
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

AI_PROVIDER=""           # Global provider (Claude Code sessions)
AI_PROVIDER_API_KEY=""
AI_OPENCLAW_PROVIDER="" # OpenClaw-specific provider (empty = use AI_PROVIDER)
AI_OPENCLAW_API_KEY=""

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

# Ask for API key for a given provider and store in the named variable.
# Usage: prompt_provider_api_key <provider> <keyvar>
# Example: prompt_provider_api_key gemini AI_PROVIDER_API_KEY
prompt_provider_api_key() {
  local provider="$1"
  local keyvar="$2"
  local url hint
  case "$provider" in
    gemini)    url="https://ai.google.dev";   hint="Gemini API key" ;;
    openrouter) url="https://openrouter.ai"; hint="OpenRouter API key" ;;
    *)         return 0 ;;  # no API key needed
  esac
  echo ""
  prompt_user "Enter your ${hint} (from ${url}):"
  local key=""
  read_tty -rs key
  echo ""
  printf -v "$keyvar" '%s' "$key"
  if [[ -z "$key" ]]; then
    warn "No API key provided — add it later in ~/.claude-mem/settings.json"
  else
    success "${hint} set ($(mask_api_key "$key"))"
  fi
}

# Prompt for a provider from a numbered menu.
# Usage: prompt_provider_menu <result_var> <key_var> <default_num> <skip_claude_warn>
# Prints menu, reads choice, sets result_var to provider name and key_var to API key.
prompt_provider_menu() {
  local result_var="$1"
  local key_var="$2"
  local default_num="${3:-1}"
  local warn_claude="${4:-false}"  # if true, show ToS warning next to Claude option

  local claude_hint="uses your Claude subscription"
  if [[ "$warn_claude" == "true" ]]; then
    claude_hint="${COLOR_RED}⚠️  not recommended — Anthropic ToS prohibits Claude OAuth in third-party apps${COLOR_RESET}"
  fi

  echo -e "  ${COLOR_BOLD}1)${COLOR_RESET} OpenAI Codex ${COLOR_GREEN}(recommended)${COLOR_RESET}"
  echo -e "     Uses your ChatGPT Plus/Pro subscription via OAuth — no extra API key"
  echo ""
  echo -e "  ${COLOR_BOLD}2)${COLOR_RESET} Gemini"
  echo -e "     Free tier available — requires API key from ai.google.dev"
  echo ""
  echo -e "  ${COLOR_BOLD}3)${COLOR_RESET} OpenRouter"
  echo -e "     Access to 100+ models, free options available — requires API key"
  echo ""
  echo -e "  ${COLOR_BOLD}4)${COLOR_RESET} Claude — ${claude_hint}"
  echo -e "     Uses your Anthropic subscription"
  echo ""

  local choice provider=""
  while true; do
    prompt_user "Enter choice [1/2/3/4] (default: ${default_num}):"
    read_tty -r choice
    choice="${choice:-${default_num}}"
    case "$choice" in
      1) provider="openai-codex" ;;
      2) provider="gemini"       ;;
      3) provider="openrouter"   ;;
      4) provider="claude"       ;;
      *) warn "Invalid choice. Please enter 1, 2, 3, or 4." ; continue ;;
    esac
    break
  done

  printf -v "$result_var" '%s' "$provider"
  local key=""
  prompt_provider_api_key "$provider" key
  printf -v "$key_var" '%s' "$key"
}

setup_ai_provider() {
  echo ""
  info "AI Provider Configuration"
  echo ""

  # ── CLI flags (non-interactive path) ────────────────────────────────────────
  if [[ -n "$CLI_PROVIDER" || -n "$CLI_OPENCLAW_PROVIDER" ]]; then
    # Global provider (Claude Code sessions)
    local global_provider="${CLI_PROVIDER:-claude}"
    case "$global_provider" in
      claude|gemini|openrouter|openai-codex) ;;
      *) error "Unknown --provider: ${global_provider}"; error "Valid: claude, gemini, openrouter, openai-codex"; exit 1 ;;
    esac
    AI_PROVIDER="$global_provider"
    AI_PROVIDER_API_KEY="${CLI_API_KEY:-}"
    success "Claude Code sessions provider: ${AI_PROVIDER}"

    # OpenClaw-specific provider
    if [[ -n "$CLI_OPENCLAW_PROVIDER" ]]; then
      case "$CLI_OPENCLAW_PROVIDER" in
        claude|gemini|openrouter|openai-codex) ;;
        *) error "Unknown --openclaw-provider: ${CLI_OPENCLAW_PROVIDER}"; exit 1 ;;
      esac
      AI_OPENCLAW_PROVIDER="$CLI_OPENCLAW_PROVIDER"
      AI_OPENCLAW_API_KEY="${CLI_OPENCLAW_API_KEY:-}"
    else
      # Default OpenClaw provider: openai-codex (avoids Anthropic ToS violation)
      AI_OPENCLAW_PROVIDER="openai-codex"
    fi
    if [[ "$AI_OPENCLAW_PROVIDER" != "$AI_PROVIDER" ]]; then
      success "OpenClaw sessions provider: ${AI_OPENCLAW_PROVIDER}"
      if [[ "$AI_OPENCLAW_PROVIDER" == "claude" ]]; then
        warn "⚠️  Using Claude OAuth for OpenClaw sessions may violate Anthropic's ToS (Feb 2026)"
      fi
    fi
    return 0
  fi

  # ── Non-interactive defaults ─────────────────────────────────────────────────
  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    info "Non-interactive mode: Claude Code → claude | OpenClaw → openai-codex"
    AI_PROVIDER="claude"
    AI_OPENCLAW_PROVIDER="openai-codex"
    return 0
  fi

  # ── Interactive flow ─────────────────────────────────────────────────────────
  echo -e "  ${COLOR_BOLD}This is an OpenClaw installation.${COLOR_RESET}"
  echo ""
  echo -e "  claude-mem can record sessions from two sources simultaneously:"
  echo -e "  • ${COLOR_BOLD}Claude Code${COLOR_RESET} — as a plugin (standard)"
  echo -e "  • ${COLOR_BOLD}OpenClaw${COLOR_RESET}     — via this gateway"
  echo ""
  echo -e "  ${COLOR_YELLOW}⚠️  Anthropic's ToS (Feb 2026) prohibits using Claude OAuth tokens"
  echo -e "  in third-party apps like OpenClaw. OpenClaw sessions must use"
  echo -e "  a different AI provider for observation extraction.${COLOR_RESET}"
  echo ""

  # Step A: Do you also use Claude Code?
  local use_claude_code
  prompt_user "Do you also use Claude Code (in addition to OpenClaw)? [y/N]:"
  read_tty -r use_claude_code
  use_claude_code="${use_claude_code:-n}"

  if [[ "$use_claude_code" =~ ^[Yy] ]]; then
    # Step B: Provider for Claude Code sessions
    echo ""
    echo -e "  ${COLOR_BOLD}Provider for Claude Code sessions:${COLOR_RESET}"
    echo ""
    echo -e "  ${COLOR_BOLD}1)${COLOR_RESET} Claude Max Plan ${COLOR_GREEN}(recommended)${COLOR_RESET}"
    echo -e "     Uses your Anthropic subscription — permitted inside Claude Code"
    echo ""
    echo -e "  ${COLOR_BOLD}2)${COLOR_RESET} Gemini  — free tier available"
    echo -e "  ${COLOR_BOLD}3)${COLOR_RESET} OpenRouter — free models available"
    echo ""

    local cc_choice
    while true; do
      prompt_user "Enter choice [1/2/3] (default: 1):"
      read_tty -r cc_choice
      cc_choice="${cc_choice:-1}"
      case "$cc_choice" in
        1) AI_PROVIDER="claude"      ; break ;;
        2) AI_PROVIDER="gemini"      ; break ;;
        3) AI_PROVIDER="openrouter"  ; break ;;
        *) warn "Invalid choice." ;;
      esac
    done
    prompt_provider_api_key "$AI_PROVIDER" AI_PROVIDER_API_KEY
    success "Claude Code sessions → ${AI_PROVIDER}"
  else
    # Not using Claude Code — global provider will equal OpenClaw provider (set below)
    AI_PROVIDER=""
  fi

  # Step C: Provider for OpenClaw sessions
  echo ""
  echo -e "  ${COLOR_BOLD}Provider for OpenClaw sessions:${COLOR_RESET}"
  echo -e "  (must NOT be Claude OAuth — choose one of the alternatives below)"
  echo ""

  prompt_provider_menu AI_OPENCLAW_PROVIDER AI_OPENCLAW_API_KEY "1" "true"
  success "OpenClaw sessions → ${AI_OPENCLAW_PROVIDER}"

  # If not using Claude Code, mirror global provider to OpenClaw choice
  if [[ -z "$AI_PROVIDER" ]]; then
    AI_PROVIDER="$AI_OPENCLAW_PROVIDER"
    AI_PROVIDER_API_KEY="$AI_OPENCLAW_API_KEY"
  fi

  # Warn if user explicitly chose Claude for OpenClaw
  if [[ "$AI_OPENCLAW_PROVIDER" == "claude" ]]; then
    warn "⚠️  Claude OAuth for OpenClaw sessions may violate Anthropic's ToS (Feb 2026)."
    warn "   Consider switching to openai-codex, gemini, or openrouter."
  fi
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
  INSTALLER_AI_OPENCLAW_PROVIDER="$AI_OPENCLAW_PROVIDER" \
  INSTALLER_AI_OPENCLAW_API_KEY="$AI_OPENCLAW_API_KEY" \
  INSTALLER_SETTINGS_FILE="$settings_file" \
  node -e "
    const fs = require('fs');
    const path = require('path');
    const homedir = require('os').homedir();
    const provider = process.env.INSTALLER_AI_PROVIDER;
    const apiKey = process.env.INSTALLER_AI_API_KEY || '';
    const openclawProvider = process.env.INSTALLER_AI_OPENCLAW_PROVIDER || '';
    const openclawApiKey = process.env.INSTALLER_AI_OPENCLAW_API_KEY || '';
    const settingsPath = process.env.INSTALLER_SETTINGS_FILE;

    // All defaults from SettingsDefaultsManager.ts
    const defaults = {
      CLAUDE_MEM_MODEL: 'claude-sonnet-4-5',
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
      CLAUDE_MEM_WORKER_PORT: '37777',
      CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
      CLAUDE_MEM_SKIP_TOOLS: 'ListMcpResourcesTool,SlashCommand,Skill,TodoWrite,AskUserQuestion',
      CLAUDE_MEM_PROVIDER: 'claude',
      CLAUDE_MEM_OPENCLAW_PROVIDER: '',
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
      CLAUDE_MEM_OPENAI_CODEX_MODEL: 'gpt-4o',
      CLAUDE_MEM_OPENAI_CODEX_AGENT_DIR: '',
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

    // Global provider settings
    if (provider === 'claude') {
      overrides.CLAUDE_MEM_CLAUDE_AUTH_METHOD = 'cli';
    } else if (provider === 'gemini') {
      overrides.CLAUDE_MEM_GEMINI_API_KEY = apiKey;
      overrides.CLAUDE_MEM_GEMINI_MODEL = 'gemini-2.5-flash-lite';
    } else if (provider === 'openrouter') {
      overrides.CLAUDE_MEM_OPENROUTER_API_KEY = apiKey;
      overrides.CLAUDE_MEM_OPENROUTER_MODEL = 'xiaomi/mimo-v2-flash:free';
    }

    // OpenClaw-specific provider (only write if different from global)
    if (openclawProvider && openclawProvider !== provider) {
      overrides.CLAUDE_MEM_OPENCLAW_PROVIDER = openclawProvider;
      if (openclawProvider === 'gemini' && openclawApiKey) {
        // Note: shares CLAUDE_MEM_GEMINI_API_KEY if not already set by global
        if (!overrides.CLAUDE_MEM_GEMINI_API_KEY) overrides.CLAUDE_MEM_GEMINI_API_KEY = openclawApiKey;
      } else if (openclawProvider === 'openrouter' && openclawApiKey) {
        if (!overrides.CLAUDE_MEM_OPENROUTER_API_KEY) overrides.CLAUDE_MEM_OPENROUTER_API_KEY = openclawApiKey;
      }
      // openai-codex uses OAuth — no API key to store
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
  local resolved_dir
  resolved_dir="$(resolve_extension_dir)"
  local -a search_paths=(
    "$resolved_dir"
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
WORKER_VERSION=""
WORKER_AI_PROVIDER=""
WORKER_AI_AUTH_METHOD=""
WORKER_INITIALIZED=""
WORKER_REPORTED_PID=""
WORKER_UPTIME=""

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
# Health verification — two-stage: health (alive) then readiness (initialized)
# Stage 1: Poll /api/health for HTTP 200 (worker process is running)
# Stage 2: Poll /api/readiness for HTTP 200 (worker is fully initialized)
# Total budget: 30 attempts (30 seconds) shared across both stages
###############################################################################

verify_health() {
  local max_attempts=30
  local attempt=1
  local health_url="http://127.0.0.1:37777/api/health"
  local readiness_url="http://127.0.0.1:37777/api/readiness"
  local health_alive=false

  info "Verifying worker health..."

  # ── Stage 1: Wait for /api/health to return HTTP 200 (worker is alive) ──
  while (( attempt <= max_attempts )); do
    local http_status
    http_status="$(curl -s -o /dev/null -w "%{http_code}" "$health_url" 2>/dev/null)" || true

    if [[ "$http_status" == "200" ]]; then
      health_alive=true

      # Fetch the full health response body and parse metadata
      local body
      body="$(curl -s "$health_url" 2>/dev/null)" || true
      parse_health_json "$body"

      success "Worker is alive, waiting for initialization..."

      break
    fi

    info "Waiting for worker to start... (attempt ${attempt}/${max_attempts})"
    sleep 1
    attempt=$((attempt + 1))
  done

  # If health never responded, the worker is not running at all
  if [[ "$health_alive" != "true" ]]; then
    warn "Worker health check timed out after ${max_attempts} attempts"
    warn "The worker may still be starting up. Check status with:"
    warn "  curl http://127.0.0.1:37777/api/health"
    warn "  Or check logs: ~/.claude-mem/logs/"
    return 1
  fi

  # ── Stage 2: Wait for /api/readiness to return HTTP 200 (fully initialized) ──
  attempt=$((attempt + 1))
  while (( attempt <= max_attempts )); do
    local readiness_status
    readiness_status="$(curl -s -o /dev/null -w "%{http_code}" "$readiness_url" 2>/dev/null)" || true

    if [[ "$readiness_status" == "200" ]]; then
      success "Worker is ready!"
      return 0
    fi

    info "Waiting for worker to initialize... (attempt ${attempt}/${max_attempts})"
    sleep 1
    attempt=$((attempt + 1))
  done

  # Readiness timed out but health is OK — worker is running, just not fully initialized yet
  warn "Worker is running but initialization is still in progress"
  warn "This is normal on first run — the worker will finish initializing in the background."
  warn "Check readiness with: curl http://127.0.0.1:37777/api/readiness"
  return 0
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

  if [[ "$answer" != [yY] && "$answer" != [yY][eE][sS] ]]; then
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

  # Show installed version from health data if available
  if [[ -n "$WORKER_VERSION" ]]; then
    echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  claude-mem v${COLOR_BOLD}${WORKER_VERSION}${COLOR_RESET} installed and running"
  else
    echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  claude-mem plugin installed and enabled"
  fi

  echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  Memory slot configured"

  # Show AI provider with auth method from health data if available
  if [[ -n "$WORKER_AI_AUTH_METHOD" ]]; then
    echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  AI provider: ${COLOR_BOLD}${WORKER_AI_PROVIDER} (${WORKER_AI_AUTH_METHOD})${COLOR_RESET}"
  else
    echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  AI provider: ${COLOR_BOLD}${provider_display}${COLOR_RESET}"
  fi

  echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  Settings written to ~/.claude-mem/settings.json"

  if [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; then
    echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  Worker running on port ${COLOR_BOLD}37777${COLOR_RESET} (PID: ${WORKER_PID})"
  elif [[ -n "$WORKER_UPTIME" && "$WORKER_UPTIME" =~ ^[0-9]+$ ]] && (( WORKER_UPTIME > 0 )); then
    local uptime_formatted
    uptime_formatted="$(format_uptime_ms "$WORKER_UPTIME")"
    echo -e "  ${COLOR_GREEN}✓${COLOR_RESET}  Worker running on port ${COLOR_BOLD}37777${COLOR_RESET} (PID: ${WORKER_REPORTED_PID}, uptime: ${uptime_formatted})"
  else
    echo -e "  ${COLOR_YELLOW}⚠${COLOR_RESET}  Worker may not be running — check logs at ~/.claude-mem/logs/"
  fi

  # Show initialization warning if worker is alive but not yet initialized
  if [[ "$WORKER_INITIALIZED" != "true" ]] && { [[ -n "$WORKER_REPORTED_PID" ]] || { [[ -n "$WORKER_PID" ]] && kill -0 "$WORKER_PID" 2>/dev/null; }; }; then
    echo -e "  ${COLOR_YELLOW}⚠${COLOR_RESET}  Worker is starting but still initializing (this is normal on first run)"
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
  echo "  bash <(curl -fsSL https://install.cmem.ai/openclaw.sh)"
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
      # verify_health already called parse_health_json — WORKER_* globals are set.
      # Determine the expected version from the installed plugin's package.json.
      local expected_version=""
      if [[ -n "$CLAUDE_MEM_INSTALL_DIR" ]] || find_claude_mem_install_dir; then
        expected_version="$(INSTALLER_PKG="${CLAUDE_MEM_INSTALL_DIR}/package.json" node -e "
          try { process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.INSTALLER_PKG, 'utf8')).version || ''); }
          catch(e) {}
        " 2>/dev/null)" || true
      fi

      local needs_restart=""

      # If we just installed fresh plugin files, always restart the worker
      # to pick up the new version — even if the old worker was healthy.
      if [[ "$PLUGIN_FRESHLY_INSTALLED" == "true" ]]; then
        if [[ -n "$WORKER_VERSION" && -n "$expected_version" && "$WORKER_VERSION" != "$expected_version" ]]; then
          info "Upgrading worker from v${WORKER_VERSION} to v${expected_version}..."
        else
          info "Plugin files updated — restarting worker to load new code..."
        fi
        needs_restart="true"
      fi

      # Check if worker version is outdated compared to installed version
      if [[ "$needs_restart" != "true" && -n "$WORKER_VERSION" && -n "$expected_version" && "$WORKER_VERSION" != "$expected_version" ]]; then
        info "Upgrading worker from v${WORKER_VERSION} to v${expected_version}..."
        needs_restart="true"
      fi

      # Check if AI provider doesn't match current configuration
      if [[ "$needs_restart" != "true" && -n "$WORKER_AI_PROVIDER" && -n "$AI_PROVIDER" && "$WORKER_AI_PROVIDER" != "$AI_PROVIDER" ]]; then
        warn "Worker is using ${WORKER_AI_PROVIDER} but you configured ${AI_PROVIDER} — restarting to apply"
        needs_restart="true"
      fi

      # Restart worker if needed: kill old process, start fresh
      if [[ "$needs_restart" == "true" ]]; then
        info "Stopping existing worker..."
        # Try graceful shutdown via API first, fall back to SIGTERM
        curl -s -X POST "http://127.0.0.1:37777/api/admin/shutdown" >/dev/null 2>&1 || true
        sleep 2

        # If still running, send SIGTERM to known PID
        if check_port_37777; then
          if [[ -n "$WORKER_REPORTED_PID" ]]; then
            kill "$WORKER_REPORTED_PID" 2>/dev/null || true
            sleep 1
          fi
          # Check PID file as fallback
          local pid_file="${HOME}/.claude-mem/worker.pid"
          if [[ -f "$pid_file" ]]; then
            local file_pid
            file_pid="$(INSTALLER_PID_FILE="$pid_file" node -e "
              try { process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.env.INSTALLER_PID_FILE, 'utf8')).pid || '')); }
              catch(e) {}
            " 2>/dev/null)" || true
            if [[ -n "$file_pid" ]]; then
              kill "$file_pid" 2>/dev/null || true
              sleep 1
            fi
          fi
        fi

        # Start fresh worker
        if start_worker; then
          verify_health || true
        else
          warn "Worker restart failed — you can start it manually later"
        fi
      else
        # No restart needed — show healthy status
        local uptime_display=""
        if [[ -n "$WORKER_UPTIME" && "$WORKER_UPTIME" =~ ^[0-9]+$ && "$WORKER_UPTIME" != "0" ]]; then
          uptime_display="$(format_uptime_ms "$WORKER_UPTIME")"
        fi

        local status_parts=""
        if [[ -n "$WORKER_VERSION" ]]; then
          status_parts="v${WORKER_VERSION}"
        fi
        if [[ -n "$WORKER_AI_PROVIDER" ]]; then
          status_parts="${status_parts:+${status_parts}, }${WORKER_AI_PROVIDER}"
        fi
        if [[ -n "$uptime_display" ]]; then
          status_parts="${status_parts:+${status_parts}, }uptime: ${uptime_display}"
        fi

        if [[ -n "$status_parts" ]]; then
          success "Existing worker is healthy (${status_parts}) — skipping startup"
        else
          success "Existing worker is healthy — skipping startup"
        fi
      fi
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
      warn "  cd ~/.openclaw/extensions/claude-mem && bun plugin/scripts/worker-service.cjs"
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
