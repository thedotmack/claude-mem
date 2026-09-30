# Overnight Fixes — Single Round (v13.12.4)

Four root-cause fixes from the post-v13.12.2 issue batch, shipped as one release:

| Phase | Issue | Defect |
|-------|-------|--------|
| 1 | #3380 (+ #3378 logs) | Shutdown skips ALL teardown when the http server handle is not listening (`ERR_SERVER_NOT_RUNNING` rejects instead of resolving) |
| 2 | #3379 | Prefixed concept tags (`"gotcha: …"`) silently excluded from context injection by exact-match SQL |
| 3 | #3378 (second half) | `FOREIGN KEY constraint failed` aborts background init → worker never ready; plus `errors=[object Object]` logging |
| 4 | #3381 | Maintainer-only agent directives in root CLAUDE.md ship to end users via the marketplace git clone |
| 5 | — | Verification + release 13.12.4 |

**Execution model:** each phase is self-contained and can run in a fresh context. Run consecutively (Phase 3 depends on nothing from 1–2, but Phase 5 needs all of 1–4 committed). Execute with `/claude-mem:do` or by hand.

**Binding constraints (repo merge rubric, `docs/merge-rubric.md`):** root-cause corrections only. No retry loops, no circuit breakers, no fallback paths, no fail-open modes, no truncation of user data, no new background processes/state files, no env-var escape hatches. Fail-fast conversions and deletions of machinery are encouraged. Tests are always in scope. Diff size must match the size of the logic error. Do not edit `CHANGELOG.md` (generated).

---

## Phase 0 — Consolidated Discovery Findings (read this before any phase)

All findings below were verified against source at v13.12.3 (commit `68b077f7f` era) with exact citations. Do not re-derive; do not invent APIs.

### Allowed APIs / copy-ready patterns

| Pattern | Location | Use in |
|---------|----------|--------|
| Tolerating `ERR_SERVER_NOT_RUNNING` on close (idempotent-close domain state) | `src/server/runtime/ServerService.ts:230-236` | Phase 1 |
| Test pattern for tolerating that error | `tests/server/server.test.ts:141-147`, `:167-173` | Phase 1 |
| Correct handle lifecycle (`if (!this.server) return;` + null after close) | `src/services/server/Server.ts:159-178` (`Server.close()`) | Phase 1 |
| Concept cleaning site (only existing concepts normalization) | `src/sdk/parser.ts:118` (`concepts.filter(c => c !== finalType)`) | Phase 2 |
| Version-gated one-shot migration template (no column added) | `src/services/sqlite/SessionStore.ts:1537-1552` (`addSessionCustomTitleColumn`) | Phase 2 |
| Data-fixup migration with UPDATE | `SessionStore.ts:1520-1535` (`addObservationContentHashColumn`, v22) | Phase 2 |
| FK-safe parent-before-child upsert (`INSERT … ON CONFLICT … DO NOTHING RETURNING`) | `src/services/sync/SyncApply.ts:646-703` (`ensureSessionForMemoryId`) | Phase 3 |
| Logger convention: pass `Error` as 4th `data` arg; context values must be scalars/strings | `src/utils/logger.ts:135-138`, `:252-255`; count-style example `WorktreeAdoption.ts:342` | Phase 3 |
| Migration test template | `tests/sqlite/session-store-migrations.test.ts` | Phases 2–3 |

### Facts (with citations)

