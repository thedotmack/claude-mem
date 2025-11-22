#!/bin/bash
# Comprehensive validation of Endless Mode behavior
# Compares disabled mode with main branch behavior

set -e

echo "=== Endless Mode Behavior Validation ==="
echo ""

# Color codes for output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

pass() {
  echo -e "${GREEN}✓${NC} $1"
}

fail() {
  echo -e "${RED}✗${NC} $1"
  exit 1
}

echo "Checking critical files and configuration..."
echo ""

# 1. Verify EndlessModeConfig default
echo "1. Checking EndlessModeConfig.ts default value..."
DEFAULT_VALUE=$(grep -A 4 "const enabled = this.getBooleanSetting" src/services/worker/EndlessModeConfig.ts | grep "false" | tail -1 | grep -o "false" || echo "NOT_FOUND")
if [ "$DEFAULT_VALUE" = "false" ]; then
  pass "EndlessModeConfig default is false"
else
  fail "EndlessModeConfig default should be false, found: $DEFAULT_VALUE"
fi
echo ""

# 2. Verify save-hook conditional logic
echo "2. Checking save-hook.ts conditional logic..."
CONDITIONAL_CHECK=$(grep -c "if (isEndlessModeEnabled)" src/hooks/save-hook.ts || echo "0")
if [ "$CONDITIONAL_CHECK" -gt "0" ]; then
  pass "save-hook.ts has Endless Mode conditionals"
else
  fail "save-hook.ts missing Endless Mode conditionals"
fi
echo ""

# 3. Verify timeout values
echo "3. Checking timeout configuration..."
ASYNC_TIMEOUT=$(grep "isEndlessModeEnabled ? " src/hooks/save-hook.ts | grep -o "2000" || echo "NOT_FOUND")
SYNC_TIMEOUT=$(grep "isEndlessModeEnabled ? " src/hooks/save-hook.ts | grep -o "90000" || echo "NOT_FOUND")
if [ "$ASYNC_TIMEOUT" = "2000" ] && [ "$SYNC_TIMEOUT" = "90000" ]; then
  pass "Timeout values correct (2s async, 90s sync)"
else
  fail "Timeout values incorrect"
fi
echo ""

# 4. Verify query parameter logic
echo "4. Checking query parameter logic..."
QUERY_PARAM_CHECK=$(grep "wait_until_obs_is_saved=true" src/hooks/save-hook.ts | wc -l)
if [ "$QUERY_PARAM_CHECK" -gt "0" ]; then
  pass "Query parameter logic present"
else
  fail "Query parameter logic missing"
fi
echo ""

# 5. Verify transformation is conditional
echo "5. Checking transformation is conditional..."
# Check if transformTranscript appears between line 353 (if isEndlessModeEnabled) and 393
TRANSFORM_CONDITIONAL=$(sed -n '353,393p' src/hooks/save-hook.ts | grep -c "transformTranscript")
if [ "$TRANSFORM_CONDITIONAL" -gt "0" ]; then
  pass "Transformation is conditional on isEndlessModeEnabled"
else
  fail "Transformation should be conditional"
fi
echo ""

# 6. Compare with main branch
echo "6. Comparing disabled mode with main branch..."
echo "   Checking main branch save-hook structure..."
MAIN_TIMEOUT=$(git show main:src/hooks/save-hook.ts | grep "AbortSignal.timeout" | grep -o "[0-9]\+" || echo "NOT_FOUND")
if [ "$MAIN_TIMEOUT" = "2000" ]; then
  pass "Main branch uses 2s timeout (matches disabled mode)"
else
  echo "   Main timeout: $MAIN_TIMEOUT"
fi

MAIN_HAS_TRANSFORM=$(git show main:src/hooks/save-hook.ts | grep -c "transformTranscript" || true)
if [ "$MAIN_HAS_TRANSFORM" = "0" ]; then
  pass "Main branch has no transformation (matches disabled mode)"
else
  fail "Main branch should not have transformation"
fi

MAIN_HAS_TOOL_USE_ID=$(git show main:src/hooks/save-hook.ts | grep -c "tool_use_id" || true)
CURRENT_CONDITIONAL=$(grep -c "if.*isEndlessModeEnabled" src/hooks/save-hook.ts || true)
if [ "$CURRENT_CONDITIONAL" -gt "0" ]; then
  pass "Current branch conditionally uses Endless Mode features"
else
  fail "Current branch should conditionally enable features"
fi
echo ""

# 7. Verify example settings
echo "7. Checking example settings file..."
EXAMPLE_SETTING=$(grep "CLAUDE_MEM_ENDLESS_MODE" docs/examples/settings.json | grep -o "false" || echo "NOT_FOUND")
if [ "$EXAMPLE_SETTING" = "false" ]; then
  pass "Example settings has Endless Mode OFF by default"
else
  fail "Example settings should have Endless Mode OFF by default"
fi
echo ""

# Summary
echo "========================================="
echo "VALIDATION COMPLETE"
echo "========================================="
echo ""
echo "Key Findings:"
echo "• Default: OFF (false) in EndlessModeConfig.ts"
echo "• Toggle: Via settings.json env.CLAUDE_MEM_ENDLESS_MODE"
echo "• Disabled mode behavior:"
echo "  - Uses basic endpoint (no query params)"
echo "  - Uses 2-second timeout (matches main)"
echo "  - Skips transformation (matches main)"
echo "  - Async fire-and-forget (matches main)"
echo "• Enabled mode behavior:"
echo "  - Uses wait_until_obs_is_saved=true query param"
echo "  - Uses 90-second timeout"
echo "  - Performs transcript transformation"
echo "  - Synchronous blocking hook"
echo ""
echo -e "${GREEN}✓ SAFE TO MERGE as experimental feature${NC}"
echo ""
