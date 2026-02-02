#!/bin/bash
# Bun runner script - finds and runs bun even if not in PATH
# This handles the case where bun was just installed but PATH isn't updated yet

# Try bun in PATH first
if command -v bun &> /dev/null; then
    exec bun "$@"
fi

# Check common installation paths
BUN_PATHS=(
    "$HOME/.bun/bin/bun"
    "/usr/local/bin/bun"
    "/opt/homebrew/bin/bun"
)

for BUN_PATH in "${BUN_PATHS[@]}"; do
    if [ -x "$BUN_PATH" ]; then
        exec "$BUN_PATH" "$@"
    fi
done

# Bun not found - try to install it
echo "🔧 Bun not found. Installing..." >&2
curl -fsSL https://bun.sh/install | bash >&2

# Try again after installation
if [ -x "$HOME/.bun/bin/bun" ]; then
    exec "$HOME/.bun/bin/bun" "$@"
fi

echo "❌ Failed to find or install bun. Please install manually: curl -fsSL https://bun.sh/install | bash" >&2
exit 1
