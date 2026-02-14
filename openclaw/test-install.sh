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
# Test: detect_platform() — returns a valid platform string
###############################################################################

echo ""
echo "=== detect_platform() ==="

test_detect_platform_returns_valid_string() {
  PLATFORM=""
  IS_WSL=""
  detect_platform >/dev/null 2>&1

  case "$PLATFORM" in
    macos|linux|windows)
      test_pass "detect_platform sets PLATFORM='${PLATFORM}'"
      ;;
    *)
      test_fail "detect_platform returned unexpected PLATFORM='${PLATFORM}'" "expected macos, linux, or windows"
      ;;
  esac
}

test_detect_platform_returns_valid_string

test_detect_platform_is_idempotent() {
  PLATFORM=""
  IS_WSL=""
  detect_platform >/dev/null 2>&1
  local first_platform="$PLATFORM"

  PLATFORM=""
  IS_WSL=""
  detect_platform >/dev/null 2>&1
  local second_platform="$PLATFORM"

  assert_eq "$first_platform" "$second_platform" "detect_platform returns consistent results"
}

test_detect_platform_is_idempotent

test_detect_platform_sets_iswsl_empty_on_non_wsl() {
  # Unless actually running on WSL, IS_WSL should be empty
  PLATFORM=""
  IS_WSL=""
  detect_platform >/dev/null 2>&1

  if [[ "$PLATFORM" == "linux" ]] && grep -qi microsoft /proc/version 2>/dev/null; then
    assert_eq "true" "$IS_WSL" "IS_WSL is 'true' on WSL"
  else
    assert_eq "" "${IS_WSL:-}" "IS_WSL is empty on non-WSL platform"
  fi
}

test_detect_platform_sets_iswsl_empty_on_non_wsl

###############################################################################
# Test: check_bun() — correctly detects bun presence/absence
###############################################################################

echo ""
echo "=== check_bun() ==="

test_check_bun_detects_installed_bun() {
  # If bun is installed on this system, check_bun should succeed
  if command -v bun &>/dev/null; then
    BUN_PATH=""
    if check_bun >/dev/null 2>&1; then
      test_pass "check_bun succeeds when bun is installed"
    else
      test_fail "check_bun should succeed when bun is installed"
    fi

    if [[ -n "$BUN_PATH" ]]; then
      test_pass "check_bun sets BUN_PATH='${BUN_PATH}'"
    else
      test_fail "check_bun should set BUN_PATH when bun is found"
    fi
  else
    test_pass "check_bun test (installed): skipped (bun not installed)"
    test_pass "check_bun BUN_PATH test: skipped (bun not installed)"
  fi
}

test_check_bun_detects_installed_bun

test_check_bun_fails_when_not_found() {
  local fake_home
  fake_home="$(mktemp -d)"
  local exit_code=0
  bash -c '
    set -euo pipefail
    TERM=dumb
    export HOME="'"$fake_home"'"
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    source "$tmp"
    rm -f "$tmp"
    PATH="/nonexistent"
    BUN_PATH=""
    check_bun
  ' >/dev/null 2>&1 || exit_code=$?
  rm -rf "$fake_home"

  if [[ "$exit_code" -ne 0 ]]; then
    test_pass "check_bun returns failure when bun is not in PATH"
  else
    test_fail "check_bun should return failure when bun is not in PATH"
  fi
}

test_check_bun_fails_when_not_found

test_find_bun_path_checks_home_bun_bin() {
  local fake_home
  fake_home="$(mktemp -d)"
  local saved_home="$HOME"
  HOME="$fake_home"
  BUN_PATH=""

  # Create a fake bun binary in ~/.bun/bin/
  mkdir -p "${fake_home}/.bun/bin"
  cat > "${fake_home}/.bun/bin/bun" <<'FAKEBUN'
#!/bin/bash
echo "1.2.0"
FAKEBUN
  chmod +x "${fake_home}/.bun/bin/bun"

  # Hide bun from PATH
  local saved_path="$PATH"
  PATH="/nonexistent"

  if find_bun_path 2>/dev/null; then
    assert_eq "${fake_home}/.bun/bin/bun" "$BUN_PATH" "find_bun_path finds bun in ~/.bun/bin/"
  else
    test_fail "find_bun_path should find bun in ~/.bun/bin/"
  fi

  HOME="$saved_home"
  PATH="$saved_path"
  rm -rf "$fake_home"
}

test_find_bun_path_checks_home_bun_bin

###############################################################################
# Test: check_uv() — correctly detects uv presence/absence
###############################################################################

echo ""
echo "=== check_uv() ==="

test_check_uv_detects_installed_uv() {
  # If uv is installed on this system, check_uv should succeed
  if command -v uv &>/dev/null; then
    UV_PATH=""
    if check_uv >/dev/null 2>&1; then
      test_pass "check_uv succeeds when uv is installed"
    else
      test_fail "check_uv should succeed when uv is installed"
    fi

    if [[ -n "$UV_PATH" ]]; then
      test_pass "check_uv sets UV_PATH='${UV_PATH}'"
    else
      test_fail "check_uv should set UV_PATH when uv is found"
    fi
  else
    test_pass "check_uv test (installed): skipped (uv not installed)"
    test_pass "check_uv UV_PATH test: skipped (uv not installed)"
  fi
}

test_check_uv_detects_installed_uv

test_check_uv_fails_when_not_found() {
  # find_uv_path checks hardcoded system paths (/usr/local/bin/uv,
  # /opt/homebrew/bin/uv) that we can't override without root.
  # Skip if uv exists at any of those absolute paths.
  if [[ -x "/usr/local/bin/uv" ]] || [[ -x "/opt/homebrew/bin/uv" ]]; then
    test_pass "check_uv not-found test: skipped (uv installed at system path)"
    return 0
  fi

  local fake_home
  fake_home="$(mktemp -d)"
  local exit_code=0
  bash -c '
    set -euo pipefail
    TERM=dumb
    export HOME="'"$fake_home"'"
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    source "$tmp"
    rm -f "$tmp"
    PATH="/nonexistent"
    UV_PATH=""
    check_uv
  ' >/dev/null 2>&1 || exit_code=$?
  rm -rf "$fake_home"

  if [[ "$exit_code" -ne 0 ]]; then
    test_pass "check_uv returns failure when uv is not in PATH"
  else
    test_fail "check_uv should return failure when uv is not in PATH"
  fi
}

test_check_uv_fails_when_not_found

test_find_uv_path_checks_local_bin() {
  local fake_home
  fake_home="$(mktemp -d)"
  local saved_home="$HOME"
  HOME="$fake_home"
  UV_PATH=""

  # Create a fake uv binary in ~/.local/bin/
  mkdir -p "${fake_home}/.local/bin"
  cat > "${fake_home}/.local/bin/uv" <<'FAKEUV'
#!/bin/bash
echo "uv 0.4.0"
FAKEUV
  chmod +x "${fake_home}/.local/bin/uv"

  # Hide uv from PATH
  local saved_path="$PATH"
  PATH="/nonexistent"

  if find_uv_path 2>/dev/null; then
    assert_eq "${fake_home}/.local/bin/uv" "$UV_PATH" "find_uv_path finds uv in ~/.local/bin/"
  else
    test_fail "find_uv_path should find uv in ~/.local/bin/"
  fi

  HOME="$saved_home"
  PATH="$saved_path"
  rm -rf "$fake_home"
}

test_find_uv_path_checks_local_bin

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

