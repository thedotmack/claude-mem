#!/usr/bin/env bash
# requeue-failed.sh - Reset failed pending_messages to pending and trigger processing
#
# Usage:
#   ./scripts/requeue-failed.sh          # Requeue all failed, process up to 50 sessions
#   ./scripts/requeue-failed.sh 10       # Process up to 10 sessions after requeue

set -euo pipefail

WORKER_URL="http://localhost:37777"
DB="${HOME}/.claude-mem/claude-mem.db"
LIMIT="${1:-50}"

# Check sqlite3 is available
if ! command -v sqlite3 &>/dev/null; then
  echo "Error: sqlite3 is not installed." >&2
  exit 1
fi

# Check database exists
if [ ! -f "$DB" ]; then
  echo "Error: Database not found at $DB" >&2
  exit 1
fi

# Check worker health
if ! curl -sf "${WORKER_URL}/api/health" >/dev/null 2>&1; then
  echo "Error: Worker is not running on port 37777." >&2
  echo "Start it with: cd ~/.claude/plugins/marketplaces/thedotmack && npm run worker:start" >&2
  exit 1
fi

# Show current queue status
echo "=== Queue Status (before) ==="
sqlite3 "$DB" "SELECT status, COUNT(*) FROM pending_messages GROUP BY status ORDER BY status;"
echo ""

# Count failed messages
FAILED_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pending_messages WHERE status = 'failed';")

if [ "$FAILED_COUNT" -eq 0 ]; then
  echo "No failed messages to requeue."
else
  # Reset failed → pending
  sqlite3 "$DB" "UPDATE pending_messages SET status = 'pending', retry_count = 0 WHERE status = 'failed';"
  echo "Reset ${FAILED_COUNT} failed message(s) to pending."
fi

echo ""

# Trigger processing
echo "Triggering processing (sessionLimit=${LIMIT})..."
RESPONSE=$(curl -s -X POST "${WORKER_URL}/api/pending-queue/process" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionLimit\": ${LIMIT}}")

if command -v jq &>/dev/null; then
  echo "$RESPONSE" | jq .
else
  echo "$RESPONSE"
fi
