# Endless Mode — Message in a Bottle

**Date:** 2026-07-16 (rev 2 — same day: all four §13 open questions resolved by code investigation; §4/§5/§6/§8/§9 corrected against the actual codebase)
**Status:** Draft spec, code-verified
**Feature name:** Endless Mode
**One-liner:** Sessions survive compaction (and `/clear`, crashes, restarts) by rendering a parallel transcript — verbatim conversation + observations in place of tool traffic — and pointing the post-compact model at it with a single instruction: *read the bottle and continue.*

---

## 1. Problem

Claude Code sessions don't die at the context limit — they get amnesia. Auto-compact replaces the conversation with a lossy, batch-generated summary written by a summarizer that doesn't know which details matter. The model loses its plan, its promises, its voice, and its knowledge of what was already tried. claude-mem's timeline injection at SessionStart partially recovers long-term memory, but nothing today recovers the *conversational position* — where the model actually was, mid-work, in its own words.

We do not rely on Claude Code's generated summary. We cannot suppress it (PreCompact hooks are observe-only), so we route around it and mark our injection as authoritative.

## 2. Core insight

A session transcript is 80–95% tool traffic by tokens. The conversation itself — user messages and assistant messages — is the thin, precious part. claude-mem **already compresses the tool traffic in real time**: that's what observations are. So a near-lossless, 10–20x smaller session record already exists in pieces, at generation time:

```
bottle = merge_by_position( transcript.jsonl , observations.db )
```

- **User messages** — verbatim, from the transcript (canonical source).
- **Assistant messages** — verbatim, from the transcript (complete and ordered; nothing else in the system persists them — see §10).
- **Tool uses + tool results** — *replaced* by the observations they produced, as one-line entries with IDs for lossless expansion via search/`get_observations`.

The bottle is a **derived view, not a maintained file**. Nothing new is captured; the real-time pipeline stays untouched. The file on disk is a render cache — regenerated whole, written atomically, never appended, never a source of truth.

### Why derive-not-maintain wins

1. **No dual-write drift.** A continuously-appended file is a second source of truth that diverges (missed hook, crashed append, torn line). A render is always consistent with the canonical sources at seal time.
2. **The async-observation ordering problem inverts.** Observations land seconds late relative to the conversation. Appending in real time means out-of-order entries or read-modify-write races across hook processes. Rendering looks *backwards at settled data* — a merge-sort by position — and the lag problem mostly evaporates (see §5 for the tail).
3. **Read-only on both sources.** Transcript file reads + WAL SQLite reads add zero write contention to the existing pipeline.
4. **Retroactive everything.** Format upgrades regenerate history. Any *past* session can be bottled — including sessions whose transcript Claude Code has already pruned (§10).

## 3. Architecture placement

Renders happen **worker-side** (the worker owns the DB, the SDK agent, and per-session state; hooks stay thin per the existing graceful-degradation contract). Hooks only trigger and inject.

```
PreCompact hook ──POST /api/sessions/seal──▶ Worker
                                               ├── bounded drain-wait on SessionMessageBuffer
                                               ├── render bottle (transcript + observations + buffer stubs)
                                               ├── write atomically to bottles dir
                                               └── arm injection marker (consumed_at=NULL)

SessionStart(compact|resume) hook ── claim marker ──▶ inject one-line pointer
SessionStart(clear)                ── archive bottle, no injection
SessionStart(startup)              ── existing behavior, unchanged
Stop hook                          ── await render-bottle queue-and-return (fire-and-forget effect)
```

New surface area (all locations verified against the codebase):

