#!/usr/bin/env bash
# inspect-failed.sh - View and optionally delete failed pending_messages
#
# Usage:
#   ./scripts/inspect-failed.sh              # Show all failed items
#   ./scripts/inspect-failed.sh --delete     # Interactively delete failed items
#   ./scripts/inspect-failed.sh --delete-all # Delete all failed items without prompting
#   ./scripts/inspect-failed.sh --session <session_id>  # Filter by session ID

set -euo pipefail

DB="${HOME}/.claude-mem/claude-mem.db"
MODE="show"
SESSION_FILTER=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete)     MODE="delete"; shift ;;
    --delete-all) MODE="delete-all"; shift ;;
    --session)    SESSION_FILTER="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--delete | --delete-all] [--session <session_id>]"
      echo ""
      echo "  (no flags)     Show failed items with content preview"
      echo "  --delete       Prompt to delete each failed item"
      echo "  --delete-all   Delete all failed items without prompting"
      echo "  --session ID   Filter to a specific content_session_id"
      exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1 ;;
  esac
done

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

# Build WHERE clause
WHERE="status = 'failed'"
if [ -n "$SESSION_FILTER" ]; then
  WHERE="${WHERE} AND content_session_id = '${SESSION_FILTER}'"
fi

# Show queue summary
echo "=== Queue Status ==="
sqlite3 "$DB" "SELECT status, COUNT(*) as count FROM pending_messages GROUP BY status ORDER BY status;"
echo ""

# Count failed
FAILED_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pending_messages WHERE ${WHERE};")

if [ "$FAILED_COUNT" -eq 0 ]; then
  echo "No failed messages${SESSION_FILTER:+ for session $SESSION_FILTER}."
  exit 0
fi

echo "=== Failed Messages (${FAILED_COUNT}) ==="
echo ""

# Fetch failed rows: id, session, type, tool, retry_count, created, failed, tool_response snippet
sqlite3 -separator $'\t' "$DB" "
  SELECT
    id,
    content_session_id,
    message_type,
    COALESCE(tool_name, '—'),
    retry_count,
    COALESCE(datetime(created_at_epoch, 'unixepoch', 'localtime'), '—'),
    COALESCE(datetime(failed_at_epoch,   'unixepoch', 'localtime'), '—'),
    COALESCE(substr(tool_response, 1, 120), substr(last_assistant_message, 1, 120), '—')
  FROM pending_messages
  WHERE ${WHERE}
  ORDER BY id;
" | while IFS=$'\t' read -r id sess_id msg_type tool retries created failed preview; do
  echo "ID: ${id}"
  echo "  Session : ${sess_id}"
  echo "  Type    : ${msg_type}  Tool: ${tool}  Retries: ${retries}"
  echo "  Created : ${created}"
  echo "  Failed  : ${failed}"
  echo "  Preview : ${preview}"
  echo ""

  if [ "$MODE" = "delete" ]; then
    read -r -p "  Delete ID ${id}? [y/N] " answer
    if [[ "${answer,,}" == "y" ]]; then
      sqlite3 "$DB" "DELETE FROM pending_messages WHERE id = ${id};"
      echo "  Deleted."
    else
      echo "  Skipped."
    fi
    echo ""
  fi
done

if [ "$MODE" = "delete-all" ]; then
  echo "Deleting all ${FAILED_COUNT} failed message(s)${SESSION_FILTER:+ for session $SESSION_FILTER}..."
  sqlite3 "$DB" "DELETE FROM pending_messages WHERE ${WHERE};"
  REMAINING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pending_messages WHERE status = 'failed';")
  echo "Done. Remaining failed: ${REMAINING}"
fi
