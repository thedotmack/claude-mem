# AGENTS.md

Project guide for AI coding agents working with cmem.

---

## Overview

cmem is an agent-agnostic CLI for persistent context memory. It provides terminal access to a memory backend via a pluggable client interface (`IMemoryClient`). The default backend is a local memory worker running an HTTP API on `localhost:37777`.

**Stack:** Bun, TypeScript (strict, ESM), Commander CLI, chalk + cli-table3.

**Build:** `bun run build`
**Test:** `bun test`
**Lint:** `bunx tsc --noEmit`
**Dev:** `bun run src/index.ts -- --help`

---

## Module Map

```
src/
  index.ts              CLI entry point — registers all commands with Commander
  types.ts              All TypeScript interfaces (mirrors worker API responses)
  config.ts             Config resolution (CMEM_* env > settings.json > defaults)
  memory-client.ts      IMemoryClient interface — the backend abstraction
  client.ts             WorkerClient — HTTP implementation of IMemoryClient
  client-factory.ts     Factory — resolves the correct backend from config
  output.ts             Dual-mode output — human (chalk/tables) vs agent (JSON)
  errors.ts             ExitCode enum, CLIError class, error factories

  commands/
    search.ts           search <query> — Layer 1 progressive disclosure
    timeline.ts         timeline [anchor] — Layer 2 chronological context
    get.ts              get <ids...> — Layer 3 full observation details
    stats.ts            stats — worker + database statistics
    projects.ts         projects — list all projects
    observations.ts     observations — browse paginated observations
    sessions.ts         sessions — browse session summaries
    context.ts          context — context injection preview
    remember.ts         remember <text> — save manual memory
    settings.ts         settings [list|get|set] — settings management
    logs.ts             logs — view/clear worker logs
    worker.ts           worker [status|start|stop|restart] — worker management
    queue.ts            queue [status|process|clear] — queue management
    stream.ts           stream — live SSE observation stream + tmux sidebar
    endless.ts          endless [on|off|status] — endless mode control
    decisions.ts        decisions — semantic shortcut for decision observations
    changes.ts          changes — semantic shortcut for change observations
    how.ts              how <query> — how-it-works explanations
    export.ts           export-data — export memories to file
    import.ts           import-data <file> — import memories from file

  formatters/
    table.ts            Human-readable tables (cli-table3 + chalk)
    json.ts             Agent JSON output (stable CLIResponse schema)
    icons.ts            Observation type icon mapping
    markdown.ts         Markdown formatter for piping

  tmux/
    sidebar.ts          Tmux split-window pane management
    sse-consumer.ts     SSE event stream consumer (fetch + ReadableStream)
    renderer.ts         Terminal renderer for live observation feed

  utils/
    detect.ts           TTY detection, terminal width, tmux detection
    validate.ts         Input validation (traversal, control chars, allowlists)
    privacy.ts          Strip <private> tags from output
    version.ts          Version from package.json
```

---

## IMemoryClient Interface

All commands use `IMemoryClient`, never a concrete client directly. This is the stable abstraction that enables backend swapping without touching command code.

```typescript
// src/memory-client.ts
export interface IMemoryClient {
  isHealthy(): Promise<boolean>;

  // Progressive disclosure
  search(params: SearchParams): Promise<SearchResponse>;
  timeline(params: TimelineParams): Promise<TimelineResponse>;
  getObservations(params: BatchParams): Promise<Observation[]>;

  // Data browsing
  getObservationById(id: number): Promise<Observation>;
  listObservations(params: ListParams): Promise<PaginatedResponse<Observation>>;
  listSummaries(params: ListParams): Promise<PaginatedResponse<SessionSummary>>;
  getStats(): Promise<WorkerStats>;
  getProjects(): Promise<ProjectsResponse>;

  // Semantic shortcuts
  decisions(params: ListParams): Promise<SearchResponse>;
  changes(params: ListParams): Promise<SearchResponse>;
  howItWorks(params: ListParams): Promise<SearchResponse>;

  // Context injection
  getContext(project: string, options?: { full?: boolean; colors?: boolean }): Promise<string>;

  // Memory management
  saveMemory(text: string, title?: string, project?: string): Promise<SaveMemoryResponse>;
  importData(data: ImportPayload): Promise<ImportResult>;

  // Settings, logs, processing, branch, streaming...
}
```

When writing a new command, import `createMemoryClient` from `client-factory.ts`. Never import `WorkerClient` directly.

```typescript
import { createMemoryClient } from '../client-factory.js';
import { loadConfig } from '../config.js';

const config = loadConfig();
const client = createMemoryClient(config);  // returns IMemoryClient
const results = await client.search({ query: 'auth', limit: 10 });
```