| Component | Change |
|---|---|
| `plugin` hooks | New PreCompact handler; SessionStart handler branches on `source`; one awaited call added to the summarize (Stop) handler |
| Plugin normalization | Thread `tool_use_id` through: `src/cli/types.ts` (`NormalizedHookInput`), `src/cli/adapters/claude-code.ts` (`normalizeInput` currently drops it), `src/cli/handlers/observation.ts` (POST body — the worker route already accepts `tool_use_id`, `SessionRoutes.ts:288-299`) |
| Worker HTTP | New `BottleRoutes` (`POST /api/sessions/seal`, `POST /api/sessions/render-bottle`, `GET /api/sessions/drain-status`) — `BaseRouteHandler` subclass, constructor-injected, zod-validated, registered in `worker-service.ts registerRoutes()` |
| `SessionMessageBuffer` | Emit `'mutate'` on `confirm()`/`clear()` (alongside existing `'message'` on enqueue); add `waitForDrain()` primitive (mirrors existing `waitForMessage()` `SessionMessageBuffer.ts:196-226`); add `peekStubs()` (richer `peekTypes`) |
| Worker services | New `BottleRenderer` (transcript parse + merge + markdown emit + `stripMemoryTags`), with a per-session render mutex (copy `ChromaSync.backfillInProgress` guard, `ChromaSync.ts:913-931`) |
| SQLite | New `session_bottles` table (injection markers + transcript byte cursors). **No changes to the observation path required for v1** (§5, §6) |
| Settings | Optional master gate `CLAUDE_MEM_ENDLESS_MODE_ENABLED` default `'true'` in `SettingsDefaultsManager` (interface + `DEFAULTS`), checked worker-side (§8) |

Everything else — SDK agent, ResponseProcessor, ChromaSync, timeline, search — untouched.

> **Stale-doc note:** `docs/architecture-overview.md` lists a `SessionEnd | session-complete` hook; it does not exist (no entry in `plugin/hooks/hooks.json`, no handler in `src/cli/handlers/index.ts`). The §8 session-end archive step is **new wiring**, not an extension — see §13 R5 for the decision.

## 4. Session identity

The bottle is keyed by **`contentSessionId`** (Claude Code's ID — invariant for the life of the session, delivered in every hook's stdin, and survives compaction).

**Corrected from rev 1:** there is no "gather across all memorySessionIds" problem. `sdk_sessions` holds one row per `(platform_source, content_session_id)`; on worker restart the *same row's* `memory_session_id` is UPDATEd in place (`SessionStore.updateMemorySessionId` :1475-1482), and both `observations` and `session_summaries` FKs are `ON UPDATE CASCADE` (migration v21, `SessionStore.ts:1040-1180`; `PRAGMA foreign_keys = ON` at `connection.ts:45`). All prior legs' observations cascade onto the current `memory_session_id` automatically. The render needs exactly one join:

```
contentSessionId → sdk_sessions row → memory_session_id → observations + session_summaries
```

**Community-edge caveat:** live DBs may carry `observations.content_session_id` from community migrations v36–38 that are *not in this repo* (gap acknowledged at `SessionStore.ts:447-451`), and it is only partially populated. Main-line code must always use the `sdk_sessions` join, never `observations.content_session_id`.

## 5. The un-observed tail (the hard part)

### The problem

At the moment PreCompact fires — usually **mid-turn**, since auto-compact triggers during long working turns — the newest tool events may not yet have observations. Observation count per response is variable *by design* (the agent decides what's worth observing — that variability is the product's magic and must not be constrained). So completeness can never be established by counting observations against tool calls.

### The resolution: coverage, not count

We never need to know "how many observations should exist." We need to know **what input has been fully processed**. That is a drain question, and the machinery already exists — with two corrections from rev 1, both verified in code:

> **Corrections:** (1) `clearPendingForSession` is dead code — zero call sites (`SessionManager.ts:207-209` exists but is never invoked). The actual completion signal is **`confirmClaimedMessages`** (`SessionManager.ts:219-231`), called by `ResponseProcessor.ts:210` *after* `storeObservations()` commits (:126), and at :87 for the prose/no-op path. (2) The pending queue is **in-RAM** — `SessionMessageBuffer` explicitly replaced the durable `pending_messages` SQLite table (doc comment `SessionMessageBuffer.ts:21-41`: *"If the worker dies, the buffer is gone and recovery is a transcript replay"*). The table survives only as migration/cleanup residue. Rev 1's claim that "pending rows persist across worker restarts" is false; the honest-tail machinery below is designed around that.

**The drained predicate is one number.** `claimNext()` only marks messages `claimed: true` (`SessionMessageBuffer.ts:186-194`); only `confirm()` removes them (:74-84). A batch stays in the buffer for the entire time the SDK is generating a response for it. Therefore:

```
buffer.getPendingCount(sessionDbId) === 0  ⟺  queue empty AND no batch in flight
```