**Shutdown (#3380):**
- `"Server is not running."` is **Node's native `ERR_SERVER_NOT_RUNNING`** from `http.Server.close(cb)` on a non-listening handle — it is not a repo string (the `ServerService.ts:360/:388` console prints are unrelated CLI status lines).
- Reject site: `src/services/infrastructure/GracefulShutdown.ts:60-69` (`closeHttpServer`) — `server.close(err => err ? reject(err) : resolve())` with no code check. It is the **first** step of `performGracefulShutdown` (`GracefulShutdown.ts:33-36`), so its rejection skips session drain, MCP close, chroma stop, db close, and supervisor stop.
- The rejection is caught and logged at `src/services/worker-shutdown.ts:96-113` ("Graceful shutdown failed — proceeding"), and the process still exits via `flushResponseThen.ts:8-13` — so the socket may never be closed gracefully (Windows port-hold in #3380/#2111).
- Contributing state bug: `Server.listen()` (`src/services/server/Server.ts:140-157`) assigns `this.server = server` at line 143 **before** the socket binds and never clears it when `listen` rejects (EADDRINUSE) — leaving a non-null, non-listening handle. Demonstrated by `tests/server/server.test.ts:113-127`.
- Worker wiring: single `Server` instance (`worker-service.ts:272`), single `listen` (`:421`); graceful shutdown consumes the raw handle at `worker-service.ts:813-819` (`server: this.server.getHttpServer()`).
- Existing shutdown tests mock past this path: `tests/services/worker-shutdown-sequence.test.ts` mocks `performGracefulShutdown`; `tests/infrastructure/graceful-shutdown.test.ts:104-107` has `mockServer.close` always succeed. The not-listening case is untested today.

**Concepts (#3379):**
- Injection query: `src/services/context/ObservationCompiler.ts:56-59` — `AND EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE value IN (…))`, placeholders from `config.observationConcepts` (`:28-29`), sourced from the active mode at `src/services/context/ContextConfigLoader.ts:13`.
- Valid `code`-mode tags (`plugin/modes/code.json:63-101`): `how-it-works, why-it-exists, what-changed, problem-solution, gotcha, pattern, trade-off`. Modes with `observation_concepts`: `code.json`, `email-investigation.json`, `law-study.json`, `meme-tokens.json`.
- Persist path: `src/sdk/parser.ts:101` extracts concepts; the ONLY normalization is line 118 (drop concept equal to observation type). SQLite write `SessionStore.ts:2517-2540` (`JSON.stringify(observation.concepts)` at `:2540`) — no validation. Secondary raw-insert path at `SessionStore.ts:3032`.
- Producer prompt: free-text XML (`src/sdk/prompts.ts:43-49`); the constraint text is `prompts.concept_guidance` in each mode JSON, whose own format (`gotcha: traps or edge cases`) invites the model to echo `keyword: description`. A parallel template exists at `src/server/generation/providers/shared/prompt-builder.ts:155`.
- Exact-match readers that the backfill also heals: `SessionSearch.ts:207`, `SessionStore.ts:2146`.
- Migration engine: private methods called sequentially in the `SessionStore` **constructor** (`SessionStore.ts:89-121`), recorded in `schema_versions`; current max version **48**; migrations run automatically on worker boot (`DatabaseManager.ts:28`). FTS `AFTER UPDATE` triggers exist (`SessionSearch.ts:107-112`) — verify trigger existence/ordering when the backfill UPDATE runs (see Phase 2 checklist).
- Caveat: inbound cloud sync (`SyncApply.ts:782`, `CloudSync.ts:205`) can re-import malformed concepts from other clients; note it in the fix commit, out of scope to solve.

**Background-init FK abort (#3378 second half):**
- **Adoption itself cannot raise the FK error**: `adoptMergedWorktrees` (`src/services/infrastructure/WorktreeAdoption.ts:122`) only UPDATEs non-key columns (`project`, `merged_into_project`, `sync_rev`, `synced_at`) on `observations`/`session_summaries` and INSERTs into FK-less `sync_outbox` (`remap-outbox.ts:173-186`). The only FK on those tables is `memory_session_id → sdk_sessions(memory_session_id)` (`SessionStore.ts:903`, `:925`), and SQLite immediate FKs re-check only when child **key** columns change. FK enforcement is ON per connection (`connection.ts:45`).
- Adoption is **fire-and-forget** since #2122 (`worker-service.ts:480-496`, commit `94d592f21`) and cannot abort init on current HEAD. The FK error that aborts init must come from an **awaited** step in `initializeBackground` — prime suspects: `await this.dbManager.initialize()` (`worker-service.ts:507`) → SessionStore constructor migration **rebuilds** (`SessionStore.ts:211-224`, `:1085-1129` — `INSERT … SELECT` copies that fault if orphaned `observations.memory_session_id` rows exist), and `runOneTimeV12_4_3Cleanup()` (`:509`, deletes from `sdk_sessions` at `CleanupV12_4_3.ts:253` with FK ON → CASCADE).
- Readiness: `initializationCompleteFlag = true; resolveInitialization();` at `worker-service.ts:579-580`. Any throw before that lands in the catch at `:668-670`, which logs and returns — worker never reports ready. (This gating is correct fail-fast; do NOT change it.)
- `errors=[object Object]`: `worker-service.ts:487-490` passes `errors: adoption.errors` (an `Array<{worktree, error}>`) in the logger **context** position; `logger.ts:268-274` renders context values with a template literal → `[object Object]`.
- `database is locked` during adoption: adoption's own connection (`WorktreeAdoption.ts:187`) races the boot-time migration writer because it is kicked at `worker-service.ts:480`, **before** `dbManager.initialize()` at `:507`; WAL single-writer + 5 s busy_timeout (`connection.ts:4,:44`).

**CLAUDE.md shipping (#3381):**
- The leak vector is the **marketplace git clone**: `known_marketplaces.json` shows `source: github, repo: thedotmack/claude-mem` cloned to `~/.claude/plugins/marketplaces/thedotmack/` — every tracked file ships, including root `CLAUDE.md` (byte-identical, verified by shasum), `docs/`, `plans/`. The plugin **cache** (`~/.claude/plugins/cache/…/13.12.3/`) is clean because `marketplace.json:9-16` sets plugin `source: "./plugin"`.
- The #2537 fix is `.npmignore:9-14` (`/CLAUDE.md` etc.) — it governs only the npm tarball, which is why GitHub-source installs bypass it (#3359). No evidence of any "#2688" fix exists in-repo.
- The maintainer rsync (`scripts/sync-marketplace.cjs:77-80`) filters by `.gitignore` only and also copies CLAUDE.md.
- Maintainer-only sections in root `CLAUDE.md`: `## Local Status Notes` (lines 35-37) and `## Daily Maintenance` (lines 39-47, the autonomous upgrade+commit directive). Lines 1-33 (Build, File Locations, Requirements, Documentation, Important) are legitimate contributor content.
- `.gitignore:43` already lists `CONTRIB_NOTES.md` (untracked → never ships). `plugin/` has no CLAUDE.md of its own (only the functional mode template `plugin/modes/law-study-CLAUDE.md` — do not touch it).

### Anti-patterns (repo-wide, all phases)

- Do NOT add a blanket `try/catch`-and-continue anywhere. Tolerating **specific** domain states (`ERR_SERVER_NOT_RUNNING` on close, `ESRCH` on kill) with an explicit code check is correct; swallowing unknown errors is not.
- Do NOT fix #3379 by prefix-matching in the SQL query — that tolerates malformed data forever. Fix the writer + backfill.
- Do NOT make background init "ready anyway" on failure — fail-fast gating at `worker-service.ts:668-670` stays.
- Do NOT delete orphaned observation rows in Phase 3 — orphans are still user data served by injection; repair the parent side.
- Do NOT invent logger APIs; the logger signature is `(component, message, context?, data?)` per `src/utils/logger.ts`.

---

## Phase 1 — Shutdown must survive a not-listening server handle (#3380)

### What to implement

1. **`src/services/infrastructure/GracefulShutdown.ts` (`closeHttpServer`, lines 60-69):** copy the tolerance pattern from `ServerService.ts:230-236` — in the `server.close` callback, treat `err.code === 'ERR_SERVER_NOT_RUNNING'` as success (resolve, with a `logger.warn` mirroring ServerService's "Server was already stopped when close was requested"); reject anything else. This is the core fix: an already-closed server must not abort the rest of teardown (sessions, MCP, chroma, db, supervisor).
2. **`src/services/server/Server.ts` (`listen`, lines 140-157):** assign `this.server` only in the `onListening` handler; in `onError`, leave `this.server` null (or clear it) so a failed bind never leaves a non-listening handle for shutdown to trip on. Keep the promise semantics identical otherwise.

### Documentation references

- Copy from: `src/server/runtime/ServerService.ts:227-238` (the exact catch shape), `src/services/server/Server.ts:159-178` (handle-null discipline).
- The skip-on-error consequence being fixed: `GracefulShutdown.ts:33-36` + `worker-shutdown.ts:96-113`.

### Verification checklist

- [ ] New test in `tests/infrastructure/graceful-shutdown.test.ts`: `mockServer.close` invokes its callback with an error whose `code = 'ERR_SERVER_NOT_RUNNING'` → `performGracefulShutdown` **resolves** and the subsequent steps (sessionManager.shutdownAll, dbManager.close, supervisor stop) are all still called. A second test: close errors with a different code → still rejects.
- [ ] New/updated test in `tests/server/server.test.ts`: after a rejected `listen` (EADDRINUSE pattern already at `:113-127`), `getHttpServer()` returns `null`.
- [ ] `bun test tests/infrastructure/ tests/server/ tests/services/worker-shutdown-sequence.test.ts` green.
- [ ] Grep guard: `grep -n "ERR_SERVER_NOT_RUNNING" src/services/infrastructure/GracefulShutdown.ts` returns the explicit code check (not a bare catch).

### Anti-pattern guards

- Only `ERR_SERVER_NOT_RUNNING` is tolerated; do not widen to a generic catch.
- Do not reorder `performGracefulShutdown` steps or add per-step try/catch "continue anyway" wrappers — the fix is that step 1 no longer falsely fails.
- Do not touch the restart-successor/kill logic (fixed in 13.12.3).

---

## Phase 2 — Concept tags: normalize on write, tighten the producer, backfill (#3379)

### What to implement

1. **Normalize at the parse boundary — `src/sdk/parser.ts:118`.** Extend the existing concept-cleaning line: for each extracted concept, truncate at the first `:` and trim (`"gotcha: WASM…"` → `"gotcha"`), then apply the existing `!== finalType` filter and drop empties. Do not filter against the mode list (novel tags are stored today; keep that behavior).
2. **Tighten the producer prompt** — in each of the four mode JSONs with `observation_concepts` (`plugin/modes/code.json` primarily; mirror in `email-investigation.json`, `law-study.json`, `meme-tokens.json`), amend `prompts.concept_guidance` with an explicit output rule, e.g.: "Each `<concept>` element must contain ONLY the bare keyword (e.g. `gotcha`) — never a description, sentence, or colon." Keep the keyword list; the descriptions stay in the guidance, the rule forbids echoing them.
3. **One-time backfill — new migration v49 in `src/services/sqlite/SessionStore.ts`.** Copy the version-gated shape of `addSessionCustomTitleColumn` (`:1537-1552`): if `schema_versions` has 49, return; else run one UPDATE rewriting each concepts array element, truncating at the first `:`:
   ```sql
   UPDATE observations
   SET concepts = (
     SELECT json_group_array(
       CASE WHEN instr(value, ':') > 0
            THEN trim(substr(value, 1, instr(value, ':') - 1))
            ELSE value END)
     FROM json_each(observations.concepts))
   WHERE concepts LIKE '%:%'
   ```
   then record version 49. Wire the call at the end of the constructor chain (after `initializeSyncHubLaunchBaseline()` at `SessionStore.ts:121`).

### Documentation references

- Injection query being satisfied post-fix: `ObservationCompiler.ts:56-59`; allowed tags `plugin/modes/code.json:63-101`.
- Persist sites: `parser.ts:101-143`, `SessionStore.ts:2517-2540`.
- Migration templates: `SessionStore.ts:1537-1552` (version-gated), `:1520-1535` (UPDATE fixup).

### Verification checklist

- [ ] Parser test (`tests/sdk/parser.test.ts`): `<concept>gotcha: some long description</concept>` parses to `concepts: ['gotcha']`; a bare `<concept>gotcha</concept>` is unchanged; a concept equal to the type is still dropped.
- [ ] Compiler test (`tests/context/observation-compiler.test.ts`): seed a row with `concepts = '["gotcha: x"]'` directly → excluded pre-migration; after running the v49 migration (new case in `tests/sqlite/session-store-migrations.test.ts`), the same row is returned by `queryObservationsMulti`.
- [ ] Migration test: v49 is idempotent (second construction is a no-op); an array like `["how-it-works","gotcha: x"]` becomes `["how-it-works","gotcha"]`; rows without `:` are untouched (the `WHERE` clause).
- [ ] Confirm the FTS `AFTER UPDATE` triggers (`SessionSearch.ts:107-112`) exist at the time v49 runs in the constructor order — if they don't yet, verify FTS content is rebuilt/consistent afterward (check how earlier UPDATE-migrations handled this; follow the same convention).
- [ ] `bun test tests/sdk/ tests/context/ tests/sqlite/` green.
- [ ] Grep guard: `grep -n "LIKE" src/services/context/ObservationCompiler.ts` — the injection query itself is UNCHANGED (no query-side tolerance added).

### Anti-pattern guards

- No query-side prefix matching. No dropping of whole observations (normalization only rewrites the tag). No new settings/env flags.
- The prompt edit changes instruction text only — do not restructure the XML template or migrate to tool-use in this phase (that is #2233, out of scope).

---

## Phase 3 — Pin and fix the background-init FK abort; fix the error logging (#3378)

This phase has a mandatory pin-down step because discovery proved adoption's own SQL cannot raise the FK error (see Phase 0). Do not guess the site; prove it, then fix the proven site.

### What to implement

1. **Pin the FK site with a test.** In a temp DB, seed an **orphaned** child: an `observations` row whose `memory_session_id` has no `sdk_sessions` parent (insert with `PRAGMA foreign_keys = OFF`, mimicking historical data). Then construct `SessionStore` (runs the full migration chain, `SessionStore.ts:89-121`) and run `runOneTimeV12_4_3Cleanup` (`CleanupV12_4_3.ts`). Identify which step throws `FOREIGN KEY constraint failed`. Prime suspects: the rebuild `INSERT … SELECT` blocks (`SessionStore.ts:211-224`, `:1085-1129`).
2. **Fix the proven site by repairing the parent side.** For rows whose `memory_session_id` has no parent, insert a minimal `sdk_sessions` stub row **before** the copying/rebuild step, mirroring the canonical FK-safe upsert `ensureSessionForMemoryId` (`SyncApply.ts:646-703`, `INSERT … ON CONFLICT … DO NOTHING`). Orphaned observations are live user data (injection reads `observations` directly) — the parent is what's missing, so the parent is what gets created. If the pin-down step instead proves a different mechanism (e.g. cleanup CASCADE ordering), fix that proven mechanism at its root with the same parent-repair principle; update this plan file with what was found.
3. **Fix the `[object Object]` log — `worker-service.ts:487-490`.** Serialize the array into the context as a string: `errors: JSON.stringify(adoption.errors)` (or per-item `${worktree}: ${error}` joined). One line; follow `logger.ts` conventions (context values must render as strings).
4. **Remove the boot-time writer race behind `database is locked`:** move the fire-and-forget adoption kick (`worker-service.ts:480-496`) to **after** `await this.dbManager.initialize()` completes (i.e., after line 507's await, or after readiness at `:579-580`), so adoption's separate write connection no longer races the migration writer. It stays fire-and-forget; only its start moves. Preserve the surrounding comment block's intent and update it.

### Documentation references

- FK definitions: `SessionStore.ts:903`, `:925`; enforcement `connection.ts:45`.
- Rebuild blocks to inspect: `SessionStore.ts:211-224`, `:1085-1129`.
- Parent-repair pattern to copy: `SyncApply.ts:646-703`.
- Init sequence + readiness: `worker-service.ts:440-509`, `:579-580`, catch at `:668-670`.
- Logger rendering paths: `logger.ts:141-143` (data), `:268-274` (context).

### Verification checklist

- [ ] The pin-down test exists, is committed, and initially FAILS on the unfixed code (red), then passes with the fix (green) — this is the proof the right site was fixed.
- [ ] Post-fix: constructing `SessionStore` over the orphan-seeded DB completes; the orphan's observation row survives with a stub parent present (`SELECT COUNT(*)` assertions on both tables).
- [ ] Log fix: a unit-level assertion (or manual run) shows the adoption warning renders actual error text, not `[object Object]`.
- [ ] Adoption ordering: `tests/worker/sync/mutation-sites.test.ts:322-369` and `tests/services/infrastructure/worktree-adoption-chroma.test.ts` still green; grep confirms the adoption kick now sits after `dbManager.initialize()` in `initializeBackground`.
- [ ] `bun test tests/sqlite/ tests/worker/ tests/services/` green.

### Phase 3 execution result (2026-07-23, branch fix/3378-background-init-fk-abort)

Pin-down CONFIRMED the expected mechanism (rebuild `INSERT … SELECT` copies), with two precisions:
- The proven faulting sites are **v9 `makeObservationsTextNullable`** (the old `:1085-1129` citation; stack frame SessionStore.ts:1167 on unfixed code) AND **v7 `removeSessionSummariesUniqueConstraint`** (same mechanism for session_summaries; stack frame SessionStore.ts:1074). Both copy a child table into a freshly created FK-bearing table with `foreign_keys = ON` and, unlike v21/v33/v34, never disable it.
- `runOneTimeV12_4_3Cleanup` can never be the aborting step: it catches and logs its own errors (`CleanupV12_4_3.ts:70-76`), so the awaited faulting step is `dbManager.initialize()` → SessionStore constructor.
Fix: `repairOrphanedSessionParents()` creates stub parents (mirroring `ensureSessionForMemoryId`) inside both rebuild transactions before the copy. Tests: `tests/sqlite/session-store-orphan-fk-repair.test.ts` (red a5f8d30a2 → green), `tests/services/infrastructure/worktree-adoption-errors.test.ts`.

### Anti-pattern guards

- Do NOT wrap `initializeBackground` steps in catch-and-continue; the ready-flag gating stays fail-fast.
- Do NOT delete orphaned observations (truncation of user data). Do NOT add a boot-time "orphan sweep" background job — the repair happens inline at the exact migration/cleanup step that faults, gated like any other migration.
- Do NOT increase `busy_timeout` or add retry loops for the lock race — the fix is ordering, not waiting harder.

---

## Phase 4 — Stop shipping maintainer directives in CLAUDE.md (#3381)

### What to implement

1. **Move `## Local Status Notes` (CLAUDE.md:35-37) and `## Daily Maintenance` (CLAUDE.md:39-47) out of root `CLAUDE.md`** into `CLAUDE.local.md` (auto-loaded locally by Claude Code for the maintainer, conventionally untracked). Root CLAUDE.md keeps only the contributor content (Build, File Locations, Requirements, Documentation, Important).
2. **Ensure `CLAUDE.local.md` is gitignored** — add to `.gitignore` if not already present (`.gitignore:43` already ignores `CONTRIB_NOTES.md`; use that file instead only if `CLAUDE.local.md` auto-load proves unavailable in the maintainer's Claude Code version).
3. **Harden the maintainer sync** — extend the rsync exclude list at `scripts/sync-marketplace.cjs:78` with `--exclude=/CLAUDE.md` so the local marketplace copy matches what a fresh GitHub clone of the slimmed repo would contain. (The real fix for end users is step 1 — a git clone ships every tracked file, so the dangerous content simply must not be tracked.)

### Documentation references

- Section classification and exact lines: Phase 0 findings (CLAUDE.md:35-47 maintainer-only; 1-33 keep).
- Sync script: `scripts/sync-marketplace.cjs:77-80`; npm-tarball guard stays as-is: `.npmignore:9-14`.
- Do NOT touch `plugin/modes/law-study-CLAUDE.md` (functional mode template, protected by the anchored-path comment in `.npmignore:10-11`).

### Verification checklist

- [ ] `grep -n "Daily Maintenance\|Local Status Notes" CLAUDE.md` → no hits; the sections exist verbatim in `CLAUDE.local.md`.
- [ ] `git check-ignore CLAUDE.local.md` → ignored; `git status` shows CLAUDE.local.md untracked-and-ignored.
- [ ] After `npm run build-and-sync`: `grep -L "Daily Maintenance" ~/.claude/plugins/marketplaces/thedotmack/CLAUDE.md` confirms the marketplace copy no longer contains the directive (file present but slim).
- [ ] Comment on #3381 and #3359 explaining: tarball was already guarded (#2537 `.npmignore`), the git-clone channel is now guarded by relocation; close #3381.

### Anti-pattern guards

- Do not delete the whole CLAUDE.md (contributor build instructions are legitimate content).
- Do not rely on rsync excludes alone — they don't affect end-user GitHub clones.

---

## Phase 5 — Verification sweep + release v13.12.4

### What to implement

1. **Full verification:**
   - `npx tsc --noEmit` → clean.
   - `bun test tests/` → 0 fail (the `workers/sync-hub` `cloudflare:test` errors are pre-existing and excluded; do not chase them).
   - Anti-pattern grep sweep over the round's diff (`git diff v13.12.3..HEAD -- src/ plugin/modes/`): no new `catch {}` swallows, no `setInterval`/poller additions, no new env-var flags (`grep -E "CLAUDE_MEM_[A-Z_]+" diff` should show no new names), injection query unchanged.
   - `npm run build-and-sync` → worker restarts and verifies at the current version.
2. **Release 13.12.4** via the version-bump workflow (`/claude-mem:version-bump patch`): bump all 8 manifests, verify with `git grep`, build-and-sync, commit, tag `v13.12.4`, push branch + tag, GitHub release notes covering all four fixes (cite #3378/#3379/#3380/#3381), regenerate changelog, Discord notify. **npm publish is handed off to the human maintainer**; start the background `npm view claude-mem@13.12.4 version` poller.
3. **Issue housekeeping:** close #3378 (both halves now fixed — link the FK commit and the 13.12.3 recycle fix), close #3379 (normalize+backfill shipped), comment on #3380 asking the reporter to verify on Windows against 13.12.4 (close if the earlier 13.12.3 comment thread already confirmed), close #3381.

### Verification checklist

- [ ] All Phase 1–4 checklists green in one working tree before the bump.
- [ ] `git status` clean after release; tag pushed; GitHub release live; changelog committed.
- [ ] Worker log after final build-and-sync shows no `Graceful shutdown failed`, no `FOREIGN KEY`, no `[object Object]` during the restart cycle.
