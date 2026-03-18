# Claude-Mem OpenClaw Plugin — Setup Guide

This guide walks through setting up the claude-mem plugin on an OpenClaw gateway. By the end, your agents will have persistent memory across sessions via system prompt context injection, and optionally a real-time observation feed streaming to a messaging channel.

## Quick Install (Recommended)

Run this one-liner to install everything automatically:

```bash
curl -fsSL https://install.cmem.ai/openclaw.sh | bash
```

The installer handles dependency checks (Bun, uv), plugin installation, memory slot configuration, AI provider setup, worker startup, and optional observation feed configuration — all interactively.

### Install with options

Pre-select your AI provider and API key to skip interactive prompts:

```bash
curl -fsSL https://install.cmem.ai/openclaw.sh | bash -s -- --provider=gemini --api-key=YOUR_KEY
```

For fully unattended installation (defaults to Claude Max Plan, skips observation feed):

```bash
curl -fsSL https://install.cmem.ai/openclaw.sh | bash -s -- --non-interactive
```

To upgrade an existing installation (preserves settings, updates plugin):

```bash
curl -fsSL https://install.cmem.ai/openclaw.sh | bash -s -- --upgrade
```

After installation, skip to [Step 4: Restart the Gateway and Verify](#step-4-restart-the-gateway-and-verify) to confirm everything is working.

---

## Manual Setup

The steps below are for manual installation if you prefer not to use the automated installer, or need to troubleshoot individual steps.

### Step 1: Clone the Claude-Mem Repo

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

### Step 2: Get the Worker Running

The claude-mem worker is an HTTP service on port 37777. It stores observations, generates summaries, and serves the context timeline. The plugin talks to it over HTTP — it doesn't matter where the worker is running, just that it's reachable on localhost:37777.

#### Check if it's already running

If this machine also runs Claude Code with claude-mem installed, the worker may already be running:

```bash
curl http://localhost:37777/api/health
```

**Got `{"status":"ok"}`?** The worker is already running. Skip to Step 3.

**Got connection refused or no response?** The worker isn't running. Continue below.

#### If Claude Code has claude-mem installed

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

#### If there's no Claude Code installation

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

### Step 3: Add the Plugin to Your Gateway

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

#### Config fields explained

- **`project`** (string, default: `"openclaw"`) — The project name that scopes all observations in the memory database. Use a unique name per gateway/use-case so observations don't mix. For example, if this gateway runs a coding bot, use `"coding-bot"`.

- **`syncMemoryFile`** (boolean, default: `true`) — When enabled, the plugin injects the observation timeline into each agent's system prompt via the `before_prompt_build` hook. This gives agents cross-session context without writing to MEMORY.md. Set to `false` to disable context injection entirely (observations are still recorded).

- **`syncMemoryFileExclude`** (string[], default: `[]`) — Agent IDs excluded from automatic context injection. Useful for agents that curate their own memory. Observations are still recorded for excluded agents.

- **`workerPort`** (number, default: `37777`) — The port where the claude-mem worker service is listening. Only change this if you configured the worker to use a different port.

---

## Step 4: Restart the Gateway and Verify

Restart your OpenClaw gateway so it picks up the new plugin configuration. After restart, check the gateway logs for:

```
[claude-mem] OpenClaw plugin loaded — v1.0.0 (worker: 127.0.0.1:37777)
```

If you see this, the plugin is loaded. You can also verify by running `/claude_mem_status` in any OpenClaw chat:

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

1. **`before_agent_start`** — Initializes a claude-mem session when the agent starts
2. **`before_prompt_build`** — Injects the observation timeline into the agent's system prompt (cached for 60s)
3. **`tool_result_persist`** — Records each tool use (Read, Write, Bash, etc.) as an observation
4. **`agent_end`** — Summarizes the session and marks it complete

All of this happens automatically. No additional configuration needed.

To verify it's working, check the worker's viewer UI at http://localhost:37777 to see observations appearing after the agent runs.

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

Then run `/claude_mem_feed` in any OpenClaw chat:

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

### /claude_mem_status

Reports worker health and current session state.

```
/claude_mem_status
```

Output:
```
Claude-Mem Worker Status
Status: ok
Port: 37777
Active sessions: 2
Observation feed: connected
```

### /claude_mem_feed

Shows observation feed status. Accepts optional `on`/`off` argument.

```
/claude_mem_feed          — show status
/claude_mem_feed on       — request enable (update config to persist)
/claude_mem_feed off      — request disable (update config to persist)
```

## How It All Works

```
OpenClaw Gateway
  │
  ├── before_agent_start ───→ Init session
  ├── before_prompt_build ──→ Inject context into system prompt
  ├── tool_result_persist ──→ Record observation
  ├── agent_end ────────────→ Summarize + Complete session
  └── gateway_start ────────→ Reset session tracking + context cache
                    │
                    ▼
         Claude-Mem Worker (localhost:37777)
           ├── POST /api/sessions/init
           ├── POST /api/sessions/observations
           ├── POST /api/sessions/summarize
           ├── POST /api/sessions/complete
           ├── GET  /api/context/inject ──→ System prompt context
           └── GET  /stream ─────────────→ SSE → Messaging channels
```

### System prompt context injection

The plugin injects the observation timeline into each agent's system prompt via the `before_prompt_build` hook. The content comes from the worker's `GET /api/context/inject` endpoint. Context is cached for 60 seconds per project to avoid re-fetching on every LLM turn. The cache is cleared on gateway restart.

This keeps MEMORY.md under the agent's control for curated long-term memory, while the observation timeline is delivered through the system prompt.

### Observation recording

Every tool use (Read, Write, Bash, etc.) is sent to the claude-mem worker as an observation. The worker's AI agent processes it into a structured observation with title, subtitle, facts, concepts, and narrative. Tools prefixed with `memory_` are skipped to avoid recursive recording.

### Session lifecycle

- **`before_agent_start`** — Creates a session in the worker.
- **`before_prompt_build`** — Fetches the observation timeline and returns it as `appendSystemContext`. Cached for 60s.
- **`tool_result_persist`** — Records observation (fire-and-forget). Tool responses are truncated to 1000 characters.
- **`agent_end`** — Sends the last assistant message for summarization, then completes the session. Both fire-and-forget.
- **`gateway_start`** — Clears all session tracking (session IDs, context cache) so agents start fresh.

### Observation feed

A background service connects to the worker's SSE stream and forwards `new_observation` events to a configured messaging channel. The connection auto-reconnects with exponential backoff (1s → 30s max).

## Troubleshooting

| Problem | What to check |
|---------|---------------|
| Worker health check fails | Is bun installed? (`bun --version`). Is something else on port 37777? (`lsof -i :37777`). Try running directly: `bun plugin/scripts/worker-service.cjs start` |
| Worker started from Claude Code install but not responding | Check `cd ~/.claude/plugins/marketplaces/thedotmack && npm run worker:status`. May need `npm run worker:restart`. |
| Worker started from cloned repo but not responding | Check `cd /path/to/claude-mem && npm run worker:status`. Make sure you ran `npm install && npm run build` first. |
| No context in agent system prompt | Check that `syncMemoryFile` is not set to `false`. Check that the agent's ID is not in `syncMemoryFileExclude`. Verify the worker is running and has observations. |
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
| `syncMemoryFile` | boolean | `true` | Inject observation context into agent system prompt |
| `syncMemoryFileExclude` | string[] | `[]` | Agent IDs excluded from context injection |
| `workerPort` | number | `37777` | Claude-mem worker service port |
| `observationFeed.enabled` | boolean | `false` | Stream observations to a messaging channel |
| `observationFeed.channel` | string | — | Channel type: `telegram`, `discord`, `slack`, `signal`, `whatsapp`, `line` |
| `observationFeed.to` | string | — | Target chat/channel/user ID |
