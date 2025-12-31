#!/bin/bash
# Claude-mem version switcher
# Usage: ./scripts/switch-version.sh [stable|dev|status]

set -e

CACHE_BASE="$HOME/.claude/plugins/cache/thedotmack/claude-mem"
MARKETPLACE="$HOME/.claude/plugins/marketplaces/thedotmack"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

show_status() {
    echo -e "${YELLOW}=== Claude-mem Version Status ===${NC}"
    echo ""

    # Current git branch
    echo -e "Git branch: ${GREEN}$(git rev-parse --abbrev-ref HEAD)${NC}"

    # Current installed version
    if [ -f "$MARKETPLACE/plugin/.claude-plugin/plugin.json" ]; then
        INSTALLED=$(cat "$MARKETPLACE/plugin/.claude-plugin/plugin.json" | grep '"version"' | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')
        echo -e "Installed version: ${GREEN}$INSTALLED${NC}"
    fi

    # Available cached versions
    echo ""
    echo "Available cached versions:"
    ls -1 "$CACHE_BASE" 2>/dev/null | while read ver; do
        echo "  - $ver"
    done

    # Worker status
    echo ""
    if curl -s http://localhost:37777/health > /dev/null 2>&1; then
        echo -e "Worker: ${GREEN}Running${NC}"
    else
        echo -e "Worker: ${RED}Stopped${NC}"
    fi
}

switch_to_stable() {
    echo -e "${YELLOW}Switching to stable (main branch)...${NC}"

    # Stop worker
    pkill -f "worker-service" 2>/dev/null || true
    sleep 1

    # Stash any changes
    if ! git diff --quiet; then
        echo "Stashing local changes..."
        git stash push -m "Auto-stash before switching to stable"
    fi

    # Switch to main
    git checkout main

    # Build and sync
    npm run build-and-sync

    echo -e "${GREEN}Switched to stable version${NC}"
}

switch_to_dev() {
    BRANCH="${1:-feature/titans-with-pipeline}"
    echo -e "${YELLOW}Switching to dev branch: $BRANCH${NC}"

    # Stop worker
    pkill -f "worker-service" 2>/dev/null || true
    sleep 1

    # Switch branch
    git checkout "$BRANCH"

    # Restore stash if exists
    if git stash list | grep -q "Auto-stash before switching"; then
        echo "Restoring stashed changes..."
        git stash pop
    fi

    # Build and sync
    npm run build-and-sync

    echo -e "${GREEN}Switched to dev branch: $BRANCH${NC}"
}

case "${1:-status}" in
    stable)
        switch_to_stable
        ;;
    dev)
        switch_to_dev "$2"
        ;;
    status)
        show_status
        ;;
    *)
        echo "Usage: $0 [stable|dev [branch]|status]"
        echo ""
        echo "Commands:"
        echo "  stable     - Switch to main branch (stable)"
        echo "  dev        - Switch to dev branch (default: feature/titans-with-pipeline)"
        echo "  dev <name> - Switch to specific branch"
        echo "  status     - Show current version status"
        exit 1
        ;;
esac