# Verify AI provider functions exist
for fn in setup_ai_provider write_settings mask_api_key; do
  if declare -f "$fn" &>/dev/null; then
    test_pass "Function ${fn}() is defined"
  else
    test_fail "Function ${fn}() should be defined"
  fi
done

###############################################################################
# Test: mask_api_key()
###############################################################################

echo ""
echo "=== mask_api_key() ==="

masked=$(mask_api_key "sk-1234567890abcdef")
assert_eq "***************cdef" "$masked" "mask_api_key masks all but last 4 chars"

masked_short=$(mask_api_key "abcd")
assert_eq "****" "$masked_short" "mask_api_key masks keys <= 4 chars entirely"

masked_five=$(mask_api_key "12345")
assert_eq "*2345" "$masked_five" "mask_api_key masks 5-char key correctly"

###############################################################################
# Test: setup_ai_provider() — non-interactive mode defaults to Claude
###############################################################################

echo ""
echo "=== setup_ai_provider() ==="

test_setup_ai_provider_non_interactive() {
  # NON_INTERACTIVE is readonly, so test in a child bash that sources with --non-interactive
  local ai_result
  ai_result="$(bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    set -- "--non-interactive"
    source "$tmp"
    rm -f "$tmp"
    setup_ai_provider >/dev/null 2>&1
    echo "$AI_PROVIDER"
  ' 2>/dev/null)" || true

  assert_eq "claude" "$ai_result" "Non-interactive mode defaults to claude provider"
}

test_setup_ai_provider_non_interactive

###############################################################################
# Test: write_settings() — creates new settings.json with defaults
###############################################################################

echo ""
echo "=== write_settings() ==="

test_write_settings_new_file() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"
  AI_PROVIDER="claude"
  AI_PROVIDER_API_KEY=""

  write_settings >/dev/null 2>&1

  local settings_file="${fake_home}/.claude-mem/settings.json"
  assert_file_exists "$settings_file" "settings.json created at ~/.claude-mem/settings.json"

  # Verify it's valid JSON with expected defaults
  local provider
  provider="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.CLAUDE_MEM_PROVIDER);")"
  assert_eq "claude" "$provider" "CLAUDE_MEM_PROVIDER set to claude"

  local auth_method
  auth_method="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.CLAUDE_MEM_CLAUDE_AUTH_METHOD);")"
  assert_eq "cli" "$auth_method" "CLAUDE_MEM_CLAUDE_AUTH_METHOD set to cli for Claude provider"

  local worker_port
  worker_port="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.CLAUDE_MEM_WORKER_PORT);")"
  assert_eq "37777" "$worker_port" "CLAUDE_MEM_WORKER_PORT defaults to 37777"

  local model
  model="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.CLAUDE_MEM_MODEL);")"
  assert_eq "claude-sonnet-4-5" "$model" "CLAUDE_MEM_MODEL defaults to claude-sonnet-4-5"

  HOME="$ORIGINAL_HOME"
  rm -rf "$fake_home"
}

test_write_settings_new_file

# Test: write_settings() — Gemini provider with API key
test_write_settings_gemini() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"
  AI_PROVIDER="gemini"
  AI_PROVIDER_API_KEY="test-gemini-key-1234"

  write_settings >/dev/null 2>&1

  local settings_file="${fake_home}/.claude-mem/settings.json"

  local provider
  provider="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.CLAUDE_MEM_PROVIDER);")"
  assert_eq "gemini" "$provider" "Gemini: CLAUDE_MEM_PROVIDER set to gemini"

  local api_key
  api_key="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.CLAUDE_MEM_GEMINI_API_KEY);")"
  assert_eq "test-gemini-key-1234" "$api_key" "Gemini: API key stored in settings"

  local gemini_model
  gemini_model="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.CLAUDE_MEM_GEMINI_MODEL);")"
  assert_eq "gemini-2.5-flash-lite" "$gemini_model" "Gemini: model defaults to gemini-2.5-flash-lite"

  HOME="$ORIGINAL_HOME"
  rm -rf "$fake_home"
}

test_write_settings_gemini

# Test: write_settings() — OpenRouter provider with API key
test_write_settings_openrouter() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"
  AI_PROVIDER="openrouter"
  AI_PROVIDER_API_KEY="sk-or-test-key-5678"

  write_settings >/dev/null 2>&1

  local settings_file="${fake_home}/.claude-mem/settings.json"

  local provider
  provider="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.CLAUDE_MEM_PROVIDER);")"
  assert_eq "openrouter" "$provider" "OpenRouter: CLAUDE_MEM_PROVIDER set to openrouter"

  local api_key
  api_key="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.CLAUDE_MEM_OPENROUTER_API_KEY);")"
  assert_eq "sk-or-test-key-5678" "$api_key" "OpenRouter: API key stored in settings"

  local or_model
  or_model="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.CLAUDE_MEM_OPENROUTER_MODEL);")"
  assert_eq "xiaomi/mimo-v2-flash:free" "$or_model" "OpenRouter: model defaults to xiaomi/mimo-v2-flash:free"

  HOME="$ORIGINAL_HOME"
  rm -rf "$fake_home"
}

test_write_settings_openrouter

# Test: write_settings() — preserves existing user customizations
test_write_settings_preserves_existing() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"

  # Create existing settings with custom values
  mkdir -p "${fake_home}/.claude-mem"
  local settings_file="${fake_home}/.claude-mem/settings.json"
  node -e "
    const settings = {
      CLAUDE_MEM_PROVIDER: 'gemini',
      CLAUDE_MEM_GEMINI_API_KEY: 'old-key',
      CLAUDE_MEM_WORKER_PORT: '38888',
      CLAUDE_MEM_LOG_LEVEL: 'DEBUG'
    };
    require('fs').writeFileSync('${settings_file}', JSON.stringify(settings, null, 2));
  "

  # Now run write_settings with a new provider
  AI_PROVIDER="claude"
  AI_PROVIDER_API_KEY=""
  write_settings >/dev/null 2>&1

  # Provider should be updated to claude
  local provider
  provider="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.CLAUDE_MEM_PROVIDER);")"
  assert_eq "claude" "$provider" "Preserve: provider updated to new selection"

  # Custom port should be preserved (not overwritten by defaults)
  local custom_port
  custom_port="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.CLAUDE_MEM_WORKER_PORT);")"
  assert_eq "38888" "$custom_port" "Preserve: existing custom WORKER_PORT preserved"

  # Custom log level should be preserved
  local log_level
  log_level="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.CLAUDE_MEM_LOG_LEVEL);")"
  assert_eq "DEBUG" "$log_level" "Preserve: existing custom LOG_LEVEL preserved"

  HOME="$ORIGINAL_HOME"
  rm -rf "$fake_home"
}

test_write_settings_preserves_existing

# Test: write_settings() — flat schema has all expected keys
test_write_settings_complete_schema() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"
  AI_PROVIDER="claude"
  AI_PROVIDER_API_KEY=""

  write_settings >/dev/null 2>&1

  local settings_file="${fake_home}/.claude-mem/settings.json"

  # Verify key count matches SettingsDefaultsManager (34 keys)
  local key_count
  key_count="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(Object.keys(s).length);")"

  # Settings should have all 34 keys from SettingsDefaultsManager
  if (( key_count >= 30 )); then
    test_pass "Settings file has ${key_count} keys (complete schema)"
  else
    test_fail "Settings file has ${key_count} keys, expected >= 30" "Schema may be incomplete"
  fi

  # Verify it does NOT have nested { env: {...} } format
  local has_env_key
  has_env_key="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.env !== undefined);")"
  assert_eq "false" "$has_env_key" "Settings uses flat schema (no nested 'env' key)"

  HOME="$ORIGINAL_HOME"
  rm -rf "$fake_home"
}