No separate "generating" boolean is needed for the drain test. (For `drain-status` reporting, `generating` = `session.claimedMessageIds.length > 0` or `session.generatorPromise !== null`, `worker-types.ts:17,23`.)

### The seal operation

```
POST /api/sessions/seal   { contentSessionId, transcriptPath, timeoutMs? }   // default 20_000, max 60_000
```

Worker behavior (see §13 R2 for the full investigation):

1. Resolve `sessionDbId` via `createSDKSession` upsert (house pattern, `SessionRoutes.ts:358`).
2. `buffer.waitForDrain(sessionDbId, deadline, generatorDead)` — **hybrid wait**: wake on the buffer's per-session `EventEmitter` (`'mutate'` emitted on `confirm`/`clear`), recheck the predicate on every wake, with a 250ms safety tick and hard deadline. Pure event-wait is unsafe because **generator death mutates no buffer state**; pure polling wastes the instant-wake the existing emitter infrastructure gives for free.
3. **Never interrupt or force a generation.** In particular, do *not* call `ensureGeneratorRunning` from seal during a quota pause — the provider is rate-limited and a forced start burns budget on a doomed generation.
4. Generator-dead detection: `session && session.generatorPromise === null && pendingCount > 0` — the durable form of this state is the **quota pause** (`GeneratorExitHandler.ts:28-65`: quota exit preserves session + buffer with `generatorPromise = null`; every other exit finalizes and disposes the buffer entirely). Because `ingestObservation` enqueues *before* `ensureGeneratorRunning` (`http/shared.ts:121,138`), the condition is transiently true on every fresh enqueue — require it to hold across **two consecutive wakes (~500ms grace)** before returning early.
5. On drain → render, return `{ sealed: true, gap: 0 }`. On timeout or generator-dead → render with honest tail, return `{ sealed: true, gap: pendingCount }`.

### The honest tail — two sources, because the buffer is RAM

**Within a worker lifetime** the buffer itself provides the stubs: every queued *and in-flight* message retains `tool_name`, full JSON-parseable `tool_input` (`stripMemoryTags(JSON.stringify(toolInput))`, `http/shared.ts:114-116`), `enqueuedAt`, and `toolUseId` (`worker-types.ts:63-74`, `SessionMessageBuffer.ts:7-12`). The only missing piece is a read surface: add `peekStubs(sessionDbId)` returning `{message_type, tool_name, tool_input, enqueuedAt, toolUseId, claimed}` (~10 lines; current `peekTypes` :138-143 projects only `{message_type, tool_name}`). **No schema change, no migration.** Brief-slice derivation happens at render time from the parsed input: Bash→`command`, Edit/Write/Read→`file_path`, Grep→`pattern`, else first key; skip `summarize`-type messages (no tool fields).

**Across a worker restart** the buffer is gone and the queue-derived gap is unknowable. The renderer therefore *also* derives the tail from the transcript: tool_use entries newer than the newest observation's anchor position render as stubs. Queue-based gap is authoritative within one worker lifetime; transcript-based comparison is the floor that always works.

Rendered form:

```markdown
*Recent activity (observations pending — will appear in the timeline shortly):*
- ⏳ Bash — `npm test` (14:32:11)
- ⏳ Edit — src/services/worker/SessionManager.ts (14:32:40)
```

Three reasons this gap is acceptable *by construction*:

