# Claude-Mem OpenClaw Plugin — Setup Guide

This guide walks through setting up the claude-mem plugin on an OpenClaw gateway from scratch. Follow every step in order. By the end, your agents will have persistent memory across sessions, a live-updating MEMORY.md in their workspace, and optionally a real-time observation feed streaming to a messaging channel.

## Step 1: Clone the Claude-Mem Repo

First, clone the claude-mem repository to a location accessible by your OpenClaw gateway. This gives you the worker service source and the plugin code.

```bash
cd /opt  # or wherever you want to keep it
git clone https://github.com/thedotmack/claude-mem.git
cd claude-mem
npm install
npm run build
```

You'll need **bun** installed for the worker service. If you don't have it:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Step 2: Get the Worker Running

The claude-mem worker is an HTTP service on port 37777. It stores observations, generates summaries, and serves the context timeline. The plugin talks to it over HTTP — it doesn't matter where the worker is running, just that it's reachable on localhost:37777.

### Check if it's already running

If this machine also runs Claude Code with claude-mem installed, the worker may already be running:

```bash
curl http://localhost:37777/api/health
```

**Got `{"status":"ok"}`?** The worker is already running. Skip to Step 3.

**Got connection refused or no response?** The worker isn't running. Continue below.

### If Claude Code has claude-mem installed

If claude-mem is installed as a Claude Code plugin (at `~/.claude/plugins/marketplaces/thedotmack/`), start the worker from that installation:

```bash
cd ~/.claude/plugins/marketplaces/thedotmack
npm run worker:restart
```

Verify:
```bash
curl http://localhost:37777/api/health
```

**Got `{"status":"ok"}`?** You're set. Skip to Step 3.

**Still not working?** Check `npm run worker:status` for error details, or check that bun is installed and on your PATH.

### If there's no Claude Code installation

Run the worker from the cloned repo:

```bash
cd /opt/claude-mem  # wherever you cloned it
npm run worker:start
```

Verify:
```bash
curl http://localhost:37777/api/health
```

**Got `{"status":"ok"}`?** You're set. Move to Step 3.

**Still not working?** Debug steps:
- Check that bun is installed: `bun --version`
- Check the worker status: `npm run worker:status`
- Check if something else is using port 37777: `lsof -i :37777`
- Check logs: `npm run worker:logs` (if available)
- Try running it directly to see errors: `bun plugin/scripts/worker-service.cjs start`

## Step 3: Add the Plugin to Your Gateway

Add the `claude-mem` plugin to your OpenClaw gateway configuration:

```json
{
  "plugins": {
    "claude-mem": {
      "enabled": true,
      "config": {
        "project": "my-project",
        "syncMemoryFile": true,
        "workerPort": 37777
      }
    }
  }
}
```

### Config fields explained

- **`project`** (string, default: `"openclaw"`) — The project name that scopes all observations in the memory database. Use a unique name per gateway/use-case so observations don't mix. For example, if this gateway runs a coding bot, use `"coding-bot"`.

- **`syncMemoryFile`** (boolean, default: `true`) — When enabled, the plugin writes a `MEMORY.md` file to each agent's workspace directory. This file contains the full timeline of observations and summaries from previous sessions, and it updates on every tool use so agents always have fresh context. Set to `false` only if you don't want the plugin writing files to agent workspaces.

- **`workerPort`** (number, default: `37777`) — The port where the claude-mem worker service is listening. Only change this if you configured the worker to use a different port.

## Step 4: Restart the Gateway and Verify

Restart your OpenClaw gateway so it picks up the new plugin configuration. After restart, check the gateway logs for:

```
[claude-mem] OpenClaw plugin loaded — v1.0.0 (worker: 127.0.0.1:37777)
```

If you see this, the plugin is loaded. You can also verify by running `/claude-mem-status` in any OpenClaw chat:

```
Claude-Mem Worker Status
Status: ok
Port: 37777
Active sessions: 0
Observation feed: disconnected
```

The observation feed shows `disconnected` because we haven't configured it yet. That's next.

## Step 5: Verify Observations Are Being Recorded

Have an agent do some work. The plugin automatically records observations through these OpenClaw events:

1. **`before_agent_start`** — Initializes a claude-mem session when the agent starts, syncs MEMORY.md to the workspace
2. **`tool_result_persist`** — Records each tool use (Read, Write, Bash, etc.) as an observation, re-syncs MEMORY.md
3. **`agent_end`** — Summarizes the session and marks it complete

