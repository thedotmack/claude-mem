#!/bin/bash
set -euo pipefail

# Query worker's own health endpoint for accurate heap stats
HEALTH=$(curl -s http://localhost:37777/health 2>&1)

if [ $? -ne 0 ]; then
    echo "❌ Could not connect to worker - may be down"
    exit 1
fi

# Extract heap stats using jq
USED=$(echo "$HEALTH" | jq -r '.heap.used_mb')
LIMIT=$(echo "$HEALTH" | jq -r '.heap.limit_mb')

if [ -z "$USED" ] || [ -z "$LIMIT" ] || [ "$USED" == "null" ] || [ "$LIMIT" == "null" ]; then
    echo "❌ Could not read heap stats from worker"
    exit 1
fi

# Calculate actual percentage (used / limit)
HEAP=$(echo "scale=2; ($USED / $LIMIT) * 100" | bc)

echo "Current heap usage: ${USED}MB / ${LIMIT}MB (${HEAP}%)"

if (( $(echo "$HEAP > 90" | bc -l) )); then
    echo "⚠️  CRITICAL: Heap at ${HEAP}% - restart recommended"
    echo "Run: cd ~/.claude/plugins/marketplaces/thedotmack && node_modules/.bin/pm2 restart claude-mem-worker"
    exit 2
elif (( $(echo "$HEAP > 80" | bc -l) )); then
    echo "⚠️  WARNING: Heap at ${HEAP}% - monitor closely"
    exit 1
else
    echo "✅ Heap usage is healthy"
    exit 0
fi