1. The verbatim final assistant message(s) cover the tail narrative — the model itself just described what it was doing.
2. Recovery for lost buffered work is **transcript replay** (the buffer's own documented contract) — the observations are regenerated, not lost.
3. The bottle is a derived view — the **next render heals the gap automatically** (render-on-Stop, §8).

The seal never blocks compaction and never blocks the user: on any worker failure the hook follows the existing contract (transport errors → exit 0) and the injection falls back to the current timeline-only context block. Endless Mode degrades to today's behavior, never below it.

## 6. Interleaving: anchoring observations to transcript position

For chronological merge, observations need a *source position*, not just a generation timestamp.

**Status (verified): the anchor is already half-shipped.** Drain yields `_originalTimestamp = enqueuedAt` (`SessionMessageBuffer.ts:160-164`); `SessionManager` tracks the batch minimum as `earliestPendingTimestamp` (:362-367); `ClaudeProvider.ts:355` passes it as `originalTimestamp`; `ResponseProcessor.ts:126-135` passes it to `storeObservations` as `overrideTimestampEpoch` → stored as `observations.created_at_epoch` (`SessionStore.ts:2088-2100`). Stored observations are **already stamped with batch-min tool time, not generation time.**

Remaining work, split in two:

1. **v1, plugin-side, no migration:** thread `tool_use_id` through the Claude Code hook path — it arrives in hook stdin (`PostToolUseHookInput.tool_use_id`, SDK types) but `claude-code.ts normalizeInput` (:15-25) drops it. Add `toolUseId?` to `NormalizedHookInput` (`src/cli/types.ts`), map it in the adapter, include it in the observation POST body (`observation.ts:18-31`) — the worker route already accepts and forwards it (`SessionRoutes.ts:288-299,308-332`; the transcript-replay path already sends it, `transcripts/processor.ts:205,233,254`). Optionally also send `occurred_at_epoch: Date.now()` from the hook so the anchor is tool-completion time rather than worker-receipt time. Backward-compat is trivial in both skew directions: the route schema is `.passthrough()` with optional fields.
2. **v2, separate change:** per-observation anchor columns (`anchor_ts_min/max`, `tool_use_id`) on `observations` — requires a nullable-column migration plus `ResponseProcessor`/`storeObservations` signature changes. Not needed for v1 rendering.

**Positioning fallback that costs nothing:** both `observations` and `user_prompts` carry **`prompt_number`**. Grouping observations under their prompt number (ordered by `created_at_epoch` within the group) gives *exact* conversational positioning with no transcript and no new columns — this is also what makes degraded bottles (§10) properly ordered. Batch-range precision within a turn is inherently approximate (the SDK agent writes free-form against batches); the bottle needs chronologically plausible placement, not exact causality.

## 7. The bottle: format and render

### Location

```
~/.claude-mem/bottles/<contentSessionId>.md        # active
~/.claude-mem/bottles/archive/<ts>-<id>.md          # archived on /clear or session end
```

Per-session filename — concurrent sessions in one project must not share a file.

### Write discipline

Rendered whole, written to a temp sibling, `rename()`d over the target (atomic on POSIX; precedent: `src/shared/atomic-json.ts:50,100`). Never appended. **Per-session render mutex** (copy the `ChromaSync.backfillInProgress` static-guard pattern, `ChromaSync.ts:913-931`): a Stop-render and a seal-render for the same session must not interleave — without the mutex, two concurrent renders are last-writer-wins with different cursors.

The renderer keeps a per-session **byte-offset cursor** into the transcript (`session_bottles.transcript_cursor`) so routine re-renders parse only new bytes — precedent is working code: `JsonlTailer` (`src/services/transcripts/watcher.ts:10-72`, offset high-water mark with truncation reset). Two honest caveats from investigation:

- The cursor makes the *parse* incremental, not the *write* — every render rewrites the whole bottle and re-queries the session's observations. Bottles are 10–20x smaller than transcripts, so this is milliseconds; just don't credit the cursor for the write side.
- "Rendered whole" + "parse only new bytes" coexist only if parsed message structs up to the cursor are kept per session. v1 decision: **don't** keep them — accept a full re-parse from byte 0 on heal renders and after worker restart (bounded, and today's Stop hook already `readFileSync`s the entire transcript on every Stop, `transcript-parser.ts:15` — full-file I/O per Stop is established practice).

### Privacy — hard requirement

**Every rendered user and assistant message MUST pass through `stripMemoryTags`** (`src/utils/tag-stripping.ts:4-17` — strips `<private>`, `<claude-mem-context>`, `<system-reminder>`, …). Everything claude-mem persists today honors this contract (prompt storage `SessionRoutes.ts:444-461` including the entirely-private skip; summarize path `summarize.ts:85,94`); a verbatim transcript render is the one new path that would bypass it. The filter lives in `BottleRenderer` so it applies identically to seal-time, Stop-time, and on-demand renders. Beyond tag-stripping, the bottle is a *filtered subset* (text blocks only) of a transcript that already exists in plaintext on the same disk — no new data class (`docs/ip-boundary.md` is licensing-scope only; no data-at-rest encryption commitment exists to violate).

### Transcript parsing rules

