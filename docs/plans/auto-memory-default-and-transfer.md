# Plan: Disable Claude Code auto-memory by default + native-memory transfer

Branch: `feature/default-disable-auto-memory-and-transfer`

## Why
Claude Code's native auto-memory conflicts with claude-mem (shadow state, competes for
context-window tokens). The installer currently defaults to *leaving it enabled*, which is
backwards. We flip the default to **disable**, and — because disabling without rescuing
existing notes is data loss — pair it with a **memory transfer** that ingests existing
native memory into claude-mem, per project, via the SDK compression pipeline.

## Decisions (locked)
- **Transform:** SDK-compressed (run native notes through the compression agent → structured observations).
- **Source files:** Archive originals to `~/.claude-mem/migrated/` after a confirmed transfer (non-destructive of data, removes from the live native location).
- **Install hook:** Yes — installer detects existing native memory and offers the transfer (recommended).

## Investigation findings (with refs)

### Native auto-memory on disk (verified on this machine)
- Path: `~/.claude/projects/<path-encoded-cwd>/memory/MEMORY.md` + topic `*.md` files.
- Dir name = absolute cwd with `/` → `-` (e.g. `-Users-alexnewman-Scripts-claude-mem` → `/Users/alexnewman/Scripts/claude-mem`). NOT repo-URL based.
- `MEMORY.md` = markdown index (links + one-line descriptions); topic files = free-form markdown.
- Honor custom `autoMemoryDirectory` from `~/.claude/settings.json` if set.
- Toggle: `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (documented, precedence-winning, needs CC ≥ 2.1.59).

### Install flow (Problem 1)
- `resolveClaudeAutoMemoryChoice` — `src/npx-cli/commands/install.ts:231-270`.
  - `initialValue: 'leave-enabled'` (line 261) and "(Recommended)" on leave-enabled (line 253) → flip.
  - Non-interactive default returns `'leave-enabled'` (line 244) → flip to `'disable'`.
- `disableClaudeAutoMemory()` — `install.ts:216-227` — correct & idempotent; reuse as-is.
- Summary copy `install.ts:1719-1727`; error remediation `src/npx-cli/install/error-taxonomy.ts:147-151`.

### claude-mem project keying (the bridge)
- `getProjectContext(cwd).primary` — `src/utils/project-name.ts` — git-root basename or `parent/worktree` composite.
- Bridge: decode native dir → absolute path → if it exists, `getProjectContext(path)`; else fall back to path basename (low-confidence flag).

### SDK-compressed ingestion seam (Problem 2) — TWO RUNTIMES, target the worker one
IMPORTANT (corrected after adversarial audit): there is NO clean "raw text in → structured
observation out" API. There are two separate compression stacks:
- **Worker runtime (DEFAULT, SQLite)** — target this. `ClaudeProvider` (`src/services/worker/ClaudeProvider.ts:232,475,506`) builds prompts via `buildObservationPrompt()` (`src/sdk/prompts.ts:117`), runs SDK `query()`, then `ResponseProcessor` (`src/services/worker/agents/ResponseProcessor.ts:156`) parses (`parseAgentXml`, `src/sdk/parser.ts:41`) and writes via `SessionStore.storeObservations()` (`src/services/sqlite/SessionStore.ts:1901`). Driven by live session message buffers through `SessionManager`/`SessionRoutes` — NOT a callable helper.
- **Server-beta runtime (Postgres)** — AVOID for this feature. `ProviderObservationGenerator` + `IngestEventsService` + BullMQ, driven by `agent_events`. `observation_add` (MCP), `POST /v1/memories`, and the ingest pipeline are gated on `CLAUDE_MEM_RUNTIME=server-beta` + API key (`src/servers/mcp-server.ts:240-252`) and will no-op/throw in default mode. `/api/import` is a bulk RESTORE of already-structured rows, not a compressor.

Implication: Phase 2 is real new code driving internal worker session classes, not config. Two viable mechanisms (see decision below):
  (a) Synthesize an import session and inject native files as synthetic observation messages through `ClaudeProvider` → `storeObservations`. Truest to normal observations; most code (must drive SessionManager/session lifecycle). Minimal synthetic-session fields: `memorySessionId`, `project`, `contentSessionId`, `sessionDbId`; pre-register via `ensureMemorySessionIdRegistered()` (`ResponseProcessor.ts:141`).
  (b) Make ONE direct SDK call per file/project producing the observation/`CreateMemoryItemSchema` shape ourselves, then write via `storeObservations()` / the SQLite repo directly. Far less plumbing, still LLM-compressed, but duplicates a slice of prompt logic.
- Lineage: `memory_sources.source_type = 'import'`, `source_uri = <original file path>`; idempotency via content-hash in metadata.

### Native file format (corrected/enriched)
- Topic files have YAML frontmatter (`name`, `description`, `type: feedback|project`) + Why/How markdown body — feed frontmatter as title/hints, body as content.
- Dir encoding replaces BOTH `/` and `.` with `-` (decoder must account for `.`), so decode is ambiguous → disambiguate with `existsSync`.

## Phased implementation

### Phase 1 — Flip the default (small, independently shippable)
1. `resolveClaudeAutoMemoryChoice`: `initialValue: 'disable'`; move "(Recommended)" to the disable option; reword leave-enabled as cautionary; non-interactive default → `'disable'`.
2. Add `--keep-auto-memory` inverse flag (keep existing `--disable-auto-memory`).
3. Update summary copy + error-taxonomy remediation text.

### Phase 2 — Transfer engine (`src/services/memory-transfer/`)
1. `discover()` — read `autoMemoryDirectory` or `~/.claude/projects`; find `*/memory` dirs + files.
2. `mapToProject()` — decode dir → path → `getProjectContext` (existsSync disambiguation; basename fallback).
3. `parseNativeMemory()` — read MEMORY.md index + topic files; carry index descriptions as hints.
4. `compressViaSdk()` — synthetic import session; one per project; yield files as `buildObservationPrompt()` observations; run through ClaudeProvider; `storeObservations()`.
5. Idempotency — dedupe on `(projectId, source_uri, content-hash)`.
6. `archiveSource()` — move migrated native dir → `~/.claude-mem/migrated/<encoded>/` only after success.
7. Unit tests: decoder, mapper, parser, idempotency, archive.

### Phase 3 — CLI command
- `npx claude-mem migrate-memory` (aliases `transfer-memory`). Flags: `--project <name>`, `--all`, `--dry-run`, `--keep-source` (skip archive), `--yes`. Report table: project, files, imported, skipped, archived. Register in `src/npx-cli/index.ts`. Requires worker (SDK compression) — start/ensure it, clear error if unavailable.

### Phase 4 — Install integration
- After auto-memory disable, `discover()`. If native memory found, prompt: "Found native Claude Code memory in N projects. Transfer into claude-mem now? (Recommended)". Honor non-interactive via `--migrate-memory` flag; default skip when non-TTY. Reuse Phase 2 engine.

### Phase 5 — Docs + telemetry
- Update `docs/public/*` (memory/install pages). Add a `memory_migrated` telemetry event (project/file/observation counts) following existing patterns. Changelog auto-generates.

## Risks / mitigations
- Worker down during SDK compression → migrate-memory ensures/starts worker; clear failure message; `--dry-run` needs no worker.
- Decoded path gone → basename fallback, low-confidence flag in report.
- Custom `autoMemoryDirectory` → read from settings, don't hardcode.
- Re-runs → content-hash dedupe makes it safe/idempotent.
- Archive collisions → namespaced by encoded dir + timestamp suffix.
