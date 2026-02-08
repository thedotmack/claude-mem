# OpenClaw Claude-Mem Plugin — Manual E2E Testing Checklist

This document covers end-to-end verification of the OpenClaw claude-mem plugin. It assumes you have a working OpenClaw gateway and a running claude-mem worker.

---

## Prerequisites

- OpenClaw gateway installed and configured
- Claude-Mem worker running on port 37777 (default)
- Plugin built: `cd openclaw && npm run build`
- Plugin registered in `~/.openclaw/openclaw.json`

---

## 1. Verify the Claude-Mem Worker

```bash
# Health check — should return {"status":"ok"}
curl -s http://localhost:37777/health

# Verify SSE stream is active (will print events for ~3 seconds then exit)
curl -s -N http://localhost:37777/stream --max-time 3 2>/dev/null || true
```

**Expected:** Health returns `{"status":"ok"}`. SSE stream emits at least a `connected` event.

**If the worker is not running:**

```bash
cd /path/to/claude-mem
npm run build-and-sync
```

Then re-check health.

---

## 2. Verify Plugin Configuration

Check that `~/.openclaw/openclaw.json` has the plugin entry:

```bash
cat ~/.openclaw/openclaw.json
```

**Expected structure** (inside `plugins.entries`):

```json
{
  "claude-mem": {
    "enabled": true,
    "source": "/path/to/claude-mem/openclaw",
    "config": {
      "syncMemoryFile": true,
      "workerPort": 37777,
      "observationFeed": {
        "enabled": true,
        "channel": "telegram",
        "to": "YOUR_CHAT_ID"
      }
    }
  }
}
```

**Key fields:**
- `observationFeed.enabled` must be `true`
- `observationFeed.channel` must match a supported channel: `telegram`, `discord`, `signal`, `slack`, `whatsapp`, `line`
- `observationFeed.to` must be the target chat/user/channel ID for the chosen channel

---

## 3. Restart the OpenClaw Gateway

After any config change, restart the gateway so it picks up the new plugin config:

```bash
openclaw restart
# or, depending on your setup:
openclaw gateway stop && openclaw gateway start
```

**Look for in gateway logs:**
- `[claude-mem] OpenClaw plugin loaded — v1.0.0`
- `[claude-mem] Observation feed starting — channel: telegram, target: ...`
- `[claude-mem] Connecting to SSE stream at http://localhost:37777/stream`
- `[claude-mem] Connected to SSE stream`

---

## 4. Trigger an Observation

Start a Claude Code session with claude-mem enabled:

```bash
claude
```

Perform any action that generates an observation (e.g., read a file, make a search, write code). The claude-mem worker will emit a `new_observation` SSE event.

---

## 5. Verify Message Delivery

Check the target messaging channel (e.g., Telegram) for a message formatted as:

```
🧠 Claude-Mem Observation
**Observation Title**
Optional subtitle
```

**Expected:** Within a few seconds of the observation being saved, a message appears in the configured channel.

---

## 6. Run Automated Tests

```bash
cd openclaw

# Full test suite (compiles TypeScript then runs tests)
npm test

# Smoke test (registration check only, requires prior build)
node test-sse-consumer.js
```

**Expected:** All 17 tests pass. Smoke test prints `PASS: Plugin registers service and command correctly`.

---

## Troubleshooting

### Worker not running
- **Symptom:** Gateway logs show `SSE stream error: fetch failed. Reconnecting in 1s`
- **Fix:** Start the worker with `cd /path/to/claude-mem && npm run build-and-sync`

### Port mismatch
- **Symptom:** SSE connection fails even though worker health check passes
- **Fix:** Ensure `workerPort` in plugin config matches the worker's actual port (default: 37777). Check `~/.claude-mem/settings.json` for the worker port setting.

### Channel not configured
- **Symptom:** Gateway logs show `[claude-mem] Observation feed misconfigured — channel or target missing`
- **Fix:** Add both `channel` and `to` fields to `observationFeed` in plugin config. Restart the gateway.

### Unknown channel type
- **Symptom:** Gateway logs show `[claude-mem] Unknown channel type: <name>`
- **Fix:** Use one of the supported channels: `telegram`, `discord`, `signal`, `slack`, `whatsapp`, `line`

### Feed disabled
- **Symptom:** Gateway logs show `[claude-mem] Observation feed disabled`
- **Fix:** Set `observationFeed.enabled` to `true` in plugin config. Restart the gateway.

### Messages not arriving
- **Symptom:** SSE connected, observations flowing, but no messages in chat
- **Fix:**
  1. Verify the bot/integration is properly configured in the target channel
  2. Check the target ID (`to`) is correct for the channel type
  3. Look for `[claude-mem] Failed to send to <channel>: ...` in gateway logs
  4. Test the channel directly through the OpenClaw gateway's channel testing tools
