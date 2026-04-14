# pi-agent-memory

Persistent memory extension for [pi-agents](https://github.com/badlogic/pi-mono) powered by [claude-mem](https://github.com/thedotmack/claude-mem).

Gives pi-coding-agent and any pi-mono-based runtime cross-session, cross-engine memory by connecting to claude-mem's worker service.

## Installation

Requires the claude-mem worker running on `localhost:37777`. Install claude-mem first via `npx claude-mem install` or run the worker from source.

### From npm (recommended)

```bash
pi install npm:pi-agent-memory
```

### From git

```bash
pi install git:github.com/thedotmack/claude-mem
```

### Manual

```bash
cp extensions/pi-mem.ts ~/.pi/agent/extensions/pi-mem.ts
```

### Verify

```bash
# Start pi — the extension auto-loads
pi

# Check connectivity
/memory-status
```

## What It Does

- **Captures observations** — every tool call your pi-agent makes is recorded to claude-mem's database
- **Injects context** — relevant past observations are automatically injected into the LLM context each turn
- **Memory search** — a `memory_recall` tool is registered for the LLM to explicitly search past work
- **Cross-engine sharing** — pi-agent observations live alongside Claude Code, Cursor, Codex, and OpenClaw memories in the same database

## Architecture

```text
Pi-Agent (pi-coding-agent / OpenClaw / custom)
    │
    ├── pi-mem extension (this package)
    │   ├── session_start      ──→  (local state init only)
    │   ├── before_agent_start ──→  POST /api/sessions/init (with prompt)
    │   ├── context            ──→  GET  /api/context/inject
    │   ├── tool_result        ──→  POST /api/sessions/observations
    │   ├── agent_end          ──→  POST /api/sessions/summarize
    │   │                           POST /api/sessions/complete
    │   ├── session_compact    ──→  (preserve session state)
    │   └── session_shutdown   ──→  (cleanup)
    │
    └── memory_recall tool     ──→  GET  /api/search
                                         │
                                         ▼
                            claude-mem worker (port 37777)
                            SQLite + FTS5 + Chroma
                            Shared across all engines
```

## Event Mapping

| Pi-Mono Event | Worker API | Purpose |
|---|---|---|
| `session_start` | — (local state only) | Derive project name, generate session ID |
| `before_agent_start` | `POST /api/sessions/init` | Capture user prompt for privacy filtering |
| `context` | `GET /api/context/inject` | Inject past observations into LLM context |
| `tool_result` | `POST /api/sessions/observations` | Record what tools did (fire-and-forget) |
| `agent_end` | `POST /api/sessions/summarize` + `complete` | AI-compress the session |
| `session_compact` | — | Preserve session ID across context compaction |
| `session_shutdown` | — | Clean up local state |

Derived from the OpenClaw plugin (`claude-mem/openclaw/src/index.ts`), which is a proven integration of claude-mem into a pi-mono-based runtime.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_MEM_PORT` | `37777` | Worker service port |
| `CLAUDE_MEM_HOST` | `127.0.0.1` | Worker service host |
| `PI_MEM_PROJECT` | (derived from cwd) | Project name for scoping observations |
| `PI_MEM_DISABLED` | — | Set to `1` to disable the extension |

## Cross-Engine Memory

All engines write to the same `~/.claude-mem/claude-mem.db`, tagged by `platform_source`:

| Engine | Platform Source |
|---|---|
| Claude Code | `claude` |
| OpenClaw | `openclaw` |
| Pi-Agent | `pi-agent` |
| Cursor | `cursor` |
| Codex | `codex` |

Context injection returns observations from all engines for the same project by default. Pass `platformSource` to filter by engine.

## Related Packages

Other independent claude-mem adapters published to npm:

- [`@ephemushroom/opencode-claude-mem`](https://www.npmjs.com/package/@ephemushroom/opencode-claude-mem) — OpenCode adapter (MIT)
- [`opencode-cmem`](https://www.npmjs.com/package/opencode-cmem) — OpenCode adapter (MIT)

Other pi memory extensions (standalone, not claude-mem based):

- [`@samfp/pi-memory`](https://www.npmjs.com/package/@samfp/pi-memory) — Learns corrections/preferences from sessions
- [`@zhafron/pi-memory`](https://www.npmjs.com/package/@zhafron/pi-memory) — Memory management + identity
- [`@db0-ai/pi`](https://www.npmjs.com/package/@db0-ai/pi) — Auto fact extraction, local SQLite

## Development

```bash
# Edit the extension
vim extensions/pi-mem.ts

# Test locally
pi -e ./extensions/pi-mem.ts

# Or install from local path
pi install ./pi-agent
```

## License

AGPL-3.0 — same as [claude-mem](https://github.com/thedotmack/claude-mem/blob/main/LICENSE).
