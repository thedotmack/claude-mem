#!/bin/bash
set -euo pipefail

# Default options
PORT=37777
QUIET=false
JSON_OUTPUT=false
VERBOSE=false

# Show help menu using heredoc
show_help() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Check claude-mem worker heap health using accurate V8 statistics.

OPTIONS:
    -h          Show this help message
    -p PORT     Worker port (default: 37777)
    -q          Quiet mode (exit code only, no output)
    -j          JSON output
    -v          Verbose mode (show all heap stats)
    -d          Debug mode (show executed commands)

EXIT CODES:
    0           Healthy (< 80% heap usage)
    1           Warning (80-90% heap usage)
    2           Critical (> 90% heap usage)

EXAMPLES:
    $(basename "$0")              # Standard check
    $(basename "$0") -v           # Verbose with all stats
    $(basename "$0") -j           # JSON output for monitoring
    $(basename "$0") -q           # Silent (for scripts)
    DEBUG=1 $(basename "$0")      # Enable debug mode via env var

WHY THIS SCRIPT:
PM2's "Heap Usage" divides used heap by currently allocated heap, not
the --max-old-space-size limit. This gives misleading percentages.
This script queries the worker's /health endpoint for accurate V8 heap
statistics: used / limit.
EOF
}

# Parse command-line options
while getopts "hp:qjvd" opt; do
    case $opt in
        h)
            show_help
            exit 0
            ;;
        p)
            PORT=$OPTARG
            ;;
        q)
            QUIET=true
            ;;
        j)
            JSON_OUTPUT=true
            ;;
        v)
            VERBOSE=true
            ;;
        d)
            set -x
            ;;
        \?)
            echo "Invalid option: -$OPTARG" >&2
            show_help
            exit 1
            ;;
    esac
done

# Enable debug mode via environment variable
[[ "${DEBUG:-}" == "1" ]] && set -x

# Query worker's own health endpoint for accurate heap stats
HEALTH=$(curl -s "http://localhost:${PORT}/health" 2>&1)

if [ $? -ne 0 ]; then
    [[ "$QUIET" == false ]] && echo "❌ Could not connect to worker on port ${PORT} - may be down"
    exit 1
fi

# Extract heap stats using jq
USED=$(echo "$HEALTH" | jq -r '.heap.used_mb')
LIMIT=$(echo "$HEALTH" | jq -r '.heap.limit_mb')
TOTAL=$(echo "$HEALTH" | jq -r '.heap.total_mb')

if [ -z "$USED" ] || [ -z "$LIMIT" ] || [ "$USED" == "null" ] || [ "$LIMIT" == "null" ]; then
    [[ "$QUIET" == false ]] && echo "❌ Could not read heap stats from worker"
    exit 1
fi

# Calculate actual percentage (used / limit)
HEAP=$(echo "scale=2; ($USED / $LIMIT) * 100" | bc)

# Determine status and exit code
if (( $(echo "$HEAP > 90" | bc -l) )); then
    STATUS="CRITICAL"
    EXIT_CODE=2
elif (( $(echo "$HEAP > 80" | bc -l) )); then
    STATUS="WARNING"
    EXIT_CODE=1
else
    STATUS="HEALTHY"
    EXIT_CODE=0
fi

# Output based on mode
if [[ "$JSON_OUTPUT" == true ]]; then
    # JSON output for monitoring/scripting
    cat <<EOF
{
  "status": "$STATUS",
  "heap": {
    "used_mb": $USED,
    "limit_mb": $LIMIT,
    "total_mb": $TOTAL,
    "percentage": $HEAP
  },
  "exit_code": $EXIT_CODE
}
EOF
elif [[ "$QUIET" == false ]]; then
    # Human-readable output
    if [[ "$VERBOSE" == true ]]; then
        echo "Heap Statistics:"
        echo "  Used:       ${USED} MB"
        echo "  Allocated:  ${TOTAL} MB"
        echo "  Limit:      ${LIMIT} MB"
        echo "  Usage:      ${HEAP}%"
        echo ""
    else
        echo "Current heap usage: ${USED}MB / ${LIMIT}MB (${HEAP}%)"
    fi

    case $EXIT_CODE in
        2)
            echo "⚠️  CRITICAL: Heap at ${HEAP}% - restart recommended"
            echo "Run: cd ~/.claude/plugins/marketplaces/thedotmack && node_modules/.bin/pm2 restart claude-mem-worker"
            ;;
        1)
            echo "⚠️  WARNING: Heap at ${HEAP}% - monitor closely"
            ;;
        0)
            echo "✅ Heap usage is healthy"
            ;;
    esac
fi

exit $EXIT_CODE
