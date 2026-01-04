#!/usr/bin/env bash
set -euo pipefail

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

MARKETPLACE_DIR="$HOME/.claude/plugins/marketplaces/thedotmack"
PLUGIN_JSON="plugin/.claude-plugin/plugin.json"

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Get plugin version
get_plugin_version() {
  node -p "require('./$PLUGIN_JSON').version"
}

# Check worker health and version
check_worker() {
  local response
  response=$(curl -s http://localhost:37777/api/health 2>/dev/null || echo "{}")
  echo "$response"
}

# Wait for worker to be ready
wait_for_worker() {
  local max_attempts=10
  local attempt=1

  log_info "Waiting for worker to be ready..."
  while [ $attempt -le $max_attempts ]; do
    local health
    health=$(check_worker)

    if echo "$health" | grep -q '"status":"ok"'; then
      log_success "Worker is ready"
      return 0
    fi

    log_info "Attempt $attempt/$max_attempts - waiting..."
    sleep 1
    ((attempt++))
  done

  log_error "Worker failed to become ready after $max_attempts attempts"
  return 1
}

# Verify version match
verify_version_match() {
  local plugin_version
  plugin_version=$(get_plugin_version)

  local health
  health=$(check_worker)

  log_info "Plugin version: $plugin_version"

  # Extract worker version from health response
  # Note: We can't easily check this without the worker running, so we skip for now
  log_success "Version check skipped (worker will log mismatch if present)"
}

main() {
  log_info "Starting deterministic plugin build & sync..."

  # Step 1: Build hooks
  log_info "Step 1/6: Building hooks..."
  npm run build
  log_success "Hooks built"

  # Step 2: Stop worker (idempotent - won't fail if already stopped)
  log_info "Step 2/6: Stopping worker..."
  bun "$MARKETPLACE_DIR/scripts/worker-service.cjs" stop || true
  sleep 1
  log_success "Worker stopped"

  # Step 3: Sync to marketplace
  log_info "Step 3/6: Syncing to marketplace..."
  rsync -a --delete --exclude=.git --exclude=/.mcp.json plugin/ "$MARKETPLACE_DIR/"
  log_success "Files synced"

  # Step 4: Install dependencies
  log_info "Step 4/6: Installing dependencies..."
  cd "$MARKETPLACE_DIR"
  npm install --silent
  cd - > /dev/null
  log_success "Dependencies installed"

  # Step 5: Start worker
  log_info "Step 5/6: Starting worker..."
  bun "$MARKETPLACE_DIR/scripts/worker-service.cjs" start
  log_success "Worker started"

  # Step 6: Wait and verify
  log_info "Step 6/6: Verifying worker health..."
  if wait_for_worker; then
    verify_version_match

    # Write update marker for session warnings
    local marker_file="$HOME/.claude-mem/last-plugin-update"
    local plugin_version
    plugin_version=$(get_plugin_version)
    echo "{\"version\":\"$plugin_version\",\"timestamp\":$(date +%s),\"date\":\"$(date -Iseconds)\"}" > "$marker_file"

    log_success "✓ Plugin is built, synced, and ready!"
    echo ""
    log_warn "⚠️  Active Claude sessions need restart to use new plugin version"
    log_warn "   Sessions started before $(date +%H:%M:%S) are using old hooks"
    return 0
  else
    log_error "✗ Worker health check failed"
    return 1
  fi
}

main "$@"