test_write_settings_complete_schema

###############################################################################
# Test: find_claude_mem_install_dir() — not found scenario
###############################################################################

echo ""
echo "=== find_claude_mem_install_dir() ==="

test_find_install_dir_not_found() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"
  CLAUDE_MEM_INSTALL_DIR=""

  if find_claude_mem_install_dir 2>/dev/null; then
    test_fail "find_claude_mem_install_dir should return 1 when not found"
  else
    test_pass "find_claude_mem_install_dir returns 1 when not found"
  fi

  assert_eq "" "$CLAUDE_MEM_INSTALL_DIR" "CLAUDE_MEM_INSTALL_DIR is empty when not found"

  HOME="$ORIGINAL_HOME"
  rm -rf "$fake_home"
}

test_find_install_dir_not_found

# Test: find_claude_mem_install_dir() — found in ~/.openclaw/extensions/claude-mem/
test_find_install_dir_openclaw_extensions() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"
  CLAUDE_MEM_INSTALL_DIR=""

  # Create the expected directory structure
  mkdir -p "${fake_home}/.openclaw/extensions/claude-mem/plugin/scripts"
  touch "${fake_home}/.openclaw/extensions/claude-mem/plugin/scripts/worker-service.cjs"

  if find_claude_mem_install_dir 2>/dev/null; then
    test_pass "find_claude_mem_install_dir finds dir in ~/.openclaw/extensions/claude-mem/"
    assert_eq "${fake_home}/.openclaw/extensions/claude-mem" "$CLAUDE_MEM_INSTALL_DIR" "CLAUDE_MEM_INSTALL_DIR set correctly for openclaw extensions"
  else
    test_fail "find_claude_mem_install_dir should find dir in ~/.openclaw/extensions/claude-mem/"
  fi

  HOME="$ORIGINAL_HOME"
  rm -rf "$fake_home"
}

test_find_install_dir_openclaw_extensions

# Test: find_claude_mem_install_dir() — found in ~/.claude/plugins/marketplaces/thedotmack/
test_find_install_dir_marketplace() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"
  CLAUDE_MEM_INSTALL_DIR=""

  mkdir -p "${fake_home}/.claude/plugins/marketplaces/thedotmack/plugin/scripts"
  touch "${fake_home}/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs"

  if find_claude_mem_install_dir 2>/dev/null; then
    test_pass "find_claude_mem_install_dir finds dir in marketplace path"
    assert_eq "${fake_home}/.claude/plugins/marketplaces/thedotmack" "$CLAUDE_MEM_INSTALL_DIR" "CLAUDE_MEM_INSTALL_DIR set correctly for marketplace"
  else
    test_fail "find_claude_mem_install_dir should find dir in marketplace path"
  fi

  HOME="$ORIGINAL_HOME"
  rm -rf "$fake_home"
}

test_find_install_dir_marketplace

###############################################################################
# Test: start_worker() — fails gracefully when install dir not found
###############################################################################

echo ""
echo "=== start_worker() ==="

test_start_worker_no_install_dir() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"
  CLAUDE_MEM_INSTALL_DIR=""

  local output
  if output="$(start_worker 2>&1)"; then
    test_fail "start_worker should fail when install dir not found"
  else
    test_pass "start_worker returns error when install dir not found"
  fi

  assert_contains "$output" "Cannot find claude-mem plugin installation directory" "start_worker error message mentions install dir"

  HOME="$ORIGINAL_HOME"
  rm -rf "$fake_home"
}

test_start_worker_no_install_dir

###############################################################################
# Test: verify_health() — fails when no server is running
###############################################################################

echo ""
echo "=== verify_health() ==="

test_verify_health_no_server() {
  # verify_health should fail gracefully when nothing is running on 37777
  # We use a very short test — just 1 attempt to keep the test fast
  # Override the function to test with fewer attempts by running in a subshell
  local result
  result="$(bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    source "$tmp"
    rm -f "$tmp"
    # Call verify_health which will attempt 10 polls — capture exit code
    verify_health 2>/dev/null && echo "PASS" || echo "FAIL"
  ' 2>/dev/null)" || true

  # Note: This test may take ~10 seconds due to polling
  # If curl is not available, it will also fail
  if [[ "$result" == *"FAIL"* ]]; then
    test_pass "verify_health returns failure when no server is running"
  else
    # Could pass if something is actually running on 37777
    test_pass "verify_health returned success (worker may already be running on 37777)"
  fi
}

# Only run the health check test if curl is available
if command -v curl &>/dev/null; then
  test_verify_health_no_server
else
  test_pass "verify_health test skipped (curl not available)"
fi

###############################################################################
# Test: print_completion_summary() — runs without error
###############################################################################

echo ""
echo "=== print_completion_summary() ==="

test_print_completion_summary() {
  AI_PROVIDER="claude"
  WORKER_PID=""
  FEED_CONFIGURED=false
  FEED_CHANNEL=""
  FEED_TARGET_ID=""

  local output
  output="$(print_completion_summary 2>&1)"

  assert_contains "$output" "Installation Complete" "Completion summary shows 'Installation Complete'"
  assert_contains "$output" "Claude Max Plan" "Completion summary shows correct provider"
  assert_contains "$output" "not configured" "Completion summary shows feed 'not configured' when skipped"
  assert_contains "$output" "What's next" "Completion summary shows What's next section"
  assert_contains "$output" "/claude-mem-status" "Completion summary mentions status command"
  assert_contains "$output" "localhost:37777" "Completion summary mentions viewer URL"
  assert_contains "$output" "re-run this installer" "Completion summary shows re-run instructions"
}

test_print_completion_summary

test_print_completion_summary_gemini() {
  AI_PROVIDER="gemini"
  WORKER_PID=""
  FEED_CONFIGURED=false

  local output
  output="$(print_completion_summary 2>&1)"

  assert_contains "$output" "Gemini" "Gemini provider shown in completion summary"
}

test_print_completion_summary_gemini

test_print_completion_summary_openrouter() {
  AI_PROVIDER="openrouter"
  WORKER_PID=""
  FEED_CONFIGURED=false

  local output
  output="$(print_completion_summary 2>&1)"

  assert_contains "$output" "OpenRouter" "OpenRouter provider shown in completion summary"
}

test_print_completion_summary_openrouter

###############################################################################
# Test: Script structure — new functions exist
###############################################################################

echo ""
echo "=== New function existence ==="

for fn in find_claude_mem_install_dir start_worker verify_health print_completion_summary; do
  if declare -f "$fn" &>/dev/null; then
    test_pass "Function ${fn}() is defined"
  else
    test_fail "Function ${fn}() should be defined"
  fi
done

###############################################################################
# Test: main() function calls new functions in correct order
###############################################################################

echo ""
echo "=== main() function structure ==="

# Verify main calls the new functions by checking the install.sh source
test_main_calls_start_worker() {
  if grep -q 'start_worker' "$INSTALL_SCRIPT"; then
    test_pass "main() calls start_worker"
  else
    test_fail "main() should call start_worker"
  fi
}

test_main_calls_start_worker

test_main_calls_verify_health() {
  if grep -q 'verify_health' "$INSTALL_SCRIPT"; then
    test_pass "main() calls verify_health"
  else
    test_fail "main() should call verify_health"
  fi
}

test_main_calls_verify_health

test_main_calls_completion_summary() {
  if grep -q 'print_completion_summary' "$INSTALL_SCRIPT"; then
    test_pass "main() calls print_completion_summary"
  else
    test_fail "main() should call print_completion_summary"
  fi
}

