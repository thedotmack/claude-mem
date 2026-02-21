#!/bin/bash
# Deploy local claude-mem to marketplace (no git branch checks)
# Usage: bash scripts/deploy-local.sh

set -e
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKET="$HOME/.claude/plugins/marketplaces/thedotmack"
VERSION=$(node -p "require('$REPO/package.json').version")

echo "Deploying claude-mem v$VERSION → $MARKET"

# Preserve node_modules across sync
if [ -d "$MARKET/node_modules" ]; then
  mv "$MARKET/node_modules" /tmp/claude-mem-nm-backup
fi

rsync -a --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='.claude-mem/' \
  "$REPO/" "$MARKET/"

# Restore node_modules
if [ -d /tmp/claude-mem-nm-backup ]; then
  mv /tmp/claude-mem-nm-backup "$MARKET/node_modules"
fi

# Update .install-version
node -e "
const fs = require('fs');
const { execSync } = require('child_process');
const bun = (() => { try { return execSync('bun --version', {encoding:'utf8'}).trim(); } catch { return 'unknown'; } })();
const uv  = (() => { try { return execSync('uv --version',  {encoding:'utf8'}).trim(); } catch { return 'unknown'; } })();
fs.writeFileSync('$MARKET/.install-version', JSON.stringify({ version: '$VERSION', bun, uv, installedAt: new Date().toISOString() }, null, 2));
"

echo "✅ Deployed v$VERSION. Restarting worker..."
curl -s -X POST http://127.0.0.1:37777/api/admin/shutdown > /dev/null 2>&1 || true
sleep 1
node "$MARKET/plugin/scripts/bun-runner.js" "$MARKET/plugin/scripts/worker-service.cjs" start
echo "✅ Done"