All of this happens automatically. No additional configuration needed.

To verify it's working, check the agent's workspace directory for a `MEMORY.md` file after the agent runs. It should contain a formatted timeline of observations.

You can also check the worker's viewer UI at http://localhost:37777 to see observations appearing in real time.

## Step 6: Set Up the Observation Feed (Streaming to a Channel)

The observation feed connects to the claude-mem worker's SSE (Server-Sent Events) stream and forwards every new observation to a messaging channel in real time. Your agents learn things, and you see them learning in your Telegram/Discord/Slack/etc.

### What you'll see

Every time claude-mem creates a new observation from your agent's tool usage, a message like this appears in your channel:

```
🧠 Claude-Mem Observation
**Implemented retry logic for API client**
Added exponential backoff with configurable max retries to handle transient failures
```

### Pick your channel

You need two things:
- **Channel type** — Must match a channel plugin already running on your OpenClaw gateway
- **Target ID** — The chat/channel/user ID where messages go

#### Telegram

Channel type: `telegram`

To find your chat ID:
1. Message @userinfobot on Telegram — https://t.me/userinfobot
2. It replies with your numeric chat ID (e.g., `123456789`)
3. For group chats, the ID is negative (e.g., `-1001234567890`)

```json
"observationFeed": {
  "enabled": true,
  "channel": "telegram",
  "to": "123456789"
}
```

#### Discord

Channel type: `discord`

To find your channel ID:
1. Enable Developer Mode in Discord: Settings → Advanced → Developer Mode
2. Right-click the target channel → Copy Channel ID

```json
"observationFeed": {
  "enabled": true,
  "channel": "discord",
  "to": "1234567890123456789"
}
```

#### Slack

Channel type: `slack`

To find your channel ID (not the channel name):
1. Open the channel in Slack
2. Click the channel name at the top
3. Scroll to the bottom of the channel details — the ID looks like `C01ABC2DEFG`

```json
"observationFeed": {
  "enabled": true,
  "channel": "slack",
  "to": "C01ABC2DEFG"
}
```

#### Signal

Channel type: `signal`

Use the phone number or group ID configured in your OpenClaw gateway's Signal plugin.

```json
"observationFeed": {
  "enabled": true,
  "channel": "signal",
  "to": "+1234567890"
}
```

#### WhatsApp

Channel type: `whatsapp`

Use the phone number or group JID configured in your OpenClaw gateway's WhatsApp plugin.

```json
"observationFeed": {
  "enabled": true,
  "channel": "whatsapp",
  "to": "+1234567890"
}
```

#### LINE

Channel type: `line`

Use the user ID or group ID from the LINE Developer Console.

```json
"observationFeed": {
  "enabled": true,
  "channel": "line",
  "to": "U1234567890abcdef"
}
```

### Add it to your config

Your complete plugin config should now look like this (using Telegram as an example):

```json
{
  "plugins": {
    "claude-mem": {
      "enabled": true,
      "config": {
        "project": "my-project",
        "syncMemoryFile": true,
        "workerPort": 37777,
        "observationFeed": {
          "enabled": true,
          "channel": "telegram",
          "to": "123456789"
        }
      }
    }
  }
}
```

### Restart and verify

Restart the gateway. Check the logs for these three lines in order:

```
[claude-mem] Observation feed starting — channel: telegram, target: 123456789
[claude-mem] Connecting to SSE stream at http://localhost:37777/stream
[claude-mem] Connected to SSE stream
```

Then run `/claude-mem-feed` in any OpenClaw chat:

```
Claude-Mem Observation Feed
Enabled: yes
Channel: telegram
Target: 123456789
Connection: connected
```

If `Connection` shows `connected`, you're done. Have an agent do some work and watch observations stream to your channel.

## Commands Reference

The plugin registers two commands:

### /claude-mem-status

Reports worker health and current session state.

```
/claude-mem-status
```

Output:
```
Claude-Mem Worker Status
Status: ok
Port: 37777
Active sessions: 2
Observation feed: connected
```

### /claude-mem-feed

Shows observation feed status. Accepts optional `on`/`off` argument.

```
/claude-mem-feed          — show status
/claude-mem-feed on       — request enable (update config to persist)
/claude-mem-feed off      — request disable (update config to persist)
```

## How It All Works

