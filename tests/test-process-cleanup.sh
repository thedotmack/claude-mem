#!/bin/bash
# Test script to verify process cleanup
# This script tests that uvx/python processes are properly cleaned up

set -e

echo "=== Process Cleanup Test ==="
echo ""

# Function to count uvx/python processes
count_processes() {
    local count=$(ps aux | grep -E "(uvx|python.*chroma)" | grep -v grep | wc -l)
    echo "$count"
}

# Initial count
echo "1. Initial process count:"
initial=$(count_processes)
echo "   uvx/python/chroma processes: $initial"
echo ""

# Start a node process that creates ChromaSync
echo "2. Starting test process that creates ChromaSync..."
cat > /tmp/test-chroma-cleanup.mjs << 'EOF'
import { ChromaSync } from './src/services/sync/ChromaSync.js';

const sync = new ChromaSync('test-project');

console.log('[TEST] ChromaSync created, connecting...');

// Try to connect (this spawns uvx process)
try {
  await sync.ensureBackfilled();
  console.log('[TEST] Backfill started');
} catch (error) {
  console.log('[TEST] Backfill failed (expected if no data):', error.message);
}

// Wait a bit for process to start
await new Promise(resolve => setTimeout(resolve, 2000));

const countBefore = parseInt(process.env.COUNT_BEFORE || '0');
const countAfter = process.argv[2];

console.log('[TEST] Process count before:', countBefore);

// Close the sync (should terminate uvx process)
console.log('[TEST] Closing ChromaSync...');
await sync.close();

// Wait for process to terminate
await new Promise(resolve => setTimeout(resolve, 1000));

console.log('[TEST] ChromaSync closed, process should be terminated');
process.exit(0);
EOF

# Run test
COUNT_BEFORE=$initial node /tmp/test-chroma-cleanup.mjs 2>&1 &
TEST_PID=$!

# Wait for process to spawn
sleep 3

# Count during execution
during=$(count_processes)
echo "   During execution: $during processes"
echo ""

# Wait for test to complete
wait $TEST_PID 2>/dev/null || true

# Wait a bit for cleanup
sleep 2

# Final count
echo "3. Final process count:"
final=$(count_processes)
echo "   uvx/python/chroma processes: $final"
echo ""

# Check if we leaked processes
leaked=$((final - initial))
if [ $leaked -gt 0 ]; then
    echo "❌ FAIL: Leaked $leaked process(es)"
    echo ""
    echo "Current processes:"
    ps aux | grep -E "(uvx|python.*chroma)" | grep -v grep
    exit 1
else
    echo "✅ PASS: No process leaks detected"
fi

# Cleanup
rm -f /tmp/test-chroma-cleanup.mjs
