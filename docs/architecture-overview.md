# claude-mem Architecture Overview

## System Layers

```text
+-----------------------------------------------------------+
|  Claude Code (host)                                       |
|  +-- Hook System (5 events)                               |
|  +-- MCP Client (search tools)                            |
+-----------------------------------------------------------+
|  CLI Layer (Bun)                                          |
|  +-- bun-runner.js (Node->Bun bridge)                     |
|  +-- hook-command.ts (orchestrator)                        |
|  +-- handlers/ (context, session-init, observation,        |
|                 summarize, session-complete)               |
+-----------------------------------------------------------+
|  Worker Daemon (Express, port 37777)                      |
|  +-- SessionManager (session lifecycle)                   |
|  +-- SDKAgent (Claude Agent SDK)                          |
|  +-- SearchManager (search orchestration)                 |
|  +-- ProcessRegistry (subprocess management)              |
|  +-- ChromaSync (embedding synchronization)               |
+-----------------------------------------------------------+
|  Storage Layer                                            |
|  +-- SQLite (claude-mem.db) -- structured data            |
|  +-- ChromaDB (chroma.sqlite3) -- vector embeddings       |
|  +-- MCP Server (interface for Claude Code)               |
+-----------------------------------------------------------+
```

## Hook Lifecycle

| Event | Handler | What it does | Timeout |
|-------|---------|-------------|---------|
| Setup | setup.sh | Install system dependencies | 300s |
| SessionStart | smart-install.js + context | Install deps + start worker + inject context | 60s |
| UserPromptSubmit | session-init | Register session + start SDK agent + semantic injection | 60s |
| PostToolUse | observation | Capture tool usage -> enqueue in worker | 120s |
| Summary | summarize | Request session summary from SDK agent | 120s |
| SessionEnd | session-complete | End session + drain pending messages | 30s |

## Data Flow

```text
User prompt -> session-init -> /api/sessions/init + /api/context/semantic
  |
Tool use -> observation -> /api/sessions/observations
  |                              |
  |                    PendingMessageStore.enqueue()
  |                              |
  |                    SDKAgent.startSession()
  |                              |
  |                    Claude Agent SDK -> ResponseProcessor
  |                              |
  |                    +-- storeObservations() -> SQLite
  |                    +-- chromaSync.sync() -> ChromaDB
  |                    +-- broadcastObservation() -> SSE/UI
  |
Stop -> summarize -> /api/sessions/summarize
     -> session-complete -> /api/sessions/complete + drain
```

## Key Patterns

### CLAIM-CONFIRM (PendingMessageStore)

```text
enqueue()           -> INSERT status='pending'
claimNextMessage()  -> UPDATE status='processing' (atomic)
confirmProcessed()  -> DELETE (success)
markFailed()        -> UPDATE status='failed' (retry < 3)

Self-healing: messages in 'processing' for >60s reset to 'pending'
```

### Circuit-Breaker (SessionRoutes)

```text
Generator crash -> retry 1 (1s) -> retry 2 (2s) -> retry 3 (4s)
  -> consecutiveRestarts > 3 -> CIRCUIT-BREAKER
  -> markAllSessionMessagesAbandoned(sessionDbId)
  -> Stop. No infinite loop.
```

Counter resets to 0 when generator completes work naturally.

### Graceful Degradation (hook-command.ts)

```text
Transport errors (ECONNREFUSED, timeout, 5xx) -> exit 0 (never block Claude Code)
Client bugs (4xx, TypeError, ReferenceError)  -> exit 2 (blocking, needs fix)
```

The worker being unavailable NEVER blocks the user's Claude Code session.

### Deduplication (observations)

```text
SHA256(memory_session_id + title + narrative)[:16] -> content_hash (16 hex chars)
If hash exists within 30s window -> return existing ID (no insert)
```

### Two Types of Session ID

- `contentSessionId` — from Claude Code, invariant during the session
- `memorySessionId` — from SDK Agent, changes on each worker restart

The conversion between them is handled by SessionStore and is critical for FK constraints.

## Storage

### SQLite (claude-mem.db)

| Table | Key fields | Purpose |
|-------|-----------|---------|
| sdk_sessions | content_session_id, memory_session_id, status | Session lifecycle |
| observations | memory_session_id, type, title, narrative, content_hash | Tool usage observations |
| session_summaries | memory_session_id, request, learned, completed | Session summaries |
| user_prompts | content_session_id, prompt_text | User prompt history |
| pending_messages | session_db_id, status, message_type | CLAIM-CONFIRM queue |
| observation_feedback | observation_id, signal_type | Usage tracking |

### ChromaDB (chroma.sqlite3)

Vector embeddings for semantic search. Each observation generates multiple documents:

```text
obs_{id}_narrative  -> main text
obs_{id}_fact_0     -> first fact
obs_{id}_fact_1     -> second fact
...
```

Accessed via chroma-mcp (MCP process), communication over stdio.

## Process Management

- **ProcessRegistry:** Tracks all Claude SDK subprocesses, manages PID lifecycle
- **Orphan Reaper (5min):** Kills processes with no active session
- **GracefulShutdown:** 7-step shutdown (PID file, children, HTTP server, sessions, MCP, DB, force-kill)
