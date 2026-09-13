# Handoff: Implement Endless Mode v1 in a new claude-mem worktree

Written 2026-07-17 by the previous session. This doc is self-contained: it tells you what to build, where the spec lives, how to set up the worktree, and every code-verified fact the research phase produced so you don't have to rediscover any of it.

## Mission

Implement **Endless Mode v1** ("the bottle, simply") in claude-mem: when Claude Code auto-compacts or resumes a session, claude-mem renders a "bottle" — a markdown reconstruction of the session merged from the transcript JSONL and the observations DB — and injects a small pointer so the post-compact model reads it and continues with full context instead of compaction amnesia.

## Step 0 — Worktree setup

Main checkout: `/Users/alexnewman/Scripts/claude-mem` (branch `main`, v13.11.0, currently **behind origin/main by 1** — fetch first).

```bash
cd /Users/alexnewman/Scripts/claude-mem
git fetch origin
git worktree add ../claude-mem-endless-mode-v1 -b feat/endless-mode-v1 origin/main
```

**Critical:** the plan files are UNTRACKED in the main checkout — a fresh worktree will NOT contain them. Copy them in (or read them from the absolute paths below):

```bash
cp /Users/alexnewman/Scripts/claude-mem/plans/2026-07-17-endless-mode-v1.md <worktree>/plans/
cp /Users/alexnewman/Scripts/claude-mem/plans/2026-07-16-endless-mode-message-in-a-bottle.md <worktree>/plans/
```

## Step 1 — Required reading

1. **The spec (build from this):** `/Users/alexnewman/Scripts/claude-mem/plans/2026-07-17-endless-mode-v1.md` — self-contained, ~10 numbered sections including a mechanics primer (§4), what to build (§5), bottle format (§6), injection text (§7), deliberate non-goals (§8), tests (§9). No prior reading required.
2. **Optional background:** `/Users/alexnewman/Scripts/claude-mem/plans/2026-07-16-endless-mode-message-in-a-bottle.md` — rev 2 research doc with file:line receipts for every claim below. Superseded by the v1 plan but useful when you want the receipts.
3. `docs/architecture-overview.md` in the repo — good system map, but see "stale doc" warning below.

## The core idea (why v1 is small)

Compaction only destroys the **context window**. The two canonical data sources — the transcript JSONL on disk and the observations SQLite DB — are outside the blast radius and unchanged. So there is nothing to protect before compaction: no PreCompact hook, no seal/drain machinery, no pre-compaction state capture. The bottle is a **derived view** rendered on demand after the fact:

```
bottle = merge_by_position(transcript.jsonl, observations.db)
```

User and assistant messages verbatim; tool traffic replaced by one-line observation references (with `#id` for searchability). 10–20x smaller than the raw transcript. Rendered whole, written atomically (temp + rename), never appended, never a source of truth.

## What to build (4 components, from spec §5)

1. **`BottleRenderer`** — new worker service. Merges transcript + observations, outputs to `~/.claude-mem/bottles/<contentSessionId>.md` via atomic write. Must apply `stripMemoryTags` to every rendered message (see privacy note below).
2. **`POST /api/sessions/render-bottle`** — new worker route in `SessionRoutes.setupRoutes()`.
3. **SessionStart hook branch on `source`** — sources are `startup | compact | resume | clear`. On `compact`/`resume`: POST render-bottle with `wait:true`, 10s timeout, then inject the pointer; fall back to existing timeline context if the worker is down. On `clear`: archive the bottle, inject nothing.
4. **Optional: render-on-Stop** — healing/live-diary pass. Fire after the existing summarize call in `src/cli/handlers/summarize.ts`. Must use awaited queue-and-return, **not** an un-awaited POST (un-awaited POSTs die at `process.exit`).

Plus: new setting `CLAUDE_MEM_ENDLESS_MODE_ENABLED`, default `'true'`, in `SettingsDefaultsManager` (see settings note below), enforced worker-side.

## Code-verified facts (from the research phase — trust these, they were checked against source)

**Session identity / data access**
- `contentSessionId` (Claude Code's ID) is invariant across compaction; `memorySessionId` (SDK agent's) changes on every worker restart. The single join path reaches everything: `content_session_id → sdk_sessions → memory_session_id → observations + session_summaries`. FK is `ON UPDATE CASCADE`, so multi-leg sessions cascade automatically. **Always use the sdk_sessions join** — a community migration (v36–38, not in this repo) added a partially-populated `observations.content_session_id` column; never rely on it.
- `user_prompts` stores verbatim user prompts keyed by `content_session_id`, truncated at 4000 chars (`MAX_STORED_PROMPT_CHARS` in `src/services/sqlite/prompt-storage.ts`). Durable SQLite.
- `session_summaries` stores structured fields (request/investigated/learned/completed/next_steps) — NOT verbatim assistant text. **Never render summaries under an `**Assistant**` heading** — the resumed model will "remember" saying things it never said. Mark provenance explicitly.

**Degraded mode (~97% of sessions have pruned transcripts)**
- Ladder: full bottle (transcript + observations) → reconstructed (verbatim user prompts + observation lines + summaries, clearly provenance-marked, no verbatim assistant turns) → if neither transcript nor stored data exists, renderer reports failure and the hook falls back to today's timeline-context behavior.