- Parse complete JSONL lines only; a torn final line (Claude Code appends live) is skipped and picked up next render.
- From assistant entries: extract **text blocks only** — skip `tool_use`, `tool_result`, and thinking blocks.
- From user entries: genuine user messages only — skip tool results and host-injected envelopes (`<system-reminder>`, `<task-notification>`, `<context_guidance>`, `<tool-result>`, command wrappers), mirroring the existing prompt-capture filter.
- Sidechain/subagent entries: excluded in v1.

### Format

```markdown
# Session bottle — <contentSessionId>
project: <cwd> · started: <ts> · legs: <compact_count + 1> · rendered: <ts>
mode: full (transcript + observations)

## Original request
<first genuine user prompt, verbatim>

---

**User** (10:32)
<verbatim>

*What happened:*
- [#102401] Explored hooks/ — every platform hook wraps 5 shared cores
- [#102402] Read start.mjs — 6 self-heal layers before MCP boot
- ⏳ Bash — `npm test` (observation pending)

**Assistant** (10:41)
<verbatim>

---
**User** (10:44)
...
```

Rules:

- Observation lines are one-liners: `[#id] title — first clause of narrative`. The ID makes every line losslessly expandable via search tools. Never inline full narratives.
- Assistant/user messages: verbatim, full length, no truncation. (Compaction just freed hundreds of thousands of tokens; a faithful anchor costing a few thousand is the point, not a problem.)
- The `mode:` header line is load-bearing — degraded bottles (§10) declare themselves.
- `session_summaries` content may appear **only** as a visibly-generated block (`> Session summary (generated by claude-mem — not verbatim)`), never in an `**Assistant**` speaker slot (§10 provenance rules).

## 8. Hook wiring

### PreCompact (new handler)

Input: stdin `{ session_id, transcript_path, cwd, trigger, custom_instructions }`.

1. `POST /api/sessions/seal { contentSessionId, transcriptPath, timeoutMs: 20_000 }`.
2. On success: worker has written the bottle and armed the injection marker (`session_bottles`: `content_session_id, bottle_path, armed=1, consumed_at=NULL, gap`).
3. On any failure: log, exit 0. Never block compaction.

### SessionStart (extend existing handler — branch on `source`)

- **`compact` / `resume`:** atomically claim the marker —

  ```sql
  UPDATE session_bottles SET consumed_at = ?
  WHERE content_session_id = ? AND armed = 1 AND consumed_at IS NULL
  RETURNING bottle_path, gap;
  ```

  SessionStart can double-fire around a compact; the atomic claim guarantees exactly-once injection. On a claimed row, inject the pointer (§9). On no row (compact happened with worker down, or resume of an old session): request a **synchronous** render (`POST /render-bottle { wait: true }` — the fire-and-forget default won't do; the file must exist before the pointer is injected), which internally walks the degradation ladder (§10); if even that fails, inject the existing timeline context (today's behavior).
- **`clear`:** archive the bottle (timestamped move), inject nothing. `/clear` means forget.
- **`startup`:** existing behavior, unchanged.

### Stop (render-on-Stop — default-on, resolved §13 R3)

Hook-in point: `src/cli/handlers/summarize.ts`, immediately after the `isWorkerFallback(queueResult)` check (:147-149), before the return:

```ts
try {
  await executeWithWorkerFallback('/api/sessions/render-bottle', 'POST',
    { contentSessionId: sessionId, transcript_path: transcriptPath, platformSource },
    { timeoutMs: 5000 });
} catch { /* render failure must never escalate to BLOCKING_ERROR */ }
```

