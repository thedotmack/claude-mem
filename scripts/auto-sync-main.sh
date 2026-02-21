#!/bin/bash
# Auto-sync main into feature/titans-with-pipeline
# Safe to run unattended: aborts on conflict instead of leaving broken state

set -euo pipefail

REPO="/Users/laihenyi/Documents/GitHub/claude-mem"
LOG_DIR="$HOME/.claude-mem/logs"
LOG_FILE="$LOG_DIR/auto-sync.log"
BRANCH="feature/titans-with-pipeline"

# Absolute paths (cron has minimal PATH)
GIT="/opt/homebrew/bin/git"
NODE="/opt/homebrew/bin/node"
NPM="/opt/homebrew/bin/npm"
BUN="$HOME/.bun/bin/bun"

mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

log "=== auto-sync-main start ==="
cd "$REPO"

# Ensure we're on the right branch
CURRENT=$($GIT branch --show-current)
if [ "$CURRENT" != "$BRANCH" ]; then
  log "Switching from $CURRENT → $BRANCH"
  $GIT checkout "$BRANCH"
fi

# Fetch latest from upstream (origin = thedotmack/claude-mem)
log "Fetching origin..."
$GIT fetch origin >> "$LOG_FILE" 2>&1

# Check if main has new commits
LOCAL_MAIN=$($GIT rev-parse main 2>/dev/null || $GIT rev-parse origin/main)
ORIGIN_MAIN=$($GIT rev-parse origin/main)
if [ "$LOCAL_MAIN" != "$ORIGIN_MAIN" ]; then
  log "Updating local main → $(echo $ORIGIN_MAIN | cut -c1-8)"
  $GIT fetch origin main:main >> "$LOG_FILE" 2>&1
fi

# Check if merge is needed
BEHIND=$($GIT rev-list --count HEAD..main)
if [ "$BEHIND" -eq 0 ]; then
  log "Already up to date with main. Nothing to do."
  log "=== auto-sync-main done ==="
  exit 0
fi

log "$BEHIND new commit(s) from main to merge"

# Attempt merge (--no-edit to avoid interactive prompt)
if ! $GIT merge main --no-edit >> "$LOG_FILE" 2>&1; then
  log "ERROR: Merge conflict detected! Aborting merge."
  log "Please resolve manually: cd $REPO && git status"
  $GIT merge --abort >> "$LOG_FILE" 2>&1 || true
  log "=== auto-sync-main FAILED (conflict) ==="
  exit 1
fi

log "Merge successful. Building artifacts..."

# Build
if ! $NODE scripts/build-hooks.js >> "$LOG_FILE" 2>&1; then
  log "ERROR: Build failed!"
  log "=== auto-sync-main FAILED (build) ==="
  exit 1
fi

log "Build done. Deploying to marketplace..."

# Deploy (deploy-local.sh uses its own paths)
if ! bash "$REPO/scripts/deploy-local.sh" >> "$LOG_FILE" 2>&1; then
  log "ERROR: Deploy failed!"
  log "=== auto-sync-main FAILED (deploy) ==="
  exit 1
fi

log "=== auto-sync-main done ✓ ==="