**Queue / buffer reality (two spec bugs found and fixed in rev 2 — do not regress)**
- The pending queue is **in-RAM only**: `SessionMessageBuffer` (Map of arrays + per-session `EventEmitter`) replaced the durable SQLite `pending_messages` table. The `CREATE TABLE` at `SessionStore.ts:951` is migration legacy; there are zero `INSERT INTO pending_messages` in the source.
- `clearPendingForSession` (`SessionManager.ts:207`) is **dead code** — zero call sites. The real "agent finished processing" signal is `confirmClaimedMessages` (`SessionManager.ts:219-231`), called from `ResponseProcessor.ts` after `storeObservations()` commits.
- `GeneratorExitHandler` drops all buffered work on non-quota generator exit (buffer disposed via `removeSessionImmediate`). Buffered observations are **lost**, not delayed. (Mostly a v2/honest-tail concern — v1 doesn't seal — but don't write copy claiming pending observations "will land later.")
- Drain predicate, if you ever need it: `SessionMessageBuffer.getPendingCount(sessionDbId) === 0`.

**Privacy contract**
- `stripMemoryTags` must run on **every** rendered message. The verbatim transcript render path is the only path in the system that could bypass the `<private>` contract. This is a hard requirement, and there's a test for it.

**Hooks**
- Registered in `plugin/hooks/hooks.json`: Setup, SessionStart (`startup|clear|compact` — timeout 60, synchronous), UserPromptSubmit, PostToolUse (`*`, async, 120s), PreToolUse (Read), Stop (async, 120s). There is **no PreCompact hook** — and v1 deliberately doesn't add one.
- Hook handlers live in `src/cli/handlers/`, are pure (return `HookResult`, no stdout/process.exit), registered in `src/cli/handlers/index.ts`. Transport errors always exit 0 (never block Claude Code); only client bugs exit 2.
- **Stale doc warning:** `docs/architecture-overview.md` lists a `SessionEnd | session-complete` hook that does not exist in `hooks.json` or `handlers/index.ts`.

**Worker / HTTP conventions**
- New routes go in `SessionRoutes.setupRoutes()` (`src/services/worker/http/routes/SessionRoutes.ts`), wrapped with `this.wrapHandler()` from `BaseRouteHandler`, zod `validateBody`, deps via constructor DI (`this.sessionManager`, `this.dbManager`, ...).
- Fire-and-forget house pattern: `void (async () => { ... })()` (see `broadcastProcessingStatus`, `worker-service.ts`). But remember: from a hook process, un-awaited POSTs die at exit — hooks must await.

**Settings**
- Two separate settings systems. Feature flags go in **`SettingsDefaultsManager`** (`src/shared/SettingsDefaultsManager.ts`, ~100 `CLAUDE_MEM_*` keys, flat JSON at `~/.claude-mem/settings.json`, string `'true'`/`'false'`, read fresh per call via `loadFromFile(USER_SETTINGS_PATH)` — no restart needed). Adding one takes ~3 lines: interface key, DEFAULTS entry, read site. Do NOT touch `SettingsManager` (`src/services/worker/SettingsManager.ts`) — that's SQLite-backed UI viewer state only.

**The injection (spec §7 — two load-bearing details)**
- It's a **pointer** (~20 lines), not the bottle payload. The model reads the bottle via its own Read tool; the result lands as a tool result that the *next* compaction evicts first, so the bottle never accumulates across legs. Self-cleaning by design.
- The **"do not repeat"** line is load-bearing: without it, models reliably re-send their final assistant message or redo finished work. Keep it.

## Deliberately NOT building in v1 (spec §8 — scope guard)

PreCompact hook, seal/drain endpoint, `session_bottles` table, transcript byte cursor / render mutex, `tool_use_id` anchor columns / threading. All deferred to v2 with rationale in the spec. Double-fire of render-bottle is harmless (idempotent file, pointer injection), which is why no mutex is needed.

## Tests (spec §9 — 7 cases)

Compact mid-turn; `<private>` content stripped from bottle; degraded render (no transcript); worker-down fallback to timeline context; `/clear` archives the bottle; double-fire idempotency; end-to-end compact→inject→continue. Test layout: `bun test`, suites under `tests/` (`tests/sqlite/`, `tests/worker/`, etc.).

## Dev workflow

```bash
npm run typecheck        # tsc --noEmit (root + viewer)
bun test                 # or npm run test:sqlite / test:server etc.
npm run build            # sync manifests + build hooks + lockfile
npm run dev              # build + sync marketplace + restart live worker — touches the LIVE plugin; use deliberately
npm run worker:logs      # today's worker log
```

Note: `npm run dev` / `build-and-sync` restarts the **live** claude-mem worker on this machine (the one recording your own session). Prefer `typecheck` + `bun test` while iterating; sync to the live plugin only when you intend to dogfood.

## Where the history lives

All research is in claude-mem memory (project `context-mode`, Jul 16–17 2026). Key observation IDs if you need receipts: `102441` (rev 2 spec, code-verified, bug list), `102442`/`102443` (v1 plan + expansion), `102432`–`102439` (per-file code investigations: buffer, events, hooks, settings, ingestion path, generator exit, user_prompts, routes). Fetch via `get_observations([ids])` or the mem-search skill.
