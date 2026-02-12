#!/usr/bin/env bash
set -euo pipefail

# Test suite for openclaw/install.sh functions
# Tests the OpenClaw gateway detection, plugin install, and memory slot config.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SCRIPT="${SCRIPT_DIR}/install.sh"

TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

###############################################################################
# Test helpers
###############################################################################

test_pass() {
  TESTS_RUN=$((TESTS_RUN + 1))
  TESTS_PASSED=$((TESTS_PASSED + 1))
  echo -e "\033[0;32m✓\033[0m  $1"
}

test_fail() {
  TESTS_RUN=$((TESTS_RUN + 1))
  TESTS_FAILED=$((TESTS_FAILED + 1))
  echo -e "\033[0;31m✗\033[0m  $1"
  if [[ -n "${2:-}" ]]; then
    echo "     Detail: $2"
  fi
}

assert_eq() {
  local expected="$1" actual="$2" msg="$3"
  if [[ "$expected" == "$actual" ]]; then
    test_pass "$msg"
  else
    test_fail "$msg" "expected='${expected}' actual='${actual}'"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" msg="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    test_pass "$msg"
  else
    test_fail "$msg" "expected string to contain '${needle}'"
  fi
}

assert_file_exists() {
  local filepath="$1" msg="$2"
  if [[ -f "$filepath" ]]; then
    test_pass "$msg"
  else
    test_fail "$msg" "file not found: ${filepath}"
  fi
}

###############################################################################
# Source the install script without running main()
# We override main to be a no-op, then source the file.
###############################################################################

source_install_functions() {
  # Create a temp file that overrides main and sources the install script
  local tmp_source
  tmp_source="$(mktemp)"
  # Extract everything except the final `main "$@"` invocation
  sed '$ d' "$INSTALL_SCRIPT" > "$tmp_source"
  # Override main to prevent execution
  echo 'main() { :; }' >> "$tmp_source"
  # Source it (suppress color output for cleaner tests)
  TERM=dumb source "$tmp_source"
  rm -f "$tmp_source"
}

source_install_functions

###############################################################################
# Test: find_openclaw() — not found scenario
###############################################################################

echo ""
echo "=== find_openclaw() ==="

# Save original PATH and test with empty locations
ORIGINAL_PATH="$PATH"
ORIGINAL_HOME="$HOME"

test_find_openclaw_not_found() {
  # Use a fake HOME where nothing exists
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"
  PATH="/nonexistent"
  OPENCLAW_PATH=""

  if find_openclaw 2>/dev/null; then
    test_fail "find_openclaw should return 1 when openclaw.mjs is not found"
  else
    test_pass "find_openclaw returns 1 when not found"
  fi

  assert_eq "" "$OPENCLAW_PATH" "OPENCLAW_PATH is empty when not found"

  HOME="$ORIGINAL_HOME"
  PATH="$ORIGINAL_PATH"
  rm -rf "$fake_home"
}

test_find_openclaw_not_found

# Test: find_openclaw() — found in HOME/.openclaw/
test_find_openclaw_in_home() {
  local fake_home
  fake_home="$(mktemp -d)"
  mkdir -p "${fake_home}/.openclaw"
  touch "${fake_home}/.openclaw/openclaw.mjs"

  HOME="$fake_home"
  PATH="/nonexistent"
  OPENCLAW_PATH=""

  if find_openclaw 2>/dev/null; then
    test_pass "find_openclaw finds openclaw.mjs in ~/.openclaw/"
    assert_eq "${fake_home}/.openclaw/openclaw.mjs" "$OPENCLAW_PATH" "OPENCLAW_PATH set correctly"
  else
    test_fail "find_openclaw should find openclaw.mjs in ~/.openclaw/"
  fi

  HOME="$ORIGINAL_HOME"
  PATH="$ORIGINAL_PATH"
  rm -rf "$fake_home"
}

test_find_openclaw_in_home

###############################################################################
# Test: configure_memory_slot() — creates new config
###############################################################################

echo ""
echo "=== configure_memory_slot() ==="

test_configure_new_config() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"

  configure_memory_slot >/dev/null 2>&1

  local config_file="${fake_home}/.openclaw/openclaw.json"
  assert_file_exists "$config_file" "Config file created at ~/.openclaw/openclaw.json"

  # Verify JSON structure
  local memory_slot
  memory_slot="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.slots.memory);")"
  assert_eq "claude-mem" "$memory_slot" "Memory slot set to claude-mem in new config"

  local enabled
  enabled="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].enabled);")"
  assert_eq "true" "$enabled" "claude-mem entry is enabled in new config"

  local worker_port
  worker_port="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].config.workerPort);")"
  assert_eq "37777" "$worker_port" "Worker port is 37777 in new config"

  HOME="$ORIGINAL_HOME"
  rm -rf "$fake_home"
}

