# 06 — Execution Plan: Redo Onto Latest Main

> Orchestration plan for re-applying the 5 redo-plan features. **Each feature ships as its own PR on its own branch off `origin/main`** (v12.6.0 or newer at execution time). No single mega-branch.
>
> Read this together with: `00-handoff.md`, `01-layer3-transcripts.md`, `02-titans-observer.md`, `03-observation-source-metadata.md`, `04-viewer-ui-source-metadata.md`, `05-fifo-confirm-processed.md`.
>
> **Order:** TITANS minimal → Layer 3 → metadata data → metadata UI → logger mirror. PR 4 (UI) depends on PR 3 (data layer). All others are independent.
>
> **Each PR follows the same template** (Phase 0 below). The phases in this doc are PRs.

---

## Decisions

| # | Question | Resolution |
| - | -------- | ---------- |
| D1 | Branch naming | One branch per PR, off latest `origin/main`. Proposed names per phase below. |
| D2 | PR order | TITANS minimal (P1) → Layer 3 (P2) → metadata data (P3) → metadata UI (P4, depends on P3) → logger mirror (P5). Independent PRs can land in any order; UI must wait for data. |
| D3 | FIFO disposition | **Drop FIFO tracker AND skip the `a0899529` cherry-pick.** Salvage only `CLAUDE_MEM_LOG_TO_STDOUT`. See Phase 5 for rationale. |
| D4 | Re-introduce `generatedByModel` storeObservation param | Defer (skip in P3; separate concern per doc 03 §7) |
| D5 | Stash@{0} (wall-clock guard, HUMAN.md, pathfinder/) | Out of scope; revisit separately |

**Proposed branch names** (confirm before each PR):

| PR | Feature | Proposed branch |
| -- | ------- | --------------- |
| P1 | TITANS expanded mode (minimal) | `thedotmack/titans-expanded-mode` |
| P2 | Layer 3 transcripts | `thedotmack/layer3-transcripts` |
| P3 | Observation source metadata (data) | `thedotmack/observation-metadata` |
| P4 | Viewer UI source metadata | `thedotmack/viewer-metadata-ui` |
| P5 | Logger stdout mirror | `thedotmack/log-to-stdout` |

---

## Phase 0: Per-PR branch setup template

**Apply this template at the start of every PR (P1–P5). Each PR is a fresh branch off latest `origin/main`.**

### What to do

1. **Stash or commit any in-progress work on the current branch first.** Each PR starts from a clean tree off main.
2. **Create the branch off latest main.**
   ```bash
   git fetch origin
   git switch -c <branch-name> origin/main
   ```
3. **Carry forward `redo-plan/`** (currently untracked on `thedotmack/merged-layer3-metadata`) into the **first** PR only as a docs commit (`docs: add redo-plan handoff package`). Subsequent PRs branch off main, which won't have `redo-plan/` until P1 lands and merges; that's fine — the docs are reference material, not a runtime dependency.
4. **Verify the v12.5.0 → v12.6.0 (or newer) delta does not invalidate the per-feature doc for this PR.** Per-feature docs assume v12.5.0; main is now v12.6.0, with PR #2282 ("bug-batch — 17 issues + 4 foundations: chroma, opencode, parser, OAuth, paths, uptime, classification") landed between them. Spot-check via:
   ```bash
   git log v12.5.0..origin/main --oneline -- \
     src/services/sync/ChromaSync.ts \
     src/services/worker/DatabaseManager.ts \
     src/services/transcripts/processor.ts \
     src/services/transcripts/watcher.ts \
     src/services/worker/http/routes/SessionRoutes.ts \
     src/servers/mcp-server.ts \
     src/services/sqlite/migrations/runner.ts \
     src/services/sqlite/observations/ \
     src/services/worker/agents/ResponseProcessor.ts \
     src/services/worker/SessionManager.ts \
     src/services/worker/PendingMessageStore.ts \
     src/sdk/prompts.ts \
     src/ui/viewer/components/ObservationCard.tsx \
     plugin/modes/code.json
   ```
   For each touched file, re-read the corresponding "Overlap / conflict notes" table in 01–05 and confirm the line numbers / shapes still match. **Anything that drifted beyond minor line-number shift becomes an issue to surface before its phase begins.**
