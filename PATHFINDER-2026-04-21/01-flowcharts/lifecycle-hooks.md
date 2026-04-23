# Flowchart: lifecycle-hooks

## Sources Consulted
- `src/cli/hook-command.ts:1-122`
- `src/cli/handlers/index.ts:1-72`
- `src/cli/handlers/context.ts:1-95` (SessionStart)
- `src/cli/handlers/session-init.ts:1-192` (UserPromptSubmit)
- `src/cli/handlers/observation.ts:1-86` (PostToolUse)
- `src/cli/handlers/summarize.ts:1-170` (Stop / Summary phase)
- `src/cli/handlers/session-complete.ts:1-66` (Stop / Completion phase)
- `src/cli/handlers/user-message.ts:1-54` (SessionStart parallel)
- `src/cli/adapters/claude-code.ts:1-45`
- `src/hooks/hook-response.ts:1-12`
- `src/shared/hook-constants.ts:1-35`
- `src/services/worker-service.ts:1-100`
- `src/supervisor/index.ts:1-100`
- `src/services/worker/http/routes/SessionRoutes.ts:1-330`
- `src/services/worker/http/routes/SearchRoutes.ts:1-150`
- `src/services/infrastructure/GracefulShutdown.ts:1-100`
- `src/supervisor/process-registry.ts:1-80`
- `src/services/worker-spawner.ts:1-150`

## Happy Path Description

Claude-Mem's lifecycle-hooks system intercepts Claude Code's session lifecycle events and routes them through specialized handlers that coordinate session tracking, tool observation capture, semantic context injection, and session summarization.

**SessionStart** fires immediately when a session begins. The **context handler** ensures the worker daemon is running, queries the Chroma vector database for relevant past observations, and returns them as `additionalContext` for injection into Claude's prompt. In parallel, **user-message** displays formatted context information to the user's terminal and broadcasts the worker's live dashboard URL. Both handlers gracefully degrade if the worker is unavailable.

**UserPromptSubmit** fires when the user submits their first prompt. The **session-init handler** calls `/api/sessions/init` to create a session record in the database, captures the prompt, checks privacy settings, and optionally starts the Claude SDK agent. If semantic injection is enabled, it fetches relevant observations via `/api/context/semantic` and injects them as additional context alongside the user's prompt.

**PostToolUse** fires after Claude executes each tool. The **observation handler** sends the tool usage (name, input, response) to `/api/sessions/observations` where the worker validates privacy rules, enriches the observation with cwd/platform metadata, stores it in SQLite, and queues an async Chroma embedding for semantic search.

**Stop** hook fires when a session ends. This is split into two phases with different timing guarantees: **summarize handler** queues the session's final assistant message to `/api/sessions/summarize` and then polls `/api/sessions/status` to wait (up to 110s) for the SDK agent to finish processing the summary, then calls `/api/sessions/complete`. The **session-complete handler** (phase 2) marks the session inactive in the sessions map.

## Mermaid Flowchart