- **Await it.** Hook processes `process.exit` and kill un-awaited POSTs mid-flight (`hook-command.ts:144-156`, `worker-utils.ts:648`) — house style for fire-and-forget from a hook is *await a queue-and-return route*. The worker responds `{status:'queued'}` immediately (copy `handleSummarizeByClaudeId`'s shape, `SessionRoutes.ts:347-383`) and renders async with `.catch(logger.error(..., '(non-blocking)'))` (precedent `worker-service.ts:594-606`), under the per-session mutex.
- Skip when `transcriptPath` is undefined (the `input.lastAssistantMessage` branch, `summarize.ts:84-85`).
- Known limitation: the summarize handler's server-runtime branch returns early (:118-136), so as drafted render-on-Stop fires only on the worker runtime.
- Cost context: the Stop hook is registered `async: true, timeout: 120` (`plugin/hooks/hooks.json`) — invisible to the user — and already reads the entire transcript synchronously every Stop. One extra localhost queue-and-return call is negligible next to the LLM summarize generation the same Stop already triggers.
- Why default-on and not a setting: house precedent defaults cheap, local, own-data-dir features to `'true'` (`CLAUDE_MEM_TRANSCRIPTS_ENABLED`, `CLAUDE_MEM_CHROMA_ENABLED`, …; `'false'` is reserved for experimental injection or user-repo writes, `SettingsDefaultsManager.ts:99-186`); a render-on-Stop toggle wouldn't protect anything (seal-time renders write the same file); and render-on-Stop is the stub-tail **healing pass** — gating it off silently degrades sealed-bottle quality. If a kill-switch is wanted, make it the Endless Mode master gate: `CLAUDE_MEM_ENDLESS_MODE_ENABLED: 'true'`, checked worker-side (hooks resolve settings from env+defaults only; the worker is where `loadFromFile` honors `~/.claude-mem/settings.json`).

### Session end

No SessionEnd hook currently exists (see §3 note). v1: archive bottles lazily — a startup-branch sweep moves bottles whose sessions are no longer live. Adding a real SessionEnd hook is §13 R5's open decision.

## 9. The injection

Exactly one block, small, and framed as authoritative:

```
# [claude-mem] Endless Mode — session continuation

Before doing anything else, Read this file and continue the session from
where it ends:

    <absolute bottle path>

(Page with offset/limit if it is long — read the tail first if you must
prioritize.)

- It is the authoritative session record: verbatim conversation, with
  observations in place of tool activity. Where it conflicts with the
  system-generated summary above, the bottle wins.
- The final assistant message in it was already delivered to the user.
  Do not repeat it or redo work it describes as done — continue from its
  end state.
<if gap > 0>
- The last <N> tool events have observations still being written; they
  will appear in the timeline shortly.
</if>

Current task: <one-line, from latest session summary or last user prompt>
```

**Degraded-mode variant (§10):** the "authoritative verbatim conversation" and "do not repeat your final message" lines are *false* for a reconstructed bottle and must be swapped:

```
- It is a partial reconstruction: your messages to the user were not
  preserved — only the user's messages are verbatim. Session summary
  blocks are generated, not your words. Do not assume prior phrasings.
- The last session summary describes where you left off; continue from
  there.
```

Design notes:

- **Pointer, not payload.** ~20 lines injected; the model pulls the bottle through a Read, which enters context as a tool result — exactly what the *next* compaction drops first. The bottle never accumulates across legs; each leg re-reads fresh. Self-cleaning.
- The two-line stub (current task + original-goal framing) is deliberate insurance: even a leg that skips the Read isn't fully lost.
- The don't-repeat line is load-bearing in full mode. Without it, the model reliably re-emits its final message or redoes finished work.

## 10. Degraded bottles: resuming sessions whose transcript is gone

**The premise is empirically real** (measured on a live install): 97.6% of stored sessions (5,278/5,407) are older than the oldest surviving transcript (~30 days — consistent with Claude Code's documented `cleanupPeriodDays` default of 30; assumption, not found in-repo). Of those old sessions, **4,361 have ≥1 stored user prompt, 2,358 have ≥1 observation, 1,492 have ≥1 session summary.** Timeline injection cannot reconstruct any specific old session; a degraded bottle can.

### What survives without the transcript (verified schemas)

| Source | Recoverable | Caveats |
|---|---|---|
| `user_prompts` (`SessionStore.ts:330-339`) | **User messages, verbatim**, keyed by `content_session_id`, numbered (`prompt_number`), timestamped | 4,000-char cap (`prompt-storage.ts:4-21`, ~3.5% of prompts truncated with trailing `…`); memory tags stripped; fully-private prompts skipped; dedupe window |
| `observations` | Full richness: type, title, subtitle, narrative, facts, concepts, files_read/modified, `prompt_number` | Timestamps are batch-anchored or generation-time; position by `prompt_number` (exact), show coarse times only |
| `session_summaries` (`SessionStore.ts:614-629`) | `request / investigated / learned / completed / next_steps / notes` — the only assistant-perspective narrative that survives | **LLM-generated, not verbatim** — provenance rules below |
| `sdk_sessions` | project, first prompt, custom_title, started_at | — |
| Assistant messages | **Not recoverable, anywhere.** Nothing persists assistant output raw; `pending_messages.last_assistant_message` rows are deleted after processing | Permanently lost with the transcript |

### Degradation ladder

1. **Full bottle** — transcript exists: §7 as written.
2. **Degraded bottle** — transcript gone, session row has ≥1 prompt or observation: render per `prompt_number`: `**User** (verbatim) → *What happened* (observations) → > Session summary (generated)`. Same file format, same injection pointer, `mode: reconstructed` header.
3. **Timeline injection** — no session row, or zero prompts and zero observations: today's behavior.

**Detection:** hooks pass `transcript_path` when they have it → `existsSync`. `transcript_path` is not persisted in any table (arrives in hook stdin, dies with the hook), so for the CLI path (`npx claude-mem bottle <contentSessionId>`) glob `CLAUDE_CONFIG_DIR/projects/*/<contentSessionId>.jsonl` — Claude Code names transcripts by contentSessionId; the convention is already codified at `ObservationCompiler.ts:199`. Miss → check `sdk_sessions` + prompt/observation counts → degraded vs timeline.

### Provenance rules (what would mislead without them)

1. **Summaries never speak as the Assistant.** `request/learned/completed` prose reads exactly like assistant voice; rendered in an `**Assistant**` slot, the post-resume model will "remember saying" things it never said. Always the quoted generated-block form.
2. **The header declares the mode**: `mode: reconstructed (transcript unavailable) — user messages verbatim; assistant messages not preserved; summaries are generated`.
3. **Truncated prompts** get an explicit `[truncated at 4000 chars]` marker so the stored `…` isn't read as the user trailing off.
4. **Missing turns are invisible** (privacy-skipped prompts, zero-observation prompts leave no trace) — the injection's degraded variant (§9) accounts for this by pointing at the last session summary rather than a final message.

## 11. Failure posture

Inherits the existing contract wholesale:

- Worker unreachable at PreCompact → exit 0; next SessionStart attempts synchronous render-on-demand, then falls back to timeline-only injection. Endless Mode silently degrades to current behavior.
- Worker restart mid-seal-wait: `Server.close()` calls `closeAllConnections()` first (`Server.ts:159-178`) — the in-flight seal request is severed, the hook sees a transport error, exits 0. Buffered work dies with the process (in-RAM by design); recovery is transcript replay; the transcript-side stub derivation (§5) reports the gap honestly on the next render.
- Render throws mid-way → temp file discarded; previous bottle (if any) remains intact (atomic rename discipline).
- Transport errors exit 0; client bugs exit 2 — unchanged.
- The seal's drain wait never interrupts an in-flight SDK generation, never force-starts a quota-paused generator, and never exceeds its budget.

## 12. Test plan

1. **Mid-turn compact:** synthesize a transcript whose tail is an unfinished turn (assistant text + tool_use, no Stop); seal; assert verbatim tail text present and buffer-derived stubs rendered.
2. **Drain race:** enqueue N buffered messages, fire seal with a generation in flight; assert seal wakes on `confirm()` and renders gap=0 within budget. Repeat with a quota-paused session (`generatorPromise === null`, count > 0); assert early return with gap>0 after the two-wake grace, not after the full timeout — and assert the seal did **not** call `ensureGeneratorRunning`.
3. **Fresh-enqueue false positive:** fire seal immediately after an enqueue (before `ensureGeneratorRunning` runs); assert the two-wake grace prevents a spurious generator-dead verdict.
4. **Double SessionStart:** fire two compact-source SessionStarts concurrently; assert exactly one injection (atomic claim).
5. **Worker restart mid-session:** restart the worker (memory_session_id UPDATEd in place); assert the bottle still contains all prior-leg observations via the single join (cascade).
6. **Worker down at PreCompact:** assert exit 0, and next SessionStart's synchronous render-on-demand path (or timeline fallback) fires.
7. **Render mutex:** trigger Stop-render and seal-render concurrently for one session; assert serialized execution, no torn/last-writer-wins cursor state.
8. **stripMemoryTags:** transcript containing `<private>` blocks in user and assistant messages; assert the bottle contains none of the private content on all three render paths (seal, Stop, on-demand).
9. **Torn JSONL line:** truncate the transcript mid-line; assert parser skips it and the cursor picks it up on the next render.
10. **`/clear`:** assert archive + no injection.
11. **Degraded bottle:** delete the transcript for a session with prompts + observations + summaries; assert `mode: reconstructed` header, `prompt_number` interleaving, summaries in generated-block form (never `**Assistant**`), truncation markers, and the degraded injection variant.
12. **Marathon transcript:** 50MB+ transcript; assert incremental cursor keeps routine re-render fast; assert heal/restart re-parse from zero stays bounded.
13. **Behavioral (manual/e2e):** drive a session past auto-compact and verify the model reads the bottle and continues without repeating its final message.

## 13. Resolved questions (2026-07-16 code investigation)

Four parallel investigations against the live codebase resolved rev 1's open questions:

**R1 — Honest-tail stubs: no schema change needed.** The in-RAM buffer already retains `tool_name`, fully parseable JSON `tool_input`, `enqueuedAt`, and `toolUseId` for queued *and* in-flight messages; only a read surface (`peekStubs()`, ~10 lines in `SessionMessageBuffer`) is missing. Companion plugin-side fix: the Claude Code adapter drops `tool_use_id` on the floor (`claude-code.ts:15-25`) while the worker route already accepts it — thread it through 3 files (`types.ts`, adapter, `observation.ts`). Per-observation anchor *columns* are a separate v2 migration; the batch-min anchor already ships (§6).

**R2 — Seal wait: hybrid event + poll, on corrected foundations.** `clearPendingForSession` is dead code; the real signal is `confirmClaimedMessages` post-`storeObservations`. Drain predicate = `getPendingCount() === 0` (claimed batches stay counted until confirmed). No internal event bus exists (SSE is outbound-only; the one `onPendingMutate` slot is taken by worker-service) — but the buffer's per-session `EventEmitter`s and the `waitForMessage` pattern are the right layer: emit `'mutate'` on confirm/clear, add `waitForDrain` with a 250ms tick (which also catches generator death, which mutates no buffer state) and a two-wake grace for the enqueue-before-ensureGenerator race. Quota pause is the durable generator-dead-with-work state; never force-start it from seal.

**R3 — Render-on-Stop: default-on, no dedicated setting.** The Stop hook is `async: true`/120s and already reads the whole transcript every Stop; the render adds one awaited localhost queue-and-return call (un-awaited POSTs die at `process.exit` — house rule). House precedent defaults cheap local features to `'true'`; a toggle wouldn't protect anything (seal renders the same file); and render-on-Stop is the healing pass for sealed-bottle stubs. Optional master gate: `CLAUDE_MEM_ENDLESS_MODE_ENABLED` in `SettingsDefaultsManager`, enforced worker-side. **New hard requirement discovered:** `BottleRenderer` must apply `stripMemoryTags` to every rendered message — the verbatim render is the one path that would otherwise bypass the `<private>` contract every other persistence path honors.

**R4 — Old sessions: degraded bottle, decisively better than timeline fallback.** Verbatim user prompts survive in `user_prompts` (keyed by contentSessionId, `prompt_number`-ordered, 4,000-char cap); observations survive with `prompt_number` giving exact interleaving; `session_summaries` provides the only (generated) assistant-perspective narrative; verbatim assistant messages are unrecoverable. Ladder: full → reconstructed → timeline, with mandatory provenance marking (mode header, generated-block summaries, truncation markers, degraded injection variant). Also corrected §4: the memorySessionId cascade means one join, not a multi-ID gather.

**R5 — Remaining open decisions (small):**
1. Add a real SessionEnd hook for bottle archiving, or ship the lazy startup-sweep only? (Lazy sweep is sufficient for v1.)
2. When to ship the v2 `observations` anchor-column migration (`anchor_ts_min/max`, `tool_use_id`) — bundle with the next schema bump rather than standalone.
3. Whether `occurred_at_epoch` from the hook (tool-completion time vs worker-receipt time) is worth the extra field in v1 — recommend yes, it's one line at each layer.
4. Server-runtime parity: the summarize handler's server branch returns early, so render-on-Stop is worker-runtime-only as drafted — acceptable for v1, revisit with server-parity work.