test_configure_new_config

# Test: configure_memory_slot() — updates existing config
test_configure_existing_config() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"

  # Create an existing config with other settings
  mkdir -p "${fake_home}/.openclaw"
  local config_file="${fake_home}/.openclaw/openclaw.json"
  node -e "
    const config = {
      gateway: { mode: 'local' },
      plugins: {
        slots: { memory: 'memory-core' },
        entries: {
          'some-other-plugin': { enabled: true }
        }
      }
    };
    require('fs').writeFileSync('${config_file}', JSON.stringify(config, null, 2));
  "

  configure_memory_slot >/dev/null 2>&1

  # Verify memory slot was updated
  local memory_slot
  memory_slot="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.slots.memory);")"
  assert_eq "claude-mem" "$memory_slot" "Memory slot updated from memory-core to claude-mem"

  # Verify existing settings preserved
  local gateway_mode
  gateway_mode="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.gateway.mode);")"
  assert_eq "local" "$gateway_mode" "Existing gateway.mode setting preserved"

  # Verify other plugin still present
  local other_plugin
  other_plugin="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['some-other-plugin'].enabled);")"
  assert_eq "true" "$other_plugin" "Existing plugin entries preserved"

  # Verify claude-mem entry was added
  local cm_enabled
  cm_enabled="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].enabled);")"
  assert_eq "true" "$cm_enabled" "claude-mem entry added and enabled"

  HOME="$ORIGINAL_HOME"
  rm -rf "$fake_home"
}

test_configure_existing_config

# Test: configure_memory_slot() — preserves existing claude-mem config
test_configure_preserves_existing_cm_config() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"

  mkdir -p "${fake_home}/.openclaw"
  local config_file="${fake_home}/.openclaw/openclaw.json"
  node -e "
    const config = {
      plugins: {
        slots: { memory: 'memory-core' },
        entries: {
          'claude-mem': {
            enabled: false,
            config: {
              workerPort: 38888,
              observationFeed: { enabled: true, channel: 'telegram', to: '12345' }
            }
          }
        }
      }
    };
    require('fs').writeFileSync('${config_file}', JSON.stringify(config, null, 2));
  "

  configure_memory_slot >/dev/null 2>&1

  # Should enable it but preserve existing config
  local cm_enabled
  cm_enabled="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].enabled);")"
  assert_eq "true" "$cm_enabled" "claude-mem entry enabled when previously disabled"

  local custom_port
  custom_port="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].config.workerPort);")"
  assert_eq "38888" "$custom_port" "Existing custom workerPort preserved"

  local feed_channel
  feed_channel="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].config.observationFeed.channel);")"
  assert_eq "telegram" "$feed_channel" "Existing observationFeed config preserved"

  HOME="$ORIGINAL_HOME"
  rm -rf "$fake_home"
}

test_configure_preserves_existing_cm_config

###############################################################################
# Test: version_gte() — already exists from phase 1
###############################################################################

echo ""
echo "=== version_gte() ==="

if version_gte "1.2.0" "1.1.14"; then
  test_pass "version_gte: 1.2.0 >= 1.1.14"
else
  test_fail "version_gte: 1.2.0 >= 1.1.14"
fi

if version_gte "1.1.14" "1.1.14"; then
  test_pass "version_gte: 1.1.14 >= 1.1.14 (equal)"
else
  test_fail "version_gte: 1.1.14 >= 1.1.14 (equal)"
fi

if ! version_gte "1.0.0" "1.1.14"; then
  test_pass "version_gte: 1.0.0 < 1.1.14"
else
  test_fail "version_gte: 1.0.0 < 1.1.14"
fi

###############################################################################
# Test: Script structure validation
###############################################################################

echo ""
echo "=== Script structure ==="

# Verify all required functions exist
for fn in find_openclaw check_openclaw install_plugin configure_memory_slot; do
  if declare -f "$fn" &>/dev/null; then
    test_pass "Function ${fn}() is defined"
  else
    test_fail "Function ${fn}() should be defined"
  fi
done

# Verify the CLAUDE_MEM_REPO constant
assert_contains "$CLAUDE_MEM_REPO" "github.com/thedotmack/claude-mem" "CLAUDE_MEM_REPO points to correct repository"

###############################################################################
# Summary
###############################################################################

echo ""
echo "========================================"
echo "Results: ${TESTS_PASSED}/${TESTS_RUN} passed, ${TESTS_FAILED} failed"
echo "========================================"

if [[ "$TESTS_FAILED" -gt 0 ]]; then
  exit 1
fi

exit 0
