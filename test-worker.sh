#!/bin/bash
set -e

echo "Creating session..."
echo '{"session_id":"test-socket-789","cwd":"/Users/alexnewman/Scripts/claude-mem","prompt":"testing"}' | bun src/bin/cli.ts new

sleep 1

SESSION_ID=$(sqlite3 ~/.claude-mem/claude-mem.db "SELECT id FROM sdk_sessions ORDER BY id DESC LIMIT 1;")
echo "Session ID: $SESSION_ID"

echo "Starting worker..."
bun src/sdk/worker.ts $SESSION_ID 2>&1 &
WORKER_PID=$!
echo "Worker PID: $WORKER_PID"

sleep 3

if ps -p $WORKER_PID > /dev/null 2>&1; then
  echo "✅ Worker is RUNNING!"
  if [ -e ~/.claude-mem/worker-$SESSION_ID.sock ]; then
    echo "✅ Socket file exists!"
    ls -la ~/.claude-mem/worker-$SESSION_ID.sock
  else
    echo "❌ Socket file NOT found"
  fi

  # Try to send a message
  echo "Sending test observation..."
  echo '{"type":"observation","tool_name":"TestTool","tool_input":"{}","tool_output":"{}"}' | nc -U ~/.claude-mem/worker-$SESSION_ID.sock
  echo "Message sent!"

  sleep 2

  # Send finalize
  echo "Sending finalize..."
  echo '{"type":"finalize"}' | nc -U ~/.claude-mem/worker-$SESSION_ID.sock

  sleep 2
  if ps -p $WORKER_PID > /dev/null 2>&1; then
    echo "⚠️  Worker still running after finalize"
    kill $WORKER_PID
  else
    echo "✅ Worker exited cleanly after finalize"
  fi
else
  echo "❌ Worker exited prematurely"
fi