```mermaid
flowchart TD
    Start([Claude Code Session<br/>Lifecycle Event]) --> Dispatch{Event Type?<br/>hook-command.ts:88}

    Dispatch -->|SessionStart| CtxSetup["ensureWorkerRunning<br/>worker-spawner.ts:100"]
    Dispatch -->|UserPromptSubmit| InitSetup["ensureWorkerRunning<br/>worker-spawner.ts:100"]
    Dispatch -->|PostToolUse| ObsSetup["ensureWorkerRunning<br/>worker-spawner.ts:100"]
    Dispatch -->|Stop| SumSetup["Check if subagent<br/>summarize.ts:34"]

    CtxSetup -->|Worker unavailable| CtxEmpty["Return empty context<br/>context.ts:44-46"]
    CtxSetup -->|Worker ready| CtxFetch["Fetch /api/context/inject<br/>context.ts:54-56"]
    CtxFetch --> CtxInject["Return additionalContext<br/>context.ts:88-93"]

    CtxInject --> UMsgStart["userMessageHandler parallel<br/>user-message.ts:32"]
    UMsgStart --> UMsgFetch["GET /api/context/inject (colors)<br/>user-message.ts:13-29"]
    UMsgFetch --> UMsgDisplay["Write formatted ctx to stderr<br/>user-message.ts:24-28"]

    InitSetup --> InitGuard["Validate session + cwd + project<br/>session-init.ts:51-61"]
    InitGuard --> InitCall["POST /api/sessions/init<br/>session-init.ts:75-84"]
    InitCall --> InitProcess["Receive sessionDbId + promptNumber<br/>session-init.ts:97-106"]
    InitProcess --> InitSDK["POST /sessions/{id}/init start SDK<br/>session-init.ts:141-150"]
    InitSDK --> InitSemantic["Semantic injection enabled?<br/>session-init.ts:158-159"]
    InitSemantic -->|Yes| SemanticFetch["POST /api/context/semantic<br/>session-init.ts:164-165"]
    SemanticFetch --> SemanticInject["Return additionalContext<br/>session-init.ts:179-188"]

    ObsSetup --> ObsGuard["Validate toolName + cwd + not excluded<br/>observation.ts:40-62"]
    ObsGuard --> ObsSend["POST /api/sessions/observations<br/>observation.ts:65-77"]
    ObsSend --> ObsDB["Worker stores + queues Chroma embed<br/>SessionRoutes.ts:30"]

    SumSetup -->|Not subagent| SumEnsure["ensureWorkerRunning<br/>summarize.ts:44"]
    SumEnsure --> SumValidate["Extract last assistant msg<br/>summarize.ts:50-78"]
    SumValidate --> SumQueue["POST /api/sessions/summarize<br/>summarize.ts:86-104"]
    SumQueue --> SumPoll["Poll /api/sessions/status 500ms up to 110s<br/>summarize.ts:117-150"]
    SumPoll --> SumComplete["POST /api/sessions/complete<br/>summarize.ts:156-161"]

    SumComplete --> SessionComplete["sessionCompleteHandler phase 2<br/>session-complete.ts:32"]
    SessionComplete --> SCSend["POST /api/sessions/complete<br/>remove from active map<br/>session-complete.ts:54"]

    CtxEmpty --> Done([Exit code 0<br/>hook-command.ts:106])
    UMsgDisplay --> Done
    SemanticInject --> Done
    ObsDB --> Done
    SCSend --> Done
```

## Side Effects

**HTTP Calls to Worker (port 37777):**
- `GET /api/context/inject` — returns markdown context for injection
- `POST /api/sessions/init` — creates session record, returns sessionDbId
- `POST /api/context/semantic` — semantic search on Chroma
- `POST /sessions/{sessionDbId}/init` — starts SDK agent
- `POST /api/sessions/observations` — stores tool usage observation
- `POST /api/sessions/summarize` — queues summary generation
- `GET /api/sessions/status` — polls queue length
- `POST /api/sessions/complete` — marks session inactive

**Database (SQLite via worker):**
- Inserts into `sdk_sessions`, `user_prompts`, `observations`
- Updates `sdk_sessions.summary` with `summary_stored` flag

**Process Management:**
- `ensureWorkerStarted` spawns worker daemon via `spawnDaemon` if not alive
- SDK agent subprocess spawned per session
- Summarize handler waits up to 110s for SDK agent to finish

**File I/O:**
- Worker PID file at `~/.claude-mem/worker.pid`
- Hook logs at `~/.claude-mem/logs/hook.log`

## External Feature Dependencies

**Calls into:**
- **context-injection-engine** (via `/api/context/inject`, `/api/context/semantic`)
- **sqlite-persistence** (all writes via worker HTTP)
- **vector-search-sync** (async Chroma embeds)
- **session-lifecycle-management** (session state, SDK subprocess)
- **privacy-tag-filtering** (observation content filtered before storage)
- **http-server-routes** (all HTTP communication)

**Called by:**
- Claude Code CLI plugin harness (registered hooks)
- Cursor IDE (routed through observation handler)
- Gemini CLI / OpenRouter adapters

## Confidence + Gaps

**High Confidence:** Hook lifecycle → handler mapping; HTTP endpoints + payloads; graceful degradation on worker unavailability; exit code 0 strategy.

**Medium Confidence:** Exact SDK agent lifecycle and crash recovery; Cursor hook integration paths.

**Gaps:** Hook installer (how hooks register in Claude Code settings); TypeScript build → CLI entry process.
