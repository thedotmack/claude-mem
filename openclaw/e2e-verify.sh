#!/usr/bin/env bash

set -euo pipefail

PASS=0
FAIL=0
TOTAL=0

pass() {
  PASS=$((PASS + 1))
  TOTAL=$((TOTAL + 1))
  echo "  PASS: $1"
}

fail() {
  FAIL=$((FAIL + 1))
  TOTAL=$((TOTAL + 1))
  echo "  FAIL: $1"
}

section() {
  echo ""
  echo "=== $1 ==="
}

section "Phase 1: Plugin Discovery"

PLUGIN_LIST=$(node /app/openclaw.mjs plugins list 2>&1)
if echo "$PLUGIN_LIST" | grep -q "claude-mem"; then
  pass "Plugin appears in 'plugins list'"
else
  fail "Plugin NOT found in 'plugins list'"
  echo "$PLUGIN_LIST"
fi

PLUGIN_INFO=$(node /app/openclaw.mjs plugins info claude-mem 2>&1 || true)
if echo "$PLUGIN_INFO" | grep -qi "claude-mem"; then
  pass "Plugin info shows claude-mem details"
else
  fail "Plugin info failed"
  echo "$PLUGIN_INFO"
fi

if echo "$PLUGIN_LIST" | grep -A1 "claude-mem" | grep -qi "enabled\|loaded"; then
  pass "Plugin is enabled"
else
  if echo "$PLUGIN_INFO" | grep -qi "enabled\|loaded"; then
    pass "Plugin is enabled (via info)"
  else
    fail "Plugin does not appear enabled"
    echo "$PLUGIN_INFO"
  fi
fi

DOCTOR_OUT=$(node /app/openclaw.mjs plugins doctor 2>&1 || true)
if echo "$DOCTOR_OUT" | grep -qi "no.*issue\|0 issue"; then
  pass "Plugin doctor reports no issues"
else
  fail "Plugin doctor reports issues"
  echo "$DOCTOR_OUT"
fi

section "Phase 2: Plugin Files"

EXTENSIONS_DIR="/home/node/.openclaw/extensions/openclaw-plugin"
if [ ! -d "$EXTENSIONS_DIR" ]; then
  EXTENSIONS_DIR="/home/node/.openclaw/extensions/claude-mem"
  if [ ! -d "$EXTENSIONS_DIR" ]; then
    FOUND_DIR=$(find /home/node/.openclaw/extensions/ -name "openclaw.plugin.json" -exec dirname {} \; 2>/dev/null | head -1 || true)
    if [ -n "$FOUND_DIR" ]; then
      EXTENSIONS_DIR="$FOUND_DIR"
    fi
  fi
fi

if [ -d "$EXTENSIONS_DIR" ]; then
  pass "Plugin directory exists: $EXTENSIONS_DIR"
else
  fail "Plugin directory not found under /home/node/.openclaw/extensions/"
  ls -la /home/node/.openclaw/extensions/ 2>/dev/null || echo "  (extensions dir not found)"
fi

for FILE in "openclaw.plugin.json" "dist/index.js" "package.json"; do
  if [ -f "$EXTENSIONS_DIR/$FILE" ]; then
    pass "File exists: $FILE"
  else
    fail "File missing: $FILE"
  fi
done

section "Phase 3: Mock Worker + Plugin Integration"

echo "  Starting mock claude-mem worker..."
node /app/mock-worker.js &
MOCK_PID=$!

for i in $(seq 1 10); do
  if curl -sf http://localhost:37777/health > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if curl -sf http://localhost:37777/health > /dev/null 2>&1; then
  pass "Mock worker health check passed"
else
  fail "Mock worker health check failed"
  kill $MOCK_PID 2>/dev/null || true
fi

SSE_TEST=$(curl -s --max-time 2 http://localhost:37777/stream 2>/dev/null || true)
if echo "$SSE_TEST" | grep -q "connected"; then
  pass "SSE stream returns connected event"
else
  fail "SSE stream did not return connected event"
  echo "  Got: $(echo "$SSE_TEST" | head -5)"
fi

section "Phase 4: Gateway Startup with Plugin"

mkdir -p /home/node/.openclaw
cat > /home/node/.openclaw/openclaw.json << 'EOFCONFIG'
{
  "gateway": {
    "mode": "local",
    "auth": {
      "mode": "token",
      "token": "e2e-test-token"
    }
  },
  "plugins": {
    "slots": {
      "memory": "claude-mem"
    },
    "entries": {
      "claude-mem": {
        "enabled": true,
        "config": {
          "workerPort": 37777,
          "observationFeed": {
            "enabled": true,
            "channel": "telegram",
            "to": "test-chat-id-12345"
          }
        }
      }
    }
  }
}
EOFCONFIG

pass "OpenClaw config written with plugin enabled"

GATEWAY_LOG="/tmp/gateway.log"
echo "  Starting OpenClaw gateway (timeout 15s)..."
OPENCLAW_GATEWAY_TOKEN=e2e-test-token timeout 15 node /app/openclaw.mjs gateway --allow-unconfigured --verbose --token e2e-test-token > "$GATEWAY_LOG" 2>&1 &
GATEWAY_PID=$!

sleep 5

if kill -0 $GATEWAY_PID 2>/dev/null; then
  pass "Gateway process is running"
else
  fail "Gateway process exited early"
  echo "  Gateway log:"
  cat "$GATEWAY_LOG" 2>/dev/null | tail -30
fi

if grep -qi "claude-mem" "$GATEWAY_LOG" 2>/dev/null; then
  pass "Gateway log mentions claude-mem plugin"
else
  fail "Gateway log does not mention claude-mem"
  echo "  Gateway log (last 20 lines):"
  tail -20 "$GATEWAY_LOG" 2>/dev/null
fi

if grep -q "plugin loaded" "$GATEWAY_LOG" 2>/dev/null || grep -q "v1.0.0" "$GATEWAY_LOG" 2>/dev/null; then
  pass "Plugin load message found in gateway log"
else
  fail "Plugin load message not found"
fi

if grep -qi "observation feed" "$GATEWAY_LOG" 2>/dev/null; then
  pass "Observation feed activity in gateway log"
else
  fail "No observation feed activity detected"
fi

if grep -qi "connected.*SSE\|SSE.*stream\|connecting.*SSE" "$GATEWAY_LOG" 2>/dev/null; then
  pass "SSE connection activity detected"
else
  fail "No SSE connection activity in log"
fi

section "Cleanup"
kill $GATEWAY_PID 2>/dev/null || true
kill $MOCK_PID 2>/dev/null || true
wait $GATEWAY_PID 2>/dev/null || true
wait $MOCK_PID 2>/dev/null || true
echo "  Processes stopped."

echo ""
echo "==============================="
echo "  E2E Test Results"
echo "==============================="
echo "  Total:  $TOTAL"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "==============================="

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "  SOME TESTS FAILED"
  echo ""
  echo "  Full gateway log:"
  cat "$GATEWAY_LOG" 2>/dev/null
  exit 1
fi

echo ""
echo "  ALL TESTS PASSED"
exit 0