```
OpenClaw Gateway
  │
  ├── before_agent_start ──→ Sync MEMORY.md + Init session
  ├── tool_result_persist ──→ Record observation + Re-sync MEMORY.md
  ├── agent_end ────────────→ Summarize + Complete session
  └── gateway_start ────────→ Reset session tracking
                    │
                    ▼
         Claude-Mem Worker (localhost:37777)
           ├── POST /api/sessions/init
           ├── POST /api/sessions/observations
           ├── POST /api/sessions/summarize
           ├── POST /api/sessions/complete
           ├── GET  /api/context/inject ──→ MEMORY.md content
           └── GET  /stream ─────────────→ SSE → Messaging channels
```

### MEMORY.md live sync

The plugin writes `MEMORY.md` to each agent's workspace with the full observation timeline. It updates:
- On every `before_agent_start` — agent gets fresh context before starting
- On every `tool_result_persist` — context stays current as the agent works

Updates are fire-and-forget (non-blocking). The agent is never held up waiting for MEMORY.md to write.

### Observation recording

Every tool use (Read, Write, Bash, etc.) is sent to the claude-mem worker as an observation. The worker's AI agent processes it into a structured observation with title, subtitle, facts, concepts, and narrative. Tools prefixed with `memory_` are skipped to avoid recursive recording.

### Session lifecycle

- **`before_agent_start`** — Creates a session in the worker, syncs MEMORY.md. Short prompts (under 10 chars) skip session init but still sync.
- **`tool_result_persist`** — Records observation (fire-and-forget), re-syncs MEMORY.md (fire-and-forget). Tool responses are truncated to 1000 characters.
- **`agent_end`** — Sends the last assistant message for summarization, then completes the session. Both fire-and-forget.
- **`gateway_start`** — Clears all session tracking (session IDs, workspace mappings) so agents start fresh.

### Observation feed

A background service connects to the worker's SSE stream and forwards `new_observation` events to a configured messaging channel. The connection auto-reconnects with exponential backoff (1s → 30s max).

## Troubleshooting

| Problem | What to check |
|---------|---------------|
| Worker health check fails | Is bun installed? (`bun --version`). Is something else on port 37777? (`lsof -i :37777`). Try running directly: `bun plugin/scripts/worker-service.cjs start` |
| Worker started from Claude Code install but not responding | Check `cd ~/.claude/plugins/marketplaces/thedotmack && npm run worker:status`. May need `npm run worker:restart`. |
| Worker started from cloned repo but not responding | Check `cd /path/to/claude-mem && npm run worker:status`. Make sure you ran `npm install && npm run build` first. |
| No MEMORY.md appearing | Check that `syncMemoryFile` is not set to `false`. Verify the agent's event context includes `workspaceDir`. |
| Observations not being recorded | Check gateway logs for `[claude-mem]` messages. The worker must be running and reachable on localhost:37777. |
| Feed shows `disconnected` | Worker's `/stream` endpoint not reachable. Check `workerPort` matches the actual worker port. |
| Feed shows `reconnecting` | Connection dropped. The plugin auto-reconnects — wait up to 30 seconds. |
| `Unknown channel type` in logs | The channel plugin (e.g., telegram) isn't loaded on your gateway. Make sure the channel is configured and running. |
| `Observation feed disabled` in logs | Set `observationFeed.enabled` to `true` in your config. |
| `Observation feed misconfigured` in logs | Both `observationFeed.channel` and `observationFeed.to` are required. |
| No messages in channel despite `connected` | The feed only sends processed observations, not raw tool usage. There's a 1-2 second delay. Make sure the worker is actually processing observations (check http://localhost:37777). |

## Full Config Reference

```json
{
  "plugins": {
    "claude-mem": {
      "enabled": true,
      "config": {
        "project": "openclaw",
        "syncMemoryFile": true,
        "workerPort": 37777,
        "observationFeed": {
          "enabled": false,
          "channel": "telegram",
          "to": "123456789"
        }
      }
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `project` | string | `"openclaw"` | Project name scoping observations in the database |
| `syncMemoryFile` | boolean | `true` | Write MEMORY.md to agent workspaces |
| `workerPort` | number | `37777` | Claude-mem worker service port |
| `observationFeed.enabled` | boolean | `false` | Stream observations to a messaging channel |
| `observationFeed.channel` | string | — | Channel type: `telegram`, `discord`, `slack`, `signal`, `whatsapp`, `line` |
| `observationFeed.to` | string | — | Target chat/channel/user ID |