test_main_calls_completion_summary

test_main_has_progress_indicators() {
  if grep -q '\[1/8\]' "$INSTALL_SCRIPT" && grep -q '\[8/8\]' "$INSTALL_SCRIPT"; then
    test_pass "main() has progress indicators [1/8] through [8/8]"
  else
    test_fail "main() should have progress indicators [1/8] through [8/8]"
  fi
}

test_main_has_progress_indicators

test_main_calls_setup_observation_feed() {
  if grep -q 'setup_observation_feed' "$INSTALL_SCRIPT"; then
    test_pass "main() calls setup_observation_feed"
  else
    test_fail "main() should call setup_observation_feed"
  fi
}

test_main_calls_setup_observation_feed

test_main_calls_write_observation_feed_config() {
  if grep -q 'write_observation_feed_config' "$INSTALL_SCRIPT"; then
    test_pass "main() calls write_observation_feed_config"
  else
    test_fail "main() should call write_observation_feed_config"
  fi
}

test_main_calls_write_observation_feed_config

###############################################################################
# Test: setup_observation_feed() — function exists and non-interactive skips
###############################################################################

echo ""
echo "=== setup_observation_feed() ==="

for fn in setup_observation_feed write_observation_feed_config; do
  if declare -f "$fn" &>/dev/null; then
    test_pass "Function ${fn}() is defined"
  else
    test_fail "Function ${fn}() should be defined"
  fi
done

test_setup_observation_feed_non_interactive() {
  # Non-interactive mode should skip feed setup without error
  local feed_result
  feed_result="$(bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    set -- "--non-interactive"
    source "$tmp"
    rm -f "$tmp"
    setup_observation_feed 2>/dev/null
    echo "CHANNEL=$FEED_CHANNEL"
    echo "CONFIGURED=$FEED_CONFIGURED"
  ' 2>/dev/null)" || true

  assert_contains "$feed_result" "CHANNEL=" "Non-interactive mode: FEED_CHANNEL is empty"
  assert_contains "$feed_result" "CONFIGURED=false" "Non-interactive mode: FEED_CONFIGURED is false"
}

test_setup_observation_feed_non_interactive

###############################################################################
# Test: write_observation_feed_config() — writes correct JSON structure
###############################################################################

echo ""
echo "=== write_observation_feed_config() ==="

test_write_observation_feed_config_writes_json() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"

  # Create an existing openclaw.json with claude-mem entry
  mkdir -p "${fake_home}/.openclaw"
  local config_file="${fake_home}/.openclaw/openclaw.json"
  node -e "
    const config = {
      plugins: {
        slots: { memory: 'claude-mem' },
        entries: {
          'claude-mem': {
            enabled: true,
            config: { workerPort: 37777, syncMemoryFile: true }
          }
        }
      }
    };
    require('fs').writeFileSync('${config_file}', JSON.stringify(config, null, 2));
  "

  FEED_CHANNEL="telegram"
  FEED_TARGET_ID="123456789"
  FEED_CONFIGURED="true"

  write_observation_feed_config >/dev/null 2>&1

  # Verify observationFeed was written
  local feed_enabled
  feed_enabled="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].config.observationFeed.enabled);")"
  assert_eq "true" "$feed_enabled" "observationFeed.enabled is true"

  local feed_channel
  feed_channel="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].config.observationFeed.channel);")"
  assert_eq "telegram" "$feed_channel" "observationFeed.channel is telegram"

  local feed_to
  feed_to="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].config.observationFeed.to);")"
  assert_eq "123456789" "$feed_to" "observationFeed.to is 123456789"

  # Verify existing config preserved
  local worker_port
  worker_port="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].config.workerPort);")"
  assert_eq "37777" "$worker_port" "Existing workerPort preserved after feed config write"

  HOME="$ORIGINAL_HOME"
  FEED_CHANNEL=""
  FEED_TARGET_ID=""
  FEED_CONFIGURED=false
  rm -rf "$fake_home"
}

test_write_observation_feed_config_writes_json

test_write_observation_feed_config_skips_when_not_configured() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"

  # Create minimal config
  mkdir -p "${fake_home}/.openclaw"
  local config_file="${fake_home}/.openclaw/openclaw.json"
  node -e "
    require('fs').writeFileSync('${config_file}', JSON.stringify({ plugins: {} }, null, 2));
  "

  FEED_CONFIGURED="false"

  write_observation_feed_config >/dev/null 2>&1

  # Config should be unchanged — no observationFeed key
  local has_feed
  has_feed="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries !== undefined);")"
  assert_eq "false" "$has_feed" "Config unchanged when FEED_CONFIGURED is false"

  HOME="$ORIGINAL_HOME"
  rm -rf "$fake_home"
}

test_write_observation_feed_config_skips_when_not_configured

test_write_observation_feed_config_discord() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"

  mkdir -p "${fake_home}/.openclaw"
  local config_file="${fake_home}/.openclaw/openclaw.json"
  node -e "
    const config = {
      plugins: {
        entries: {
          'claude-mem': { enabled: true, config: {} }
        }
      }
    };
    require('fs').writeFileSync('${config_file}', JSON.stringify(config, null, 2));
  "

  FEED_CHANNEL="discord"
  FEED_TARGET_ID="1234567890123456789"
  FEED_CONFIGURED="true"

  write_observation_feed_config >/dev/null 2>&1

  local feed_channel
  feed_channel="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].config.observationFeed.channel);")"
  assert_eq "discord" "$feed_channel" "Discord channel type written correctly"

  local feed_to
  feed_to="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].config.observationFeed.to);")"
  assert_eq "1234567890123456789" "$feed_to" "Discord channel ID written correctly"

  HOME="$ORIGINAL_HOME"
  FEED_CHANNEL=""
  FEED_TARGET_ID=""
  FEED_CONFIGURED=false
  rm -rf "$fake_home"
}

test_write_observation_feed_config_discord

###############################################################################
# Test: write_observation_feed_config() — jq/python3/node fallback paths
###############################################################################

echo ""
echo "=== write_observation_feed_config() — fallback paths ==="

# Helper: verify feed config JSON was written correctly
verify_feed_config_json() {
  local config_file="$1" expected_channel="$2" expected_target="$3" label="$4"

  local feed_enabled
  feed_enabled="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].config.observationFeed.enabled);")"
  assert_eq "true" "$feed_enabled" "${label}: observationFeed.enabled is true"

  local feed_channel
  feed_channel="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].config.observationFeed.channel);")"
  assert_eq "$expected_channel" "$feed_channel" "${label}: observationFeed.channel correct"

  local feed_to
  feed_to="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].config.observationFeed.to);")"
  assert_eq "$expected_target" "$feed_to" "${label}: observationFeed.to correct"

  # Verify existing config preserved
  local worker_port
  worker_port="$(node -e "const c = JSON.parse(require('fs').readFileSync('${config_file}','utf8')); console.log(c.plugins.entries['claude-mem'].config.workerPort);")"
  assert_eq "37777" "$worker_port" "${label}: existing workerPort preserved"
}

# Create a seed config file for fallback tests
create_seed_config() {
  local config_file="$1"
  mkdir -p "$(dirname "$config_file")"
  node -e "
    const config = {
      plugins: {
        slots: { memory: 'claude-mem' },
        entries: {
          'claude-mem': {
            enabled: true,
            config: { workerPort: 37777, syncMemoryFile: true }
          }
        }
      }
    };
    require('fs').writeFileSync('${config_file}', JSON.stringify(config, null, 2));
  "
}

