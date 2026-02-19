#!/usr/bin/env bash
#
# claude-mem Setup Hook
# Ensures data directory exists and CLI is accessible on PATH
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
CLI_CJS="$ROOT/scripts/cli.js"
DATA_DIR="$HOME/.claude-mem"
LOCAL_BIN="$HOME/.local/bin"

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

# ── Step 1: Create data directory ─────────────────────────────────────
if [[ ! -d "$DATA_DIR" ]]; then
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  log_ok "Created data directory: $DATA_DIR"
fi

# ── Step 2: Ensure CLI entry point exists ─────────────────────────────
#    Prefer compiled binary (fast native execution).
#    Fall back to cli.js (runs via bun, always available since it's committed).
if [[ -f "$BINARY" ]]; then
  chmod +x "$BINARY"
  CLI_MODE="binary"
elif [[ -f "$CLI_CJS" ]]; then
  chmod +x "$CLI_CJS"
  CLI_MODE="cjs"
else
  log_warn "No CLI entry point found — neither binary nor cli.js exist"
  exit 0
fi

# ── Step 3: Clean ALL legacy claude-mem from shell profiles ───────────
#    Removes every line containing "claude-mem" (aliases, PATH entries,
#    comments, wrapper references) to guarantee a clean slate before
#    Step 5 adds the single PATH export back.
for profile_path in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  [[ -f "$profile_path" ]] || continue

  if grep -q 'claude-mem' "$profile_path" 2>/dev/null; then
    cp "$profile_path" "${profile_path}.claude-mem-backup"
    grep -v 'claude-mem' "$profile_path" > "${profile_path}.tmp" || true
    mv "${profile_path}.tmp" "$profile_path"
    log_ok "Cleaned legacy claude-mem entries from $profile_path"
  fi
done

# ── Step 4: Install CLI at ~/.local/bin/claude-mem ────────────────────
mkdir -p "$LOCAL_BIN"

if [[ "$CLI_MODE" == "binary" ]]; then
  ln -sf "$BINARY" "$LOCAL_BIN/claude-mem"
  log_ok "Symlinked $LOCAL_BIN/claude-mem → $BINARY"
else
  # Create a shell wrapper that invokes cli.js via bun
  cat > "$LOCAL_BIN/claude-mem" <<WRAPPER
#!/usr/bin/env bash
exec bun "$CLI_CJS" "\$@"
WRAPPER
  chmod +x "$LOCAL_BIN/claude-mem"
  log_ok "Created CLI wrapper at $LOCAL_BIN/claude-mem (using cli.js via bun)"
fi

# ── Step 5: Add ~/.local/bin to PATH in shell profile ─────────────────
if ! echo "$PATH" | tr ':' '\n' | grep -q '\.local/bin'; then
  add_path_to_profile() {
    local shell_profile="$1"
    [[ -f "$shell_profile" ]] || return 1

    # Skip if any form of .local/bin PATH entry already exists
    if grep -q '\.local/bin' "$shell_profile" 2>/dev/null; then
      return 0
    fi

    echo "" >> "$shell_profile"
    echo "# claude-mem CLI" >> "$shell_profile"
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$shell_profile"
    log_ok "Added ~/.local/bin to PATH in $shell_profile"
    return 0
  }

  current_shell="$(basename "${SHELL:-/bin/bash}")"
  case "$current_shell" in
    zsh)  add_path_to_profile "$HOME/.zshrc" ;;
    bash) add_path_to_profile "$HOME/.bashrc" || add_path_to_profile "$HOME/.bash_profile" ;;
    *)    add_path_to_profile "$HOME/.profile" ;;
  esac
fi

exit 0
