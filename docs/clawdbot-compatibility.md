# Clawdbot/Moltbot Compatibility

Claude-mem automatically detects when running in a Clawdbot/moltbot environment and adapts its behavior to avoid conflicts with Clawdbot's native memory management.

## What is Clawdbot?

[Clawdbot](https://github.com/clawdbot/clawdbot) is an AI agent runtime that provides persistent memory, multi-channel messaging, and autonomous workflows. When Claude Code runs inside a Clawdbot environment, the agent already has access to:

- `MEMORY.md` — Long-term curated memories
- `memory/*.md` — Daily notes and context
- `AGENTS.md` — Agent instructions
- `SOUL.md` — Agent identity/personality

## Detection

Claude-mem detects Clawdbot environments via:

### 1. Environment Variables (Highest Priority)

| Variable | Description |
|----------|-------------|
| `CLAWDBOT_GATEWAY_TOKEN` | Gateway authentication token |
| `CLAWDBOT_GATEWAY_PORT` | Gateway API port |
| `CLAWDBOT_PATH_BOOTSTRAPPED` | Workspace initialization flag |
| `CLAWDBOT_AGENT` | Explicit agent marker |

### 2. Config File

Presence of `~/.clawdbot/clawdbot.json` indicates Clawdbot installation.

### 3. Workspace Signatures

Presence of 2+ moltbot signature files indicates a moltbot-managed workspace:

- `AGENTS.md` — Agent instructions
- `SOUL.md` — Agent identity
- `IDENTITY.md` — Agent metadata
- `HEARTBEAT.md` — Cron/heartbeat config
- `TOOLS.md` — Tool configuration
- `USER.md` — User context
- `WORKLEDGER.md` — Work tracking
- `MEMORY.md` — Long-term memory

## Compatibility Mode

When Clawdbot is detected with high/medium confidence AND `MEMORY.md` exists, claude-mem enables **compatibility mode**:

### What Changes

| Aspect | Normal Mode | Compatibility Mode |
|--------|-------------|-------------------|
| Session context injection | Full claude-mem context | Minimal, defers to Clawdbot |
| Memory storage | claude-mem database only | Also syncs key observations |
| Context conflicts | Possible duplication | Avoided |

### What Stays the Same

- Tool observation capture continues (valuable for search)
- Web viewer UI remains functional
- MCP search tools work normally
- Database storage continues for history

## Configuration

You can override automatic detection in `~/.claude-mem/settings.json`:

```json
{
  "clawdbot": {
    "compatibility": "auto",  // "auto" | "enabled" | "disabled"
    "syncToMemory": false     // Sync observations to Clawdbot's memory
  }
}
```

## API

### Detection Function

```typescript
import { detectClawdbotEnvironment } from 'claude-mem';

const env = detectClawdbotEnvironment(process.cwd());

console.log(env);
// {
//   detected: true,
//   confidence: 'high',
//   detectionMethod: 'env:CLAWDBOT_GATEWAY_TOKEN',
//   features: {
//     hasMemoryMd: true,
//     hasAgentsMd: true,
//     hasSoulMd: true,
//     hasHeartbeatMd: false
//   }
// }
```

### Check Compatibility Mode

```typescript
import { shouldUseCompatibilityMode } from 'claude-mem';

if (shouldUseCompatibilityMode(env)) {
  // Reduce context injection to avoid conflicts
}
```

## Troubleshooting

### Claude-mem context conflicts with Clawdbot

If you see duplicate or conflicting context:

1. Check if compatibility mode is enabled:
   ```bash
   curl http://localhost:37777/api/status | jq .clawdbot
   ```

2. Force compatibility mode:
   ```json
   {
     "clawdbot": {
       "compatibility": "enabled"
     }
   }
   ```

### Want claude-mem to ignore Clawdbot

If you want full claude-mem behavior even in Clawdbot:

```json
{
  "clawdbot": {
    "compatibility": "disabled"
  }
}
```

## Related

- [Clawdbot Documentation](https://docs.clawd.bot)
- [Loa Framework](https://github.com/0xHoneyJar/loa)
- [Context Engineering](./context-engineering.md)