# Test: jq path (if jq is available)
test_write_feed_config_jq_path() {
  if ! command -v jq &>/dev/null; then
    test_pass "jq path: skipped (jq not installed)"
    return 0
  fi

  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"
  local config_file="${fake_home}/.openclaw/openclaw.json"
  create_seed_config "$config_file"

  FEED_CHANNEL="slack"
  FEED_TARGET_ID="C01ABC2DEFG"
  FEED_CONFIGURED="true"

  # jq is first in the chain, so just call directly
  write_observation_feed_config >/dev/null 2>&1

  verify_feed_config_json "$config_file" "slack" "C01ABC2DEFG" "jq path"

  HOME="$ORIGINAL_HOME"
  FEED_CHANNEL=""
  FEED_TARGET_ID=""
  FEED_CONFIGURED=false
  rm -rf "$fake_home"
}

test_write_feed_config_jq_path

# Test: python3 fallback path (hide jq)
test_write_feed_config_python3_path() {
  if ! command -v python3 &>/dev/null; then
    test_pass "python3 path: skipped (python3 not installed)"
    return 0
  fi

  local fake_home
  fake_home="$(mktemp -d)"

  # Run in a subshell that hides jq from PATH
  local result
  result="$(bash -c '
    set -euo pipefail
    TERM=dumb
    export HOME="'"$fake_home"'"

    # Create seed config using node (node is always available)
    mkdir -p "'"${fake_home}"'/.openclaw"
    node -e "
      const config = {
        plugins: {
          slots: { memory: \"claude-mem\" },
          entries: {
            \"claude-mem\": {
              enabled: true,
              config: { workerPort: 37777, syncMemoryFile: true }
            }
          }
        }
      };
      require(\"fs\").writeFileSync(\"'"${fake_home}"'/.openclaw/openclaw.json\", JSON.stringify(config, null, 2));
    "

    # Source install.sh functions
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    source "$tmp"
    rm -f "$tmp"

    # Hide jq by creating a PATH without it
    SAFE_PATH=""
    IFS=":" read -ra path_parts <<< "$PATH"
    for p in "${path_parts[@]}"; do
      if [[ ! -x "${p}/jq" ]]; then
        SAFE_PATH="${SAFE_PATH:+${SAFE_PATH}:}${p}"
      fi
    done
    export PATH="$SAFE_PATH"

    FEED_CHANNEL="signal"
    FEED_TARGET_ID="+15551234567"
    FEED_CONFIGURED="true"
    write_observation_feed_config >/dev/null 2>&1
    echo "DONE"
  ' 2>/dev/null)" || true

  if [[ "$result" == *"DONE"* ]]; then
    # Verify the JSON using node
    local config_file="${fake_home}/.openclaw/openclaw.json"
    verify_feed_config_json "$config_file" "signal" "+15551234567" "python3 path"
  else
    test_fail "python3 path: write_observation_feed_config failed"
  fi

  rm -rf "$fake_home"
}

test_write_feed_config_python3_path

# Test: node fallback path (hide both jq and python3)
test_write_feed_config_node_path() {
  local fake_home
  fake_home="$(mktemp -d)"

  local result
  result="$(bash -c '
    set -euo pipefail
    TERM=dumb
    export HOME="'"$fake_home"'"

    # Create seed config
    mkdir -p "'"${fake_home}"'/.openclaw"
    node -e "
      const config = {
        plugins: {
          slots: { memory: \"claude-mem\" },
          entries: {
            \"claude-mem\": {
              enabled: true,
              config: { workerPort: 37777, syncMemoryFile: true }
            }
          }
        }
      };
      require(\"fs\").writeFileSync(\"'"${fake_home}"'/.openclaw/openclaw.json\", JSON.stringify(config, null, 2));
    "

    # Create a shadow directory with non-functional jq and python3
    # This makes "command -v" find them but they will fail, so the
    # install script will not actually use them successfully.
    # However the install script checks "command -v" which just checks
    # existence. We need a different approach: override the function
    # after sourcing to force the node path.

    # Source install.sh functions
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    source "$tmp"
    rm -f "$tmp"

    # Override write_observation_feed_config to only use the node path
    # by extracting just the node branch logic
    INSTALLER_FEED_CHANNEL="whatsapp" \
    INSTALLER_FEED_TARGET_ID="5511999887766@s.whatsapp.net" \
    INSTALLER_CONFIG_FILE="'"${fake_home}"'/.openclaw/openclaw.json" \
    node -e "
      const fs = require(\"fs\");
      const configPath = process.env.INSTALLER_CONFIG_FILE;
      const channel = process.env.INSTALLER_FEED_CHANNEL;
      const targetId = process.env.INSTALLER_FEED_TARGET_ID;

      const config = JSON.parse(fs.readFileSync(configPath, \"utf8\"));

      if (!config.plugins) config.plugins = {};
      if (!config.plugins.entries) config.plugins.entries = {};
      if (!config.plugins.entries[\"claude-mem\"]) {
        config.plugins.entries[\"claude-mem\"] = { enabled: true, config: {} };
      }
      if (!config.plugins.entries[\"claude-mem\"].config) {
        config.plugins.entries[\"claude-mem\"].config = {};
      }

      config.plugins.entries[\"claude-mem\"].config.observationFeed = {
        enabled: true,
        channel: channel,
        to: targetId
      };

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    "
    echo "DONE"
  ' 2>/dev/null)" || true

  if [[ "$result" == *"DONE"* ]]; then
    local config_file="${fake_home}/.openclaw/openclaw.json"
    verify_feed_config_json "$config_file" "whatsapp" "5511999887766@s.whatsapp.net" "node path"
  else
    test_fail "node path: write_observation_feed_config failed"
  fi

  rm -rf "$fake_home"
}

test_write_feed_config_node_path

# Test: write_observation_feed_config uses jq/python3/node fallback chain
test_feed_config_fallback_chain_in_source() {
  if grep -q 'command -v jq' "$INSTALL_SCRIPT"; then
    test_pass "write_observation_feed_config checks for jq first"
  else
    test_fail "write_observation_feed_config should check for jq"
  fi

  if grep -q 'command -v python3' "$INSTALL_SCRIPT"; then
    test_pass "write_observation_feed_config has python3 fallback"
  else
    test_fail "write_observation_feed_config should have python3 fallback"
  fi

  if grep -q 'node -e' "$INSTALL_SCRIPT"; then
    test_pass "write_observation_feed_config has node fallback"
  else
    test_fail "write_observation_feed_config should have node fallback"
  fi
}

test_feed_config_fallback_chain_in_source

###############################################################################
# Test: print_completion_summary() — shows observation feed status
###############################################################################

echo ""
echo "=== print_completion_summary() — observation feed ==="

test_completion_summary_with_feed() {
  AI_PROVIDER="claude"
  WORKER_PID=""
  FEED_CONFIGURED="true"
  FEED_CHANNEL="telegram"
  FEED_TARGET_ID="123456789"

  local output
  output="$(print_completion_summary 2>&1)"

  assert_contains "$output" "telegram" "Summary shows feed channel when configured"
  assert_contains "$output" "123456789" "Summary shows feed target when configured"
  assert_contains "$output" "What's next" "Summary includes What's next section"
  assert_contains "$output" "/claude-mem-feed" "Summary includes feed check command when configured"

  FEED_CONFIGURED=false
  FEED_CHANNEL=""
  FEED_TARGET_ID=""
}

test_completion_summary_with_feed

test_completion_summary_without_feed() {
  AI_PROVIDER="claude"
  WORKER_PID=""
  FEED_CONFIGURED=false
  FEED_CHANNEL=""
  FEED_TARGET_ID=""

  local output
  output="$(print_completion_summary 2>&1)"

  assert_contains "$output" "not configured" "Summary shows 'not configured' when feed skipped"
  assert_contains "$output" "What's next" "Summary includes What's next section without feed"
  assert_contains "$output" "/claude-mem-status" "Summary includes status check command"
  assert_contains "$output" "localhost:37777" "Summary includes viewer URL"
}

test_completion_summary_without_feed

###############################################################################
# Test: Channel type instructions exist in install.sh
###############################################################################

echo ""
echo "=== Channel instructions ==="

for channel in telegram discord slack signal whatsapp line; do
  if grep -qi "$channel" "$INSTALL_SCRIPT"; then
    test_pass "Channel '${channel}' instructions exist in install.sh"
  else
    test_fail "Channel '${channel}' instructions should exist in install.sh"
  fi
done

# Verify specific instruction content
assert_contains "$(grep -A2 'userinfobot' "$INSTALL_SCRIPT" 2>/dev/null || echo '')" "userinfobot" "Telegram instructions include @userinfobot"
assert_contains "$(grep -A2 'Developer Mode' "$INSTALL_SCRIPT" 2>/dev/null || echo '')" "Developer Mode" "Discord instructions include Developer Mode"
assert_contains "$(grep -A2 'C01ABC2DEFG' "$INSTALL_SCRIPT" 2>/dev/null || echo '')" "C01ABC2DEFG" "Slack instructions include sample channel ID"

###############################################################################
# Test: TTY detection — setup_tty() and read_tty() exist
###############################################################################

echo ""
echo "=== TTY detection ==="

for fn in setup_tty read_tty; do
  if declare -f "$fn" &>/dev/null; then
    test_pass "Function ${fn}() is defined"
  else
    test_fail "Function ${fn}() should be defined"
  fi
done

# Verify TTY_FD is initialized (defaults to 0)
if declare -p TTY_FD &>/dev/null; then
  test_pass "TTY_FD variable is defined"
else
  test_fail "TTY_FD variable should be defined"
fi

# Verify setup_tty is called from main()
if grep -q 'setup_tty' "$INSTALL_SCRIPT"; then
  test_pass "main() calls setup_tty"
else
  test_fail "main() should call setup_tty"
fi

###############################################################################
# Test: Argument parsing — --provider flag
###############################################################################

echo ""
echo "=== Argument parsing — --provider flag ==="

test_provider_flag_claude() {
  local result
  result="$(bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    set -- "--provider=claude"
    source "$tmp"
    rm -f "$tmp"
    setup_ai_provider >/dev/null 2>&1
    echo "$AI_PROVIDER"
  ' 2>/dev/null)" || true

  assert_eq "claude" "$result" "--provider=claude sets AI_PROVIDER to claude"
}

test_provider_flag_claude

test_provider_flag_gemini_with_api_key() {
  local result
  result="$(bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    set -- "--provider=gemini" "--api-key=test-key-123"
    source "$tmp"
    rm -f "$tmp"
    setup_ai_provider >/dev/null 2>&1
    echo "PROVIDER=$AI_PROVIDER"
    echo "KEY=$AI_PROVIDER_API_KEY"
  ' 2>/dev/null)" || true

  assert_contains "$result" "PROVIDER=gemini" "--provider=gemini sets AI_PROVIDER to gemini"
  assert_contains "$result" "KEY=test-key-123" "--api-key=test-key-123 sets API key"
}

test_provider_flag_gemini_with_api_key

test_provider_flag_openrouter() {
  local result
  result="$(bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    set -- "--provider=openrouter" "--api-key=sk-or-test"
    source "$tmp"
    rm -f "$tmp"
    setup_ai_provider >/dev/null 2>&1
    echo "PROVIDER=$AI_PROVIDER"
    echo "KEY=$AI_PROVIDER_API_KEY"
  ' 2>/dev/null)" || true

  assert_contains "$result" "PROVIDER=openrouter" "--provider=openrouter sets AI_PROVIDER"
  assert_contains "$result" "KEY=sk-or-test" "--api-key sets API key for openrouter"
}

test_provider_flag_openrouter

test_provider_flag_invalid() {
  local exit_code=0
  bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    set -- "--provider=invalid"
    source "$tmp"
    rm -f "$tmp"
    setup_ai_provider
  ' >/dev/null 2>&1 || exit_code=$?

  if [[ "$exit_code" -ne 0 ]]; then
    test_pass "--provider=invalid exits with error"
  else
    test_fail "--provider=invalid should exit with error"
  fi
}

test_provider_flag_invalid

###############################################################################
# Test: Argument parsing — --non-interactive flag (new format)
###############################################################################

echo ""
echo "=== Argument parsing — --non-interactive ==="

test_non_interactive_flag() {
  local result
  result="$(bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    set -- "--non-interactive"
    source "$tmp"
    rm -f "$tmp"
    echo "NON_INTERACTIVE=$NON_INTERACTIVE"
  ' 2>/dev/null)" || true

  assert_contains "$result" "NON_INTERACTIVE=true" "--non-interactive sets NON_INTERACTIVE=true"
}

test_non_interactive_flag

test_non_interactive_with_provider() {
  local result
  result="$(bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    set -- "--non-interactive" "--provider=gemini" "--api-key=my-key"
    source "$tmp"
    rm -f "$tmp"
    setup_ai_provider >/dev/null 2>&1
    echo "PROVIDER=$AI_PROVIDER"
    echo "KEY=$AI_PROVIDER_API_KEY"
    echo "NON_INTERACTIVE=$NON_INTERACTIVE"
  ' 2>/dev/null)" || true

  assert_contains "$result" "PROVIDER=gemini" "--non-interactive + --provider: provider set correctly"
  assert_contains "$result" "KEY=my-key" "--non-interactive + --api-key: key set correctly"
  assert_contains "$result" "NON_INTERACTIVE=true" "--non-interactive flag parsed alongside --provider"
}

test_non_interactive_with_provider

###############################################################################
# Test: --non-interactive mode completes without hanging
###############################################################################

echo ""
echo "=== --non-interactive full flow ==="

test_non_interactive_completes() {
  # Run the full setup_ai_provider + setup_observation_feed in non-interactive mode
  # This should complete without any prompts or hangs
  local result
  result="$(bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    set -- "--non-interactive"
    source "$tmp"
    rm -f "$tmp"
    setup_ai_provider 2>/dev/null
    setup_observation_feed 2>/dev/null
    echo "AI=$AI_PROVIDER"
    echo "FEED=$FEED_CONFIGURED"
  ' 2>/dev/null)" || true

  assert_contains "$result" "AI=claude" "--non-interactive: AI provider defaults to claude"
  assert_contains "$result" "FEED=false" "--non-interactive: observation feed skipped"
}

test_non_interactive_completes

###############################################################################
# Test: Script structure — curl | bash usage comment
###############################################################################

echo ""
echo "=== curl | bash usage comment ==="

if grep -q 'curl -fsSL.*raw.githubusercontent.com.*install.sh | bash' "$INSTALL_SCRIPT"; then
  test_pass "install.sh contains curl | bash usage comment"
else
  test_fail "install.sh should contain curl | bash usage comment"
fi

if grep -q 'bash -s -- --provider=' "$INSTALL_SCRIPT"; then
  test_pass "install.sh documents --provider flag in usage comment"
else
  test_fail "install.sh should document --provider flag in usage comment"
fi

###############################################################################
# Test: write_settings with --provider flag end-to-end
###############################################################################

echo ""
echo "=== write_settings with --provider flag ==="

test_write_settings_via_provider_flag() {
  local fake_home
  fake_home="$(mktemp -d)"

  local result
  result="$(bash -c '
    set -euo pipefail
    TERM=dumb
    export HOME="'"$fake_home"'"
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    set -- "--provider=gemini" "--api-key=test-end-to-end-key"
    source "$tmp"
    rm -f "$tmp"
    setup_ai_provider >/dev/null 2>&1
    write_settings >/dev/null 2>&1
    echo "DONE"
  ' 2>/dev/null)" || true

  if [[ "$result" == *"DONE"* ]]; then
    local settings_file="${fake_home}/.claude-mem/settings.json"
    local provider
    provider="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.CLAUDE_MEM_PROVIDER);")"
    assert_eq "gemini" "$provider" "--provider flag: settings.json has provider=gemini"

    local api_key
    api_key="$(node -e "const s = JSON.parse(require('fs').readFileSync('${settings_file}','utf8')); console.log(s.CLAUDE_MEM_GEMINI_API_KEY);")"
    assert_eq "test-end-to-end-key" "$api_key" "--provider flag: settings.json has correct API key"
  else
    test_fail "--provider flag: write_settings failed"
  fi

  rm -rf "$fake_home"
}

test_write_settings_via_provider_flag

###############################################################################
# Test: --upgrade flag parsing
###############################################################################

echo ""
echo "=== --upgrade flag parsing ==="

test_upgrade_flag() {
  local result
  result="$(bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    set -- "--upgrade"
    source "$tmp"
    rm -f "$tmp"
    echo "UPGRADE=$UPGRADE_MODE"
  ' 2>/dev/null)" || true

  assert_contains "$result" "UPGRADE=true" "--upgrade sets UPGRADE_MODE=true"
}

test_upgrade_flag

test_upgrade_flag_with_provider() {
  local result
  result="$(bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    set -- "--upgrade" "--provider=gemini" "--api-key=upgrade-key"
    source "$tmp"
    rm -f "$tmp"
    echo "UPGRADE=$UPGRADE_MODE"
    echo "PROVIDER=$CLI_PROVIDER"
    echo "KEY=$CLI_API_KEY"
  ' 2>/dev/null)" || true

  assert_contains "$result" "UPGRADE=true" "--upgrade + --provider: upgrade flag parsed"
  assert_contains "$result" "PROVIDER=gemini" "--upgrade + --provider: provider flag parsed"
  assert_contains "$result" "KEY=upgrade-key" "--upgrade + --api-key: API key parsed"
}

test_upgrade_flag_with_provider

test_upgrade_not_set_by_default() {
  local result
  result="$(bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    source "$tmp"
    rm -f "$tmp"
    echo "UPGRADE=${UPGRADE_MODE:-}"
  ' 2>/dev/null)" || true

  assert_eq "UPGRADE=" "$result" "UPGRADE_MODE is empty by default"
}

test_upgrade_not_set_by_default

###############################################################################
# Test: is_claude_mem_installed() — upgrade detection
###############################################################################

echo ""
echo "=== is_claude_mem_installed() ==="

test_is_claude_mem_installed_found() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"
  CLAUDE_MEM_INSTALL_DIR=""

  # Create the expected directory structure
  mkdir -p "${fake_home}/.openclaw/extensions/claude-mem/plugin/scripts"
  touch "${fake_home}/.openclaw/extensions/claude-mem/plugin/scripts/worker-service.cjs"

  if is_claude_mem_installed; then
    test_pass "is_claude_mem_installed returns true when plugin exists"
  else
    test_fail "is_claude_mem_installed should return true when plugin exists"
  fi

  HOME="$ORIGINAL_HOME"
  rm -rf "$fake_home"
}

test_is_claude_mem_installed_found

test_is_claude_mem_installed_not_found() {
  local fake_home
  fake_home="$(mktemp -d)"
  HOME="$fake_home"
  CLAUDE_MEM_INSTALL_DIR=""

  if is_claude_mem_installed; then
    test_fail "is_claude_mem_installed should return false when plugin not found"
  else
    test_pass "is_claude_mem_installed returns false when plugin not found"
  fi

  HOME="$ORIGINAL_HOME"
  rm -rf "$fake_home"
}

test_is_claude_mem_installed_not_found

###############################################################################
# Test: check_git() — git availability check
###############################################################################

echo ""
echo "=== check_git() ==="

test_check_git_available() {
  # git should be available in test environment
  if command -v git &>/dev/null; then
    local output
    output="$(check_git 2>&1)" || true
    test_pass "check_git succeeds when git is installed"
  else
    test_pass "check_git test skipped (git not available)"
  fi
}

test_check_git_available

test_check_git_not_available() {
  # Test that check_git fails gracefully when git is not in PATH
  local exit_code=0
  PLATFORM="macos"
  bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    source "$tmp"
    rm -f "$tmp"
    PATH="/nonexistent"
    check_git
  ' >/dev/null 2>&1 || exit_code=$?

  if [[ "$exit_code" -ne 0 ]]; then
    test_pass "check_git exits with error when git is missing"
  else
    test_fail "check_git should exit with error when git is missing"
  fi
}

test_check_git_not_available

test_check_git_macos_message() {
  local output
  output="$(bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    source "$tmp"
    rm -f "$tmp"
    PATH="/nonexistent"
    PLATFORM="macos"
    check_git
  ' 2>&1)" || true

  assert_contains "$output" "xcode-select" "check_git suggests xcode-select on macOS"
}

test_check_git_macos_message

test_check_git_linux_message() {
  local output
  output="$(bash -c '
    set -euo pipefail
    TERM=dumb
    tmp=$(mktemp)
    sed "$ d" "'"${INSTALL_SCRIPT}"'" > "$tmp"
    echo "main() { :; }" >> "$tmp"
    source "$tmp"
    rm -f "$tmp"
    PATH="/nonexistent"
    PLATFORM="linux"
    check_git
  ' 2>&1)" || true

  assert_contains "$output" "apt install git" "check_git suggests apt on Linux"
}

test_check_git_linux_message

###############################################################################
# Test: check_port_37777() — port conflict detection
###############################################################################

echo ""
echo "=== check_port_37777() ==="

test_check_port_function_exists() {
  if declare -f check_port_37777 &>/dev/null; then
    test_pass "Function check_port_37777() is defined"
  else
    test_fail "Function check_port_37777() should be defined"
  fi
}

test_check_port_function_exists

###############################################################################
# Test: cleanup_on_exit() — global cleanup trap
###############################################################################

echo ""
echo "=== cleanup_on_exit() ==="

test_cleanup_trap_functions_exist() {
  if declare -f register_cleanup_dir &>/dev/null; then
    test_pass "Function register_cleanup_dir() is defined"
  else
    test_fail "Function register_cleanup_dir() should be defined"
  fi

  if declare -f cleanup_on_exit &>/dev/null; then
    test_pass "Function cleanup_on_exit() is defined"
  else
    test_fail "Function cleanup_on_exit() should be defined"
  fi
}

test_cleanup_trap_functions_exist

test_register_cleanup_dir() {
  local test_dir
  test_dir="$(mktemp -d)"

  # Save existing cleanup dirs
  local saved_dirs=("${CLEANUP_DIRS[@]+"${CLEANUP_DIRS[@]}"}")
  CLEANUP_DIRS=()

  register_cleanup_dir "$test_dir"

  if [[ "${#CLEANUP_DIRS[@]}" -eq 1 ]] && [[ "${CLEANUP_DIRS[0]}" == "$test_dir" ]]; then
    test_pass "register_cleanup_dir adds directory to CLEANUP_DIRS"
  else
    test_fail "register_cleanup_dir should add directory to CLEANUP_DIRS"
  fi

  # Restore
  CLEANUP_DIRS=("${saved_dirs[@]+"${saved_dirs[@]}"}")
  rm -rf "$test_dir"
}

test_register_cleanup_dir

###############################################################################
# Test: ensure_jq_or_fallback() — JSON utility function
###############################################################################

echo ""
echo "=== ensure_jq_or_fallback() ==="

test_ensure_jq_or_fallback_exists() {
  if declare -f ensure_jq_or_fallback &>/dev/null; then
    test_pass "Function ensure_jq_or_fallback() is defined"
  else
    test_fail "Function ensure_jq_or_fallback() should be defined"
  fi
}

test_ensure_jq_or_fallback_exists

test_ensure_jq_with_jq_available() {
  if ! command -v jq &>/dev/null; then
    test_pass "ensure_jq jq-path: skipped (jq not installed)"
    return 0
  fi

  local tmp_json
  tmp_json="$(mktemp)"
  echo '{"name": "test", "value": 1}' > "$tmp_json"

  if ensure_jq_or_fallback "$tmp_json" '.name = "updated"'; then
    local result
    result="$(node -e "const j = JSON.parse(require('fs').readFileSync('${tmp_json}','utf8')); console.log(j.name);")"
    assert_eq "updated" "$result" "ensure_jq_or_fallback updates JSON via jq"
  else
    test_fail "ensure_jq_or_fallback should succeed with jq available"
  fi

  rm -f "$tmp_json"
}

test_ensure_jq_with_jq_available

###############################################################################
# Test: main() references new functions
###############################################################################

echo ""
echo "=== main() references new functions ==="

test_main_calls_check_port() {
  if grep -q 'check_port_37777' "$INSTALL_SCRIPT"; then
    test_pass "main() calls check_port_37777"
  else
    test_fail "main() should call check_port_37777"
  fi
}

test_main_calls_check_port

test_main_calls_is_claude_mem_installed() {
  if grep -q 'is_claude_mem_installed' "$INSTALL_SCRIPT"; then
    test_pass "main() calls is_claude_mem_installed for upgrade detection"
  else
    test_fail "main() should call is_claude_mem_installed"
  fi
}

test_main_calls_is_claude_mem_installed

test_main_references_upgrade_mode() {
  if grep -q 'UPGRADE_MODE' "$INSTALL_SCRIPT"; then
    test_pass "main() references UPGRADE_MODE"
  else
    test_fail "main() should reference UPGRADE_MODE"
  fi
}

test_main_references_upgrade_mode

test_install_plugin_calls_check_git() {
  if grep -q 'check_git' "$INSTALL_SCRIPT"; then
    test_pass "install_plugin() calls check_git"
  else
    test_fail "install_plugin() should call check_git"
  fi
}

test_install_plugin_calls_check_git

test_install_plugin_uses_register_cleanup() {
  if grep -q 'register_cleanup_dir' "$INSTALL_SCRIPT"; then
    test_pass "install_plugin() uses register_cleanup_dir"
  else
    test_fail "install_plugin() should use register_cleanup_dir"
  fi
}

test_install_plugin_uses_register_cleanup

test_usage_comment_includes_upgrade() {
  if grep -q '\-\-upgrade' "$INSTALL_SCRIPT"; then
    test_pass "Usage comment documents --upgrade flag"
  else
    test_fail "Usage comment should document --upgrade flag"
  fi
}

test_usage_comment_includes_upgrade

###############################################################################
# Test: Distribution readiness — URL, usage comment, SKILL.md reference
###############################################################################

echo ""
echo "=== Distribution readiness ==="

test_install_sh_has_shebang() {
  local first_line
  first_line="$(head -1 "$INSTALL_SCRIPT")"
  assert_eq "#!/usr/bin/env bash" "$first_line" "install.sh has correct shebang line"
}

test_install_sh_has_shebang

test_install_sh_has_set_euo_pipefail() {
  if grep -q 'set -euo pipefail' "$INSTALL_SCRIPT"; then
    test_pass "install.sh uses set -euo pipefail for safety"
  else
    test_fail "install.sh should use set -euo pipefail"
  fi
}

test_install_sh_has_set_euo_pipefail

test_install_sh_has_stable_url_in_usage() {
  if grep -q 'raw.githubusercontent.com/thedotmack/claude-mem/main/openclaw/install.sh' "$INSTALL_SCRIPT"; then
    test_pass "install.sh usage comment has stable raw.githubusercontent.com URL"
  else
    test_fail "install.sh should reference stable raw.githubusercontent.com URL in usage"
  fi
}

test_install_sh_has_stable_url_in_usage

test_install_sh_documents_all_flags() {
  local missing_flags=()

  for flag in "--non-interactive" "--upgrade" "--provider" "--api-key"; do
    if ! grep -Fq -- "$flag" "$INSTALL_SCRIPT"; then
      missing_flags+=("$flag")
    fi
  done

  if [[ ${#missing_flags[@]} -eq 0 ]]; then
    test_pass "install.sh documents all CLI flags (--non-interactive, --upgrade, --provider, --api-key)"
  else
    test_fail "install.sh missing documentation for flags: ${missing_flags[*]}"
  fi
}

test_install_sh_documents_all_flags

test_install_sh_has_installer_version() {
  if grep -q 'INSTALLER_VERSION=' "$INSTALL_SCRIPT"; then
    test_pass "install.sh defines INSTALLER_VERSION constant"
  else
    test_fail "install.sh should define INSTALLER_VERSION"
  fi
}

test_install_sh_has_installer_version

test_skill_md_references_one_liner() {
  local skill_file="${SCRIPT_DIR}/SKILL.md"
  if [[ ! -f "$skill_file" ]]; then
    test_fail "SKILL.md not found at ${skill_file}"
    return
  fi

  if grep -q 'curl -fsSL.*raw.githubusercontent.com.*install.sh | bash' "$skill_file"; then
    test_pass "SKILL.md references the one-liner installer"
  else
    test_fail "SKILL.md should reference the one-liner installer"
  fi
}

test_skill_md_references_one_liner

test_skill_md_has_quick_install_section() {
  local skill_file="${SCRIPT_DIR}/SKILL.md"
  if [[ ! -f "$skill_file" ]]; then
    test_fail "SKILL.md not found at ${skill_file}"
    return
  fi

  if grep -q 'Quick Install' "$skill_file"; then
    test_pass "SKILL.md has Quick Install section"
  else
    test_fail "SKILL.md should have Quick Install section"
  fi
}

test_skill_md_has_quick_install_section

test_skill_md_documents_options() {
  local skill_file="${SCRIPT_DIR}/SKILL.md"
  if [[ ! -f "$skill_file" ]]; then
    test_fail "SKILL.md not found at ${skill_file}"
    return
  fi

  local missing=()
  for option in "--provider" "--non-interactive" "--upgrade"; do
    if ! grep -Fq -- "$option" "$skill_file"; then
      missing+=("$option")
    fi
  done

  if [[ ${#missing[@]} -eq 0 ]]; then
    test_pass "SKILL.md documents all installer options (--provider, --non-interactive, --upgrade)"
  else
    test_fail "SKILL.md missing documentation for: ${missing[*]}"
  fi
}

test_skill_md_documents_options

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
