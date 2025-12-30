#!/bin/bash
# Installation script for claude-mem Cursor hooks

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_TYPE="${1:-user}"  # 'user', 'project', or 'enterprise'

echo "Installing claude-mem Cursor hooks (${INSTALL_TYPE} level)..."

case "$INSTALL_TYPE" in
  "project")
    if [ ! -d ".cursor" ]; then
      mkdir -p .cursor
    fi
    TARGET_DIR=".cursor"
    HOOKS_DIR=".cursor/hooks"
    ;;
  "user")
    TARGET_DIR="${HOME}/.cursor"
    HOOKS_DIR="${HOME}/.cursor/hooks"
    ;;
  "enterprise")
    if [[ "$OSTYPE" == "darwin"* ]]; then
      TARGET_DIR="/Library/Application Support/Cursor"
      HOOKS_DIR="/Library/Application Support/Cursor/hooks"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
      TARGET_DIR="/etc/cursor"
      HOOKS_DIR="/etc/cursor/hooks"
    else
      echo "Enterprise installation not supported on this OS"
      exit 1
    fi
    if [ "$EUID" -ne 0 ]; then
      echo "Enterprise installation requires root privileges"
      exit 1
    fi
    ;;
  *)
    echo "Invalid install type: $INSTALL_TYPE"
    echo "Usage: $0 [user|project|enterprise]"
    exit 1
    ;;
esac

# Create hooks directory
mkdir -p "$HOOKS_DIR"

# Copy hook scripts
echo "Copying hook scripts..."
cp "$SCRIPT_DIR"/*.sh "$HOOKS_DIR/"
chmod +x "$HOOKS_DIR"/*.sh

# Copy hooks.json
echo "Copying hooks.json..."
cp "$SCRIPT_DIR/hooks.json" "$TARGET_DIR/hooks.json"

# Update paths in hooks.json if needed
# Use portable sed approach that works on both BSD (macOS) and GNU (Linux) sed
if [ "$INSTALL_TYPE" = "project" ]; then
  # For project-level, paths should be relative
  # Create temp file, modify, then move (portable across sed variants)
  tmp_file=$(mktemp)
  sed 's|\./cursor-hooks/|\./\.cursor/hooks/|g' "$TARGET_DIR/hooks.json" > "$tmp_file"
  mv "$tmp_file" "$TARGET_DIR/hooks.json"
elif [ "$INSTALL_TYPE" = "user" ]; then
  # For user-level, use absolute paths
  tmp_file=$(mktemp)
  sed "s|\./cursor-hooks/|${HOOKS_DIR}/|g" "$TARGET_DIR/hooks.json" > "$tmp_file"
  mv "$tmp_file" "$TARGET_DIR/hooks.json"
elif [ "$INSTALL_TYPE" = "enterprise" ]; then
  # For enterprise, use absolute paths
  tmp_file=$(mktemp)
  sed "s|\./cursor-hooks/|${HOOKS_DIR}/|g" "$TARGET_DIR/hooks.json" > "$tmp_file"
  mv "$tmp_file" "$TARGET_DIR/hooks.json"
fi

echo ""
echo "✓ Installation complete!"
echo ""
echo "Hooks installed to: $TARGET_DIR/hooks.json"
echo "Scripts installed to: $HOOKS_DIR"
echo ""
echo "Next steps:"
echo "1. Ensure claude-mem worker is running:"
echo "   cd ~/.claude/plugins/marketplaces/thedotmack && npm run worker:start"
echo ""
echo "2. Restart Cursor to load the hooks"
echo ""
echo "3. Check Cursor Settings → Hooks tab to verify hooks are active"
echo ""

