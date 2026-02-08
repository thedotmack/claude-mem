# OpenClaw Claude-Mem Plugin — Testing Guide

## Quick Start (Docker)

The fastest way to test the plugin is using the pre-built Docker E2E environment:

```bash
cd openclaw

# Automated test (builds, installs plugin on real OpenClaw, verifies everything)
./test-e2e.sh

# Interactive shell (for manual exploration)
./test-e2e.sh --interactive

# Just build the image
./test-e2e.sh --build-only
```

---

## Test Layers

### 1. Unit Tests (fastest)

```bash
cd openclaw
npm test    # compiles TypeScript, runs 17 tests
```

Tests plugin registration, service lifecycle, command handling, SSE integration, and all 6 channel types.

### 2. Smoke Test

```bash
node test-sse-consumer.js
```

Quick check that the plugin loads and registers its service + command correctly.

### 3. Container Unit Tests (fresh install)

```bash
./test-container.sh          # Unit tests in clean Docker
./test-container.sh --full   # Integration tests with mock worker
```

### 4. E2E on Real OpenClaw (Docker)

```bash
./test-e2e.sh
```

This is the most comprehensive test. It:
1. Uses the official `ghcr.io/openclaw/openclaw:main` Docker image
2. Installs the plugin via `openclaw plugins install` (same as a real user)
3. Enables the plugin via `openclaw plugins enable`
4. Starts a mock claude-mem worker on port 37777
5. Starts the OpenClaw gateway with plugin config
6. Verifies the plugin loads, connects to SSE, and processes events

**All 16 checks must pass.**

---

## Human E2E Testing (Interactive Docker)

For manual walkthrough testing, use the interactive Docker mode:

```bash
./test-e2e.sh --interactive
```

This drops you into a fully-configured OpenClaw container with the plugin pre-installed.

### Step-by-step inside the container

#### 1. Verify plugin is installed

```bash
node openclaw.mjs plugins list
node openclaw.mjs plugins info claude-mem
node openclaw.mjs plugins doctor
```

**Expected:**
- `claude-mem` appears in the plugins list as "enabled" or "loaded"
- Info shows version 1.0.0, source at `/home/node/.openclaw/extensions/claude-mem/`
- Doctor reports no issues

#### 2. Inspect plugin files

```bash
ls -la /home/node/.openclaw/extensions/claude-mem/
cat /home/node/.openclaw/extensions/claude-mem/openclaw.plugin.json
cat /home/node/.openclaw/extensions/claude-mem/package.json
```

**Expected:**
- `dist/index.js` exists (compiled plugin)
- `openclaw.plugin.json` has `"id": "claude-mem"` and `"kind": "memory"`
- `package.json` has `openclaw.extensions` field pointing to `./dist/index.js`

#### 3. Start mock worker

```bash
node /app/mock-worker.js &
```

Verify it's running:

```bash
curl -s http://localhost:37777/health
# → {"status":"ok"}

curl -s --max-time 3 http://localhost:37777/stream
# → data: {"type":"connected","message":"Mock worker SSE stream"}
# → data: {"type":"new_observation","observation":{...}}
```

#### 4. Configure and start gateway

```bash
cat > /home/node/.openclaw/openclaw.json << 'EOF'
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
EOF

node openclaw.mjs gateway --allow-unconfigured --verbose --token e2e-test-token
```

**Expected in gateway logs:**
- `[claude-mem] OpenClaw plugin loaded — v1.0.0`
- `[claude-mem] Observation feed starting — channel: telegram, target: test-chat-id-12345`
- `[claude-mem] Connecting to SSE stream at http://localhost:37777/stream`
- `[claude-mem] Connected to SSE stream`

#### 5. Run automated verification (optional)

From a second shell in the container (or after stopping the gateway):

```bash
/bin/bash /app/e2e-verify.sh
```

---

## Manual E2E (Real OpenClaw + Real Worker)

For testing with a real claude-mem worker and real messaging channel:

### Prerequisites

- OpenClaw gateway installed and configured
- Claude-Mem worker running on port 37777
- Plugin built: `cd openclaw && npm run build`

### 1. Install the plugin

```bash
# Build the plugin
cd openclaw && npm run build

# Install on OpenClaw (from the openclaw/ directory)
openclaw plugins install .

# Enable it
openclaw plugins enable claude-mem
```

### 2. Configure

Edit `~/.openclaw/openclaw.json` to add plugin config:

```json
{
  "plugins": {
    "entries": {
      "claude-mem": {
        "enabled": true,
        "config": {
          "workerPort": 37777,
          "observationFeed": {
            "enabled": true,
            "channel": "telegram",
            "to": "YOUR_CHAT_ID"
          }
        }
      }
    }
  }
}
```

**Supported channels:** `telegram`, `discord`, `signal`, `slack`, `whatsapp`, `line`

### 3. Restart gateway

```bash
openclaw restart
```

**Look for in logs:**
- `[claude-mem] OpenClaw plugin loaded — v1.0.0`
- `[claude-mem] Connected to SSE stream`

### 4. Trigger an observation

Start a Claude Code session with claude-mem enabled and perform any action. The worker will emit a `new_observation` SSE event.

### 5. Verify delivery

Check the target messaging channel for:

```
🧠 Claude-Mem Observation
**Observation Title**
Optional subtitle
```

---

## Troubleshooting

### `api.log is not a function`
The plugin was built against the wrong API. Ensure `src/index.ts` uses `api.logger.info()` not `api.log()`. Rebuild with `npm run build`.

### Worker not running
- **Symptom:** `SSE stream error: fetch failed. Reconnecting in 1s`
- **Fix:** Start the worker: `cd /path/to/claude-mem && npm run build-and-sync`

### Port mismatch
- **Fix:** Ensure `workerPort` in config matches the worker's actual port (default: 37777)

### Channel not configured
- **Symptom:** `Observation feed misconfigured — channel or target missing`
- **Fix:** Add both `channel` and `to` to `observationFeed` in config

### Unknown channel type
- **Fix:** Use: `telegram`, `discord`, `signal`, `slack`, `whatsapp`, or `line`

### Feed disabled
- **Symptom:** `Observation feed disabled`
- **Fix:** Set `observationFeed.enabled: true`

### Messages not arriving
1. Verify the bot/integration is configured in the target channel
2. Check the target ID (`to`) is correct
3. Look for `Failed to send to <channel>` in logs
4. Test the channel via OpenClaw's built-in tools

### Memory slot conflict
- **Symptom:** `plugin disabled (memory slot set to "memory-core")`
- **Fix:** Add `"slots": { "memory": "claude-mem" }` to plugins config