4. **Verify migration high-water mark.** `runner.ts` numbering — handoff says main is at 31; v12.6.0 may have added more.
   ```bash
   grep -E "^\s*(version|number|id)\s*[:=]\s*[0-9]+" src/services/sqlite/migrations/runner.ts | tail -20
   ```
   The next free number replaces every "32" reference in the per-feature docs.
5. **Verify `user_prompts(content_session_id, prompt_number)` UNIQUE constraint.** Doc 01 §7 ("Skip" bullet) calls this out as a verify-before-Layer-3 dep. Grep:
   ```bash
   grep -n "user_prompts" src/services/sqlite/migrations/runner.ts
   ```
6. **Verify provider rename status.** Doc 02 §8 says PR #2255 renamed `SDKAgent.ts → ClaudeProvider.ts`, etc. Confirm files exist at the new names on v12.6.0:
   ```bash
   ls src/services/worker/{ClaudeProvider,GeminiProvider,OpenRouterProvider}.ts
   ```
   Under the corrected TITANS design (handoff §"TITANS corrections"), no provider files are touched, so the rename is informational only.

### Verification checklist for Phase 0

- [ ] Branch created off `43037782` (or whatever HEAD of `origin/main` is at execution time).
- [ ] `redo-plan/` committed as docs-only commit 1.
- [ ] Delta diff above produces no surprises that contradict 01–05 conflict tables. Any surprise → write a one-line addendum to the affected doc; do not silently absorb.
- [ ] Next free migration number recorded; per-feature docs mentally re-mapped from "32" to that number.
- [ ] `user_prompts` UNIQUE-constraint status determined: present (proceed), or absent (becomes Phase 2's commit 2.0).
- [ ] All 5 decisions D1–D5 confirmed in writing before Phase 1 starts.

### Anti-pattern guards

- ✗ Do **not** start from `thedotmack/merged-layer3-metadata` and try to "clean up." This is a fresh branch off `origin/main`. The old branch stays as a reference.
- ✗ Do **not** skip the v12.5.0→v12.6.0 delta check. The redo docs predate v12.6.0 and are wrong by definition until proven right.
- ✗ Do **not** auto-renumber migrations during the diff check; just record the new high-water mark and apply it consistently in Phase 2 / Phase 3 if those phases turn out to need migrations.

---

## Phase 1: TITANS expanded mode (minimal)

Per **handoff §"TITANS corrections"**. Only two changes; no new pipeline plumbing.

### Sub-commit 1.1 — sibling mode file `code-test.json`

**What to copy:**
- Copy `plugin/modes/code.json` → `plugin/modes/code-test.json` byte-for-byte first, then make these **additive-only** edits:
  - Append to `observation_types[]`: `correction`, `frustration`, `overconfidence`, `commitment`, `pattern_recognition`, `emotional_signal`, `insight` (intersect with whatever main's `code.json` already has — only add the missing ones; full canonical list is in `02-titans-observer.md` §2 table).
  - Append **one** line to `recording_focus` along the lines of: `"Also worth flagging: corrections from the user, moments of frustration, overconfident claims."` Verbatim wording can iterate; structure must be additive.
- **Do not rewrite** `observer_role`, existing `recording_focus` body, or any other field. Additions only.

**Where the prompt assembly reads modes:** `src/sdk/prompts.ts` (and wherever `code.json` is loaded). Confirm that loading `code-test.json` works as a drop-in alternative without any code change — if there's a hard-coded `code.json` filename in the loader, that's a 1-line tweak (separate sub-commit if non-trivial).

**Verification:**
- `node -e "JSON.parse(require('fs').readFileSync('plugin/modes/code-test.json','utf8'))"` parses cleanly.
- Diff `code.json` ↔ `code-test.json` shows only additions (no edits, no deletions).
- Loading mode = `code-test` in a dev session produces an observer prompt that includes the new types in the type list.

**Anti-pattern guards:**
- ✗ No new "watching the developer AND the assistant" framing in `observer_role`. Handoff is explicit.
- ✗ No new HTTP endpoint, no `PendingMessage` type, no migration, no `queueConversation`, no provider dispatch branch, no `OneShotQuery`, no fire-and-forget HTTP call. Handoff §"Explicitly do not build" lists all seven.
- ✗ Do not promote `code-test.json` content into `code.json` in this commit. Promotion happens later, after signal validation.

### Sub-commit 1.2 — accumulate the full assistant turn into the observer prompt

**Premise (from handoff §"TITANS corrections" item 2, refined):** the observer needs to see **every** assistant message from the current turn, not just the most recent one. Between user turns the assistant typically streams multiple messages (text → tool call → more text → tool call → more text). Overconfidence/correction signals can occur anywhere in that sequence — flagging only the last message misses signals from earlier in the same turn.

Main currently captures only `lastAssistantMessage` (singular) into session state, consumed by `buildSummaryPrompt`. That's the wrong shape for this feature.

**What to find:**
- Where `lastAssistantMessage` is written in the transcript watcher — same hook gets the new accumulator append.
- The `user_message` handler in the same watcher — that's where the accumulator resets.
- Where `buildSummaryPrompt` reads session state — reference for the *access* pattern (not the *data*).
- Where the observer prompt is built per tool use — the destination.

**What to change:**
- Add a new field on session state (e.g. `assistantTurnMessages: string[]`) — name to match local conventions.
- In the watcher, append to the new field on `assistant_message`, reset to `[]` on `user_message`. Keep the existing `lastAssistantMessage` write intact — `buildSummaryPrompt` still consumes it.
- In the observer prompt builder, read the accumulator and render it as a "transcript so far" block (chronological order). Iterate the wording; structure first.

**Verification:**
- `npm run build` clean.
- Docker dev container with mode=`code-test`. Drive an assistant turn that emits multiple text messages before a tool call (e.g., "I'll do X" → "let me first check Y" → tool call). Inspect worker.log:
  - Observer prompt for that tool call contains **both** assistant messages, in order.
  - After a `user_message`, the next observer prompt does **not** contain prior-turn text.
- TITANS-typed observations begin appearing in `observations` rows when the conversation contains a `correction` / `frustration` / `overconfidence` signal.

**Anti-pattern guards:**
- ✗ Do not add a new event type to the watcher. `assistant_message` and `user_message` already exist.
- ✗ Do not introduce a separate observation pipeline, endpoint, or PendingMessage type. Same per-tool-use trigger, same prompt mechanism, same result handling.
- ✗ Do not port the branch's `ConversationExchange[]` accumulator. That shape was wired for the dropped conversation-observation pipeline; this accumulator feeds the existing observer's prompt only.
- ✗ Do not remove or reshape `lastAssistantMessage` — it's load-bearing for `buildSummaryPrompt`.

---

## Phase 2: Layer 3 transcripts (per doc 01)

Per `01-layer3-transcripts.md` §7. Five sub-commits, additive throughout.

### Pre-commit (only if Phase 0 step 5 said the constraint is missing)

**Sub-commit 2.0** — migration `<next-free>`: add `UNIQUE INDEX user_prompts(content_session_id, prompt_number)`. Layer 3's observation→transcript join depends on prompt_number stability.

### Sub-commit 2.1 — utilities

Append to `src/utils/tag-stripping.ts`: `stripTranscriptPrivacyTags`, `chunkText`. **Source:** branch lines 97–112. Pure functions. Add unit tests.

### Sub-commit 2.2 — ChromaSync transcript methods

Append to `src/services/sync/ChromaSync.ts`: `addTranscriptChunks`, `getTranscriptSegment`, `queryTranscriptSegment`. **Source:** branch lines 906–993. No edits to existing methods. Should apply cleanly per doc 01 §8 ("Low" risk).

### Sub-commit 2.3 — DatabaseManager second instance

Add to `src/services/worker/DatabaseManager.ts`: `transcriptChromaSync` field, init under `chromaEnabled` guard, `getTranscriptChromaSync()` getter, close in `close()`. ~6 line additions.

### Sub-commit 2.4 — HTTP route + MCP tool

- `SessionRoutes.ts`: add `handleTranscriptStore` and `handleTranscriptSegment` (`/api/transcript/store`, `/api/transcript/segment`).
- `mcp-server.ts`: register `get_transcript_segment`. **Append** to main's tool array — do not replace; main shipped 7 corpus tools post-divergence (per doc 01 §7).

### Sub-commit 2.5 — TranscriptEventProcessor wiring

Apply doc 01 §7 "Commit 5" exactly. Critical:
- **Drop** the 3-retry exponential backoff in `handleSessionEnd` (per doc 01 §6 verdict — "simple better").
- **Skip** the watcher rewrite (per doc 01 §7 "Skip").

### Verification checklist for Phase 2

- [ ] Each sub-commit builds clean (`npm run build`).
- [ ] Docker dev container: drive a real session; confirm collection `cm__claude-mem-transcripts` is created in Chroma.
- [ ] `get_transcript_segment(observation_id)` MCP tool returns text for an observation produced in that session.
- [ ] `get_transcript_segment(observation_id, query)` returns scoped vector results (n=3).
- [ ] No regression in main's other Chroma collections.

### Anti-pattern guards

- ✗ Do not regress `mcp-server.ts` tool array — append only.
- ✗ Do not add the `user_prompts` UNIQUE constraint migration (sub-commit 2.0) if v12.6.0 already has it (Phase 0 verifies).
- ✗ Do not port the watcher rewrite — main has its own variant.

---

## Phase 3: Observation source metadata data layer (per doc 03)

Per `03-observation-source-metadata.md` §7. Single coherent change. **Main already has the bare `metadata TEXT` column** (migration 30, PR #2116), so **no migration**.

### Sub-commits

**3.1** Drop in `src/services/worker/metadata-extractor.ts` verbatim from branch (64-line pure function, zero conflicts).

**3.2** Plumb per-message metadata into `ResponseProcessor.ts`. Main's iterator yields one message at a time — the variable holding "the message that triggered this turn" gets `extractSourceMetadata(msg.tool_name, msg.tool_input)` stamped onto each observation in `labeledObservations`. **No parallel array. No `processingMessageMeta` field on `Session`.** (Per doc 03 §7 step 4.)

**3.3** Extend `ObservationInput` in `src/services/sqlite/observations/types.ts` with `metadata?: Record<string, unknown>`.

**3.4** Extend `storeObservation` in `src/services/sqlite/observations/store.ts`: append `metadata TEXT` column to the INSERT, bind `JSON.stringify(observation.metadata) || null`. **Keep** main's `ON CONFLICT(memory_session_id, content_hash) DO NOTHING`. Keep the 7-arg signature shape — `metadata` lives on `observation`, not as a positional arg (per doc 03 §7 step 2).

**3.5** Extend `PaginationHelper.ts`: add `o.metadata` to the SELECT list in `getObservations`.

**3.6** Extend `ObservationSSEPayload` in `src/services/worker/agents/types.ts`: `metadata?: string`. Populate where `broadcastObservation` is called in `ResponseProcessor.ts` (~line 205 on main per doc 03 §7).

**3.7 (deferred)** `getObservationsByIds` filter for `source_url` — only when Phase 4's UI actually needs it. Skip if not needed yet.

### Verification

- [ ] `npm run build` clean.
- [ ] Drive a WebFetch tool call in a dev session. Confirm the resulting observation row has `metadata` containing `tool_name: "WebFetch"` and the URL.
- [ ] SSE `new_observation` payload includes `metadata` for that row.
- [ ] `/api/observations` paginated response includes `metadata` field.
- [ ] Old observations without metadata still render normally.

### Anti-pattern guards

- ✗ Do **not** add migration 30 again — main has it.
- ✗ Do **not** port `processingMessageMeta` parallel array. Doc 03 §6 calls it "dead complexity" under main's single-message iterator model.
- ✗ Do **not** add JSON computed indexes yet. Doc 03 §7 defers them until filters ship.
- ✗ Do **not** include `tool_name` filter — `source_url` only.
- ✗ Do **not** include `generatedByModel` parameter (per D4 default; revisit only if user reverses D4).

---

## Phase 4: Viewer UI source metadata (per doc 04)

Per `04-viewer-ui-source-metadata.md` §7. ~30 LOC across types, ObservationCard, CSS.

### Sub-commits

**4.1** Add `metadata?: string` to `Observation` in `src/ui/viewer/types.ts`.

**4.2** In `src/ui/viewer/components/ObservationCard.tsx`, after the `<span className="meta-date">` line, add a try/catch-guarded JSON.parse block that renders:
- `tool_name` pill (`.meta-tool-name`)
- truncated `source_url` link (`.meta-source-url`) **only if** the URL begins with `http://` or `https://` (protocol allowlist from `077051e5`)
- Use `truncateUrl(url, 40)` (port from branch — strip protocol, host+path, ellipsis past 40)
- Open in new tab with `rel="noopener noreferrer"`; full URL goes in `title=` for hover

**Keep main's `card-source` badge as-is.** Do not delete.

**4.3** CSS: add `.meta-tool-name` and `.meta-source-url` rules to viewer stylesheet. Match `.meta-date` weight/size; URL link uses `var(--color-link)`.

**4.4** Confirm — should be no-ops on top of Phase 3:
- `o.metadata` already in `PaginationHelper` SELECT (Phase 3.5).
- `metadata` already in `ObservationSSEPayload` (Phase 3.6).

### Verification

- [ ] Mock observation with `metadata: JSON.stringify({tool_name: "WebFetch", source_url: "https://example.com/very/long/path"})` renders pill + truncated link.
- [ ] `javascript:foo` URL is dropped (no link rendered).
- [ ] Malformed JSON renders the card with no error and no extra elements.
- [ ] Old observations without metadata render normally.
- [ ] Browser-test the viewer at `http://localhost:37778` (Docker dev port) — load real observations and visually confirm.

### Anti-pattern guards

- ✗ Do **not** add `TITANS_EMOJI` map in this PR. Defer to Phase 1's TITANS work or beyond.
- ✗ Do **not** remove main's `card-source` badge. Main shipped it deliberately.
- ✗ Do **not** touch `Header.tsx` source-selector or `ContextSettingsModal.tsx` source-selector — main already cleaned these.
- ✗ Do **not** rewrap `useSSE.ts` projects shape. Take main entirely.

---

## Phase 5: Logger ergonomic salvage only (per revised D3)

### Why per-message tracking is rejected

History on PR #2255:

1. Greptile bot filed a P1 on PR #2255 flagging that `clearPendingForSession` drops in-flight pending messages during hook bursts.
2. An agent committed `a0899529` adding `clearProcessingForSession` (status-scoped DELETE) as a fix.
3. The user (`thedotmack`) replied on the thread: **"Do not do this. this is against our design."**
4. The fix was reverted 33 seconds later as `3a9d7e78`.
5. A PR-level comment (https://github.com/thedotmack/claude-mem/pull/2255#issuecomment-4364911399) was posted documenting the rationale: burst-window message loss is acceptable because the AI response already captures recent activity context, and the next hook re-enqueues fresh observations.
6. Greptile thread `PRRT_kwDOPng1J85_Jl_a` resolved as won't-fix.

**The intended design on main** (PR #2255, commit `9e297305`, "the queue collapse") is the session-wide `clearPendingForSession` exactly as it stands. `confirmProcessed(messageId)` was deliberately removed; per-message tracking is explicitly out of bounds.

Both the FIFO tracker (`897f8da5`) and the `clearProcessingForSession` cherry-pick (`a0899529`) re-introduce per-message tracking. **Both are against the user's stated design.** The burst-window loss in `clearPendingForSession` is **intentional design**, not a regression.

### What to do

**Sub-commit 5.1 — `CLAUDE_MEM_LOG_TO_STDOUT` mirror.**
Append after `src/utils/logger.ts:299` (line number from doc 05 §1.b — verify in Phase 0). Reads env `CLAUDE_MEM_LOG_TO_STDOUT=1` and mirrors every log line to stdout so `tee -a worker.log` captures it inside Docker. Pure ergonomic win for the docker harness already documented in `CLAUDE.md`. No design implications.

That's the entire phase.

### Verification

- [ ] `npm run build` clean.
- [ ] `CLAUDE_MEM_LOG_TO_STDOUT=1 bun plugin/scripts/worker-service.cjs` mirrors lines to stdout (visible to `tee` and `docker logs`).
- [ ] Without the env var, behavior unchanged from main (lines only land in `~/.claude-mem/logs/`).

### Anti-pattern guards

- ✗ Do **not** add `clearProcessingForSession` to `PendingMessageStore`. Rejected on GitHub thread.
- ✗ Do **not** cherry-pick `a0899529` from `origin/pre-queue-engine-rewrite`. Same reason.
- ✗ Do **not** restore `confirmProcessed(messageId)`. Queue collapse deliberately removed it.
- ✗ Do **not** port the `processingMessageIds` / `processingMessageMeta` arrays.
- ✗ Do **not** port the QUEUE diagnostic log lines (`TRACKED_FOR_CONFIRM`, `CONFIRM_PASS`, `CONFIRM_SKIP`) — they reference the obsolete tracker.
- ✗ Do **not** "fix" the burst-window loss at line 111 of `ResponseProcessor.ts`. It is intentional per the resolved Greptile P1.

---

## Phase 6: Final verification

After all selected phases land:

1. **Build clean from scratch:**
   ```bash
   npm run build
   ```
2. **Docker dev container end-to-end:**
   ```bash
   docker/claude-mem/build.sh
   # Use the persistent detached container snippet from CLAUDE.md
   ```
   - Drive a session that exercises: WebFetch (Phase 3 metadata), tool observations, conversational signals (Phase 1 TITANS expanded mode), prompt boundaries (Phase 2 transcripts), and message claim/clear (Phase 5).
3. **Per-phase smoke checks** (consolidated):
   - [ ] `code-test` mode produces conversational observations (Phase 1).
   - [ ] `cm__claude-mem-transcripts` collection exists in Chroma (Phase 2).
   - [ ] `get_transcript_segment(<id>)` returns text via MCP (Phase 2).
   - [ ] WebFetch observation row carries `metadata` with `tool_name` + `source_url` (Phase 3).
   - [ ] Viewer card shows tool_name pill + truncated URL link for the row above (Phase 4).
   - [ ] Insert-while-processing test passes; no pending rows lost on AI-success (Phase 5).
4. **Anti-pattern grep sweep:**
   ```bash
   grep -rn "processingMessageMeta\|processingMessageIds\|fireConversationObservation\|queueConversation\|OneShotQuery" src/ plugin/ \
     2>&1 | grep -v node_modules
   ```
   Should be **empty** if the corrected TITANS design was followed and the FIFO tracker was not re-introduced.
5. **Migration sanity:**
   ```bash
   grep -E "version\s*[:=]\s*[0-9]+" src/services/sqlite/migrations/runner.ts
   ```
   Numbers strictly monotonic; no collisions with main's range.
6. **Tests:**
   ```bash
   npm test
   ```

### Phase 6 sign-off requires

- [ ] All checked items above.
- [ ] No new file outside `redo-plan/`, `plugin/modes/`, `src/`, and `tests/`.
- [ ] No re-introduction of any of the 7 "Explicitly do not build" items from `00-handoff.md` §"TITANS corrections".

---

## Out of scope for this redo

Per `00-handoff.md`:

- Stash@{0}: wall-clock guard removal, HUMAN.md, pathfinder skill (D5 default = defer).
- The 23 commits on `thedotmack/merged-layer3-metadata` as a unit — that branch stays as a reference; nothing is rebased or salvaged structurally. Only the 5 documented features are re-derived.
- Any provider rename remediation — under the corrected TITANS design, no provider files are touched.
- `generatedByModel` parameter (D4 default = defer).

---

## PR-level commit shape

Each PR is its own branch off `origin/main` with the sub-commits listed in its phase. Approximate sizes:

| PR | Branch | Commits | Notes |
| -- | ------ | ------- | ----- |
| P1 | `thedotmack/titans-expanded-mode` | 3 (docs + 2 code) | Includes `redo-plan/` docs commit (first PR only). Ships today. |
| P2 | `thedotmack/layer3-transcripts` | 5 (or 6 if user_prompts UNIQUE migration needed) | All additive. |
| P3 | `thedotmack/observation-metadata` | 6 | All additive; no migration. |
| P4 | `thedotmack/viewer-metadata-ui` | 3 | Depends on P3 having merged. |
| P5 | `thedotmack/log-to-stdout` | 1 | One-line ergonomic. |

**~18 commits across 5 PRs**, all additive, each PR independently mergeable except P4 (waits on P3).