---

## Backend Selection

The factory in `src/client-factory.ts` resolves which backend to use. Today it always returns `WorkerClient`. Future backends slot in here without touching command code.

```typescript
// src/client-factory.ts
export function createMemoryClient(config: CMEMConfig): IMemoryClient {
  // Future: inspect config.backend to select SQLiteClient, Mem0MCPClient, etc.
  return new WorkerClient(config);
}
```

| Backend | Status | Notes |
|---------|--------|-------|
| `WorkerClient` | Active | HTTP to `localhost:37777`. Default. |
| `SQLiteClient` | Planned | Direct SQLite read, no worker required. |
| `Mem0MCPClient` | Planned | Via MCP protocol. |

To add a new backend: implement `IMemoryClient`, add a selection branch in `client-factory.ts`, extend `CMEMConfig` if new config fields are needed. See `CONTRIBUTING.md` for the full step-by-step.

---

## Agent Usage

All commands support `--json` for structured JSON output. When stdout is piped (not a TTY), JSON output is automatic.

### Memory Search (3-Layer Progressive Disclosure)

```bash
# Layer 1: Search index (lightweight, ~50 tokens/result)
cmem search "authentication" --json --limit 10

# Layer 2: Timeline context around a result
cmem timeline 2543 --before 3 --after 3 --json

# Layer 3: Full observation details (only fetch what you need)
cmem get 2543 2102 --json
```

### Quick Commands

```bash
cmem stats --json                     # Worker + database statistics
cmem projects --json                  # List all projects
cmem decisions --json --limit 5       # Recent decisions
cmem changes --json --limit 5         # Recent changes
cmem remember "insight text" --json   # Save a manual memory
cmem context --project foo --json     # Get context injection
```

### Worker Management

```bash
cmem worker status --json             # Check worker health
cmem queue status --json              # Check processing queue
cmem queue process --limit 5          # Process pending queue
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Worker API error (4xx/5xx response) |
| 2 | Cannot connect to worker (not running) |
| 3 | Invalid arguments (validation error) |
| 4 | Resource not found (observation ID, project) |
| 5 | Internal CLI error |

Exit codes are a stable API. Agents branch on them without parsing error text.

---

## JSON Response Schema

All `--json` output follows:

```json
{
  "ok": true,
  "data": { ... },
  "meta": { "count": 10, "hasMore": true, "offset": 0, "limit": 20 }
}
```

Error responses:

```json
{
  "ok": false,
  "data": null,
  "error": "Worker not running at http://127.0.0.1:37777",
  "code": 2
}
```

Fields are never removed. New fields may be added in minor releases.

---

## Key Patterns

### Dual Output Mode

Every command detects output mode via TTY state and `--json` flag:

```typescript
const mode = detectOutputMode(opts);
// mode is 'human' (colored tables) or 'agent' (JSON)
```

### Input Validation

All user input is validated before reaching the client:

```typescript
import { validateQuery, validateObservationIds, validateSettingKey } from '../utils/validate.js';

const query = validateQuery(rawQuery);         // throws CLIError(INVALID_ARGS) on failure
const ids = validateObservationIds(rawIds);    // positive integers only
validateSettingKey(key);                        // must be in the 35-key allowlist
```

### Privacy

`<private>` tags are stripped from all output as defense-in-depth. The backend also strips at the hook layer.

---

## Non-Negotiable Rules

- Never store or output content wrapped in `<private>` tags
- All input is validated before reaching the client — no exceptions
- Settings modifications only accept allowlisted keys
- Exit codes are stable and semantic — agents rely on them
- JSON output schema is stable — fields may be added but never removed
- The worker runs on localhost only — no remote connections
- Commands import `createMemoryClient`, never `WorkerClient` directly

---

## How to Add a New Command

1. Create `src/commands/<name>.ts`
2. Export `registerXCommand(program: Command)` function
3. Register in `src/index.ts` with import and call
4. Add `--json` option for agent compatibility
5. Use `detectOutputMode` for dual-mode output
6. Validate all inputs before calling the client
7. Use `createMemoryClient(loadConfig())` — never `WorkerClient` directly
8. Write tests in `tests/commands/<name>.test.ts`
9. Update this AGENTS.md module map

---

## Commands for Agents

```bash
# Run all tests
bun test

# TypeScript type check
bun run lint

# Build distributable
bun run build

# Run CLI in dev mode
bun run src/index.ts -- --help
bun run src/index.ts -- search "test" --json
bun run src/index.ts -- stats --json

# Build standalone binary
bun run build:binary
```
