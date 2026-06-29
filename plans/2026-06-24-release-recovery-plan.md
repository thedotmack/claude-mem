# 2026-06-24 Release Recovery Plan

## Goal

Ship a reliability-first recovery release that removes the largest June 2026 error sources, stops observer/chroma churn, and gives users a setup path that does not fail only after their first session starts.

This plan cross-references the attached PostHog error report with the live `thedotmack/claude-mem` GitHub backlog as of 2026-06-24:

- Open GitHub issues: 89
- Open GitHub PRs: 123
- Attached report: 10 high-priority PostHog error categories, about 987k occurrences / 21k affected users in 30 days

## Source Evidence

- Attached report: `/Users/alexnewman/.superset/host/e7c5cb1f-3f94-4b7b-b6b7-37a97d3b4a51/attachments/08a4bcfe-650a-4094-a534-815c15b67701/08a4bcfe-650a-4094-a534-815c15b67701.json`
- GitHub snapshots created from `gh`:
  - `/tmp/claude_mem_open_issues_full.json`
  - `/tmp/claude_mem_open_prs.json`
- Local code surfaces:
  - `src/shared/find-claude-executable.ts`
  - `src/services/sync/ChromaMcpManager.ts`
  - `src/services/sync/ChromaSync.ts`
  - `src/services/worker/GeminiProvider.ts`
  - `src/services/worker/OpenAICompatibleProvider.ts`
  - `src/services/sqlite/SessionStore.ts`
  - `src/services/telemetry/backfill.ts`
  - `src/services/worker/agents/ResponseProcessor.ts`
  - `plugin/hooks/codex-hooks.json`
  - `scripts/build-hooks.js`
  - `src/cli/adapters/codex.ts`
  - `src/services/integrations/CodexCliInstaller.ts`

## Crosswalk

| Report item | Report impact | Matching GitHub issues | Matching PRs | Current root cause |
|---|---:|---|---|---|
| Claude executable not found | 466,499 occurrences / 9,039 users | No exact open issue found | No exact PR found | Claude CLI dependency is discovered only when the generator starts; no first-run preflight or one-time remediation state. |
| `uvx` not found | 67,958 occurrences / about 966 users | Partly covered by #2961 / plan #2779 | #2920, #2880, #2940, partly #3039 | Installer has `ensureUv`, but existing installs can still hit runtime `uvx` spawn failure. Runtime Chroma path does not degrade cleanly when uvx is absent. |
| `Bun.randomUUIDv5` not a function | 5,908 / 36 | No exact open issue found | No exact PR found | `src/services/telemetry/backfill.ts` calls a Bun-specific API; replacing it with a small UUIDv5 helper is better than requiring newer Bun. |
| Chroma 30s timeout | 102,186 / 7,061 | #2897, #2961, #3016, #3012 | #2920, #2880/#2940, #2536 | The MCP handshake timeout includes cold `uvx` environment installation; repeated timeout kills prevent cache completion and can leak temp dirs/processes. |
| MCP `-32000 Connection closed` | 210,951 / 2,833 | #2879, #2939, #2954, #2961, #2959, #2950 | #2880, #2940, #2536 | Multiple causes collapse to a generic close: old uv rejects bare `chroma-mcp==...`, Windows shell handling mangles args, and stderr is not surfaced. |
| Chroma backoff throws into sync | 5,810 / 639 | #3016, #2896, #2959 | #2536, partly local singleton tests | `ensureCollectionExists()` can throw before `addDocuments()` reaches its per-batch catch path; write paths should return "not synced yet" instead of throwing user-visible errors. |
| Gemini bad request 400 | 100,784 / 555 | No exact open issue found | No exact PR found | Gemini request shaping/truncation can produce invalid conversation envelopes; 400s are classified but not prevented or bucketed by closed reason. |
| Platform source conflict | 22,078 / 465 | No exact open issue found | No exact PR found | `sdk_sessions.content_session_id` is globally unique, and tests currently require throwing when the same raw session ID appears from two platforms. |
| JSON parse error with Chinese chars | 4,965 / 78 | Partly plan #2782, no exact issue | No exact PR found | `ChromaSync.formatObservationDocs()` raw-parses `facts` and `concepts`; bad legacy rows can kill backfill instead of being quarantined. |
| Observer poison/respawn loop | Not in report top 10, but dominates GitHub | #3037, #3032, #3022, #3007, #2960, #2955, #2935, #2817 | #3028, #2857, #2943, #2927, #2901 | Non-XML/idle/quota prose is treated as invalid output and can trigger respawn loops that wipe context and stop memory generation. |

GitHub-only Codex compatibility blockers to include in the same recovery release:

| Codex blocker | Matching GitHub issues | Matching PRs | Current root cause |
|---|---|---|---|
| Codex refuses to load hooks config | #2972, #2947 | #2953, #2948 | `plugin/hooks/codex-hooks.json` still has a root-level `description` field. Codex 0.140.0-0.142.0 rejects unknown root keys, so all hooks appear enabled but never run. |
| Codex rejects hook output | #2975, #2871 | #2953 | Some Codex hook paths can emit Claude-style `suppressOutput`, which current Codex reports as an unsupported field on PreToolUse/PostToolUse. |
| Codex/Windows spawn contract regressions | #2962, #2941, #2914 | #2945, #2598 | Published bundles and hook commands have had `shell: true` + args and fragile login-shell PATH probes; Codex installs are sensitive to both. |

## Release Scope

This release should be a recovery release, not a feature release. Hold broad feature PRs unless they remove a top recovery blocker.

Release blockers:

1. Setup/dependency preflight and graceful degradation.
2. Chroma launch/lifecycle reliability.
3. Observer output loop fix.
4. Codex hook compatibility: strict hooks schema, no unsupported output fields, and stable spawn/PATH contract.
5. Gemini request-shape fix.
6. Platform session identity fix.
7. Chroma backfill JSON tolerance.
8. Telemetry UUID compatibility.
9. Upgrade/install survival for partial dependency installs.

Explicitly hold from this release unless already required by a blocker:

- New providers or integrations: #3044, #3034, #3000, #2764, #2523, #2514.
- Broad refactors: #2878, #2877, #2632.
- Large feature bundles: #3027, #2829, #2606, #2623.

## PR Disposition

Merge or rebase into the recovery branch:

- #3039 `fix: prevent a broken/partial dependency install from bricking the worker` — clean, directly supports setup/upgrade survival.
- #3033 `fix(windows): strip UTF-8 BOM in all settings.json readers` — relevant to hook-breaking setup failures; rebase/check because merge state is unstable.
- #3018 `Preserve proxy variables during environment sanitization` — relevant to enterprise installs and provider/chroma network failures; rebase/check because merge state is unstable.
- #3028 `fix: ignore unparseable observer output instead of poisoned respawn` — use as canonical observer-loop PR if cleaned; supersede narrower #2857/#2943/#2927/#2901.
- #2920 `fix(chroma): prewarm uvx installs before the MCP connect deadline` — clean, essential for #2897.
- #2880 `fix(chroma): spawn chroma-mcp via --from so uv < 0.5.31 works` — prefer this over #2940 because it handles old uv and avoids bare positional package syntax. Pull any useful #2940 tests into the canonical Chroma PR, then close #2940 as superseded.
- #3009 or #2895 — choose one Windows stale-port recovery implementation, not both. #3009 is scoped to #2996; #2895 has the better cross-platform root-cause framing. Consolidate into one PR with tests.
- #2887 `fix(build): bundle zod into worker-service.cjs` — clean and removes a known install-bricking path.
- #2849 `fix(sqlite): apply busy_timeout to primary SQLite connections` — clean, low-risk data durability improvement.
- #2953 `Fix claude-mem codex-hooks.json for current Codex` — use as the canonical Codex compatibility PR if it rebases cleanly. It should remove the unsupported root `description`, verify Codex output never includes `suppressOutput`, and include generated artifact updates.
- #2945 `fix: install Windows Claude Code hooks without bash` — merge if the spawn/PATH changes cover Codex-distributed hooks too; otherwise pull the shared hook-template fix into the Codex compatibility PR.

Close or mark superseded after consolidation:

- #2536 if the final Chroma lifecycle PR includes singleton teardown and process-tree kill coverage.
- #2857, #2943, #2927, #2901 after #3028 lands with the broader parse/drop behavior and quota tests.
- #2940 after `--from` invocation is adopted and tested across uv versions.
- #2948 after #2953 lands, unless #2953 is abandoned and #2948 becomes the minimal hooks-schema fix.
- #2598 after the final hook-template/spawn-contract PR includes the PATH-probe behavior.

## New Plan Masters

Create these GitHub plan-master issues because the current backlog does not cover the report's biggest missing roots:

### `[plan-15] Startup Dependency Health -- preflight, runtime degradation, and repair`

Children to route:

- New: Claude CLI missing from PATH / `CLAUDE_CODE_PATH`.
- New: runtime `uvx` missing after old install.
- Existing related: #3039, #3035, #2964, #2823, #2831, #3013, #2999.

Fix sequence:

1. Add a side-effect-free dependency health module for Claude CLI, Bun, uv/uvx, plugin hard deps, and provider API key state.
2. Run it from install/repair and from worker startup.
3. Store a bounded setup status so hooks show one actionable hint and continue, instead of failing repeatedly.
4. In Claude provider startup, classify missing CLI as `setup_required` and do not keep retrying until settings or PATH changes.
5. In Chroma startup, classify missing uvx as `vector_search_unavailable`; SQLite capture must continue.

### `[plan-16] Chroma Runtime Lifecycle -- launch contract, backoff semantics, and data-dir hygiene`

Children to route:

- #2879, #2897, #2896, #2907, #2939, #2950, #2954, #2959, #2961, #3012, #3016.

Fix sequence:

1. Invoke Chroma through `uvx --from chroma-mcp==<pin> chroma-mcp ...`.
2. Split prewarm timeout from MCP stdio handshake timeout.
3. Capture and log child stderr on connect failure.
4. Make uv/chroma dependency versions deterministic enough to avoid surprise cold rebuilds.
5. Keep exactly one Chroma subprocess tree per worker and reap it on reconnect, backfill close, worker stop, and failed connect.
6. Treat backoff/unavailable as "write not synced yet" from `ChromaSync`, not as a thrown user-flow error.
7. Add Chroma temp/cache cleanup guidance or automated safe cleanup after repeated aborted prewarm attempts.

### `[plan-17] Provider Request Envelopes -- Gemini/OpenRouter shape, truncation, and closed-error reasons`

Children to route:

- New: Gemini 400 bad request from PostHog report.
- Related provider issues in #2785 only if they are defects, not features.

Fix sequence:

1. Add provider-specific request-envelope builders with tests.
2. For Gemini, enforce a user-first, alternating `contents[]` sequence after truncation.
3. Preserve the current instruction/init message when possible; if truncation must drop it, rebuild a compact instruction wrapper instead of sending an orphaned assistant/model turn.
4. Map upstream 400 bodies to closed categories: `role_sequence`, `context_limit`, `model_unsupported`, `api_key`, `unknown_bad_request`.
5. Emit scrubbed telemetry counters for those closed categories only.

### `[plan-18] Platform-Namespaced Session Identity -- one raw session ID can exist in multiple clients`

Children to route:

- New: platform source conflict `existing=claude, received=cursor`.

Fix sequence:

1. Introduce a canonical internal session key: `platform_source + '\0' + content_session_id`.
2. Migrate `sdk_sessions` away from global `content_session_id TEXT UNIQUE` to uniqueness on `(platform_source, content_session_id)`.
3. Migrate `pending_messages` uniqueness and joins to include `session_db_id` or the same composite platform key.
4. Replace the current throw in `createSDKSession()` with get-or-create per platform.
5. Update tests that currently expect a conflict.

### `[plan-19] Codex Hook Compatibility -- strict schema, output contract, and spawn safety`

Children to route:

- #2972, #2947, #2975, #2871, #2962, #2941, #2914.
- PRs to consolidate or close: #2953, #2948, #2945, #2598, #2692.

Fix sequence:

1. Remove root metadata from `plugin/hooks/codex-hooks.json`; Codex hook config root must be only the keys Codex accepts.
2. Add build-time validation in `scripts/build-hooks.js` that fails if the Codex hooks file contains unsupported root keys.
3. Verify every Codex hook path goes through `codexAdapter.formatOutput()` and never emits Claude-only `suppressOutput`.
4. Keep Codex SessionStart context in `hookSpecificOutput.additionalContext` only.
5. Apply the hook shell-template/spawn contract to generated Codex hooks and the npx/Codex installer path: no `shell: true` + args, no required login-shell PATH probe.
6. Add a clean-room Codex plugin smoke check for Codex 0.140.0+ shape: hooks config parses, SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop all return accepted output shapes.

## Implementation Phases

### Phase 0 -- Branch and freeze

Create `release/recovery-2026-06-24`. Merge only recovery-scoped fixes above. No new providers, UI features, or storage refactors.

Verification:

- `gh pr list` for the release branch contains only blocker PRs.
- PR descriptions list `Closes #...` for every child issue covered.

### Phase 1 -- Setup and install survival

Implement plan-15 plus merge #3039/#3033/#3018/#2887 as applicable.

Required code:

- Shared dependency-health module used by installer, repair, worker startup, and settings/doctor.
- Replace `Bun.randomUUIDv5` in `src/services/telemetry/backfill.ts` with a local deterministic UUIDv5 implementation or small dependency-free helper.
- One-shot user-facing remediation for missing Claude CLI and uvx.

Tests:

- Missing Claude CLI does not respawn or block hooks; it records setup-required state.
- Missing uvx disables vector search but leaves SQLite capture/search alive.
- Telemetry backfill UUID is stable across runs without `Bun.randomUUIDv5`.
- Broken plugin deps do not kill a healthy previous worker.

### Phase 1A -- Codex hook compatibility

Implement plan-19 before the recovery release candidate is cut. This is a user-visible compatibility gate even though it is not in the PostHog top-10 report.

Required code:

- Regenerate `plugin/hooks/codex-hooks.json` without the root `description`.
- Add Codex hook-config root-key validation to the build.
- Confirm Codex output formatting strips `suppressOutput` on success, skipped input, worker-unavailable, and error paths.
- Fold any needed spawn/PATH fixes into the shared hook-template path used by Codex.

Tests:

- `plugin/hooks/codex-hooks.json` root keys match the Codex-accepted schema.
- Codex adapter output never includes `suppressOutput`.
- Hook-command skipped-input and worker-unavailable paths do not leak `suppressOutput` for Codex.
- Generated Codex hooks cover SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, and Stop without unsupported fields.

### Phase 2 -- Chroma runtime reliability

Implement plan-16 by consolidating #2920 + #2880 + current singleton/process-tree work.

Required code:

- `buildCommandArgs()` emits `--from chroma-mcp==0.2.6 chroma-mcp`.
- Prewarm timeout is configurable separately from MCP handshake timeout.
- `StdioClientTransport` stderr is drained into bounded logs.
- `addDocuments()` returns `0` when collection creation hits known Chroma-unavailable/backoff states.
- Backfill close/failed connect always reaps subprocess tree.

Tests:

- uv 0.5.29 and latest uv launch with the same args.
- Cold prewarm exceeding 30s does not get killed by MCP handshake timeout.
- Five concurrent `ensureConnected()` calls spawn one process.
- Backoff during prompt sync returns no throw and leaves watermark unchanged.
- Windows direct spawn never routes `>` / `<` through `cmd.exe`.

### Phase 3 -- Observer loop and quota pause

Land the broad #3028 behavior, then add the missing quota branch from #3037.

Required code:

- Non-XML output is logged and dropped unless it is a structured provider error.
- Idle/prose skip acknowledgements confirm the claimed batch and do not increment respawn debt.
- Claude subscription weekly-limit prose is detected before parser invalid-output handling; generator pauses until reset/backoff instead of respawning.
- Remove or rename `poisoned` telemetry once no behavior depends on it.

Tests:

- Text containing "context window" but not valid XML is dropped, not respawned.
- Repeated "No observations to record" never respawns.
- Weekly-limit message pauses generation and does not consume/drop pending work.
- Pending queue behavior differs intentionally: skip/no-op confirms; quota pause preserves.

### Phase 4 -- Provider and session identity fixes

Implement plan-17 and plan-18.

Required code:

- Gemini `contents[]` builder that repairs alternation after truncation.
- Closed 400 categories with no raw provider body in telemetry.
- SQLite migration for `(platform_source, content_session_id)` uniqueness.
- API/search joins updated to use `session_db_id` or composite identity where needed.

Tests:

- Truncated Gemini history never starts with `model`.
- Odd/even max-message truncation keeps a valid Gemini role sequence.
- Same raw session ID from Claude and Cursor creates two rows, no conflict.
- Existing single-platform DB migrates without losing observations, summaries, or pending messages.

### Phase 5 -- Backfill/data tolerance

Fold the JSON-parse issue into plan-09.

Required code:

- Replace raw `JSON.parse(obs.facts)` / `JSON.parse(obs.concepts)` in `ChromaSync` with tolerant JSON-array parsing.
- Quarantine malformed legacy columns by row id and continue backfill.
- Add closed telemetry/log reason: `malformed_json_column`.

Tests:

- `facts = '开始'` or raw non-JSON string does not crash backfill.
- Valid JSON arrays still produce fact/concept documents.
- Malformed one row does not prevent later rows from syncing.

## Release Verification Matrix

| Axis | Required proof |
|---|---|
| Clean install | macOS, Linux, Windows install/repair succeeds; missing Claude CLI gives actionable setup state. |
| Existing broken install | Partial deps, BOM settings, missing uvx, stale worker port all degrade or recover without blocking hooks. |
| Codex | Codex 0.140.0+ parses `codex-hooks.json`; all five Codex hook events return accepted output without `suppressOutput`. |
| Chroma | uv 0.5.29, latest uv, slow cold cache, Windows direct-spawn, process leak regression. |
| Provider | Gemini long histories and odd truncation limits do not generate invalid request bodies. |
| Multi-client | Claude + Cursor with same raw session id do not conflict. |
| Data pipeline | Chroma backfill survives malformed JSON and Chroma backoff. |
| Observer | Idle/prose/quota outputs do not poison-loop. |
| Packaging | `npm run build`, `npm run typecheck:root`, targeted Bun test matrix, clean-room smoke install. |

## Ship Criteria

Ship only when:

- All release blocker tests pass locally and in CI.
- `gh issue list --state open` has all report-related symptoms routed to plan masters or closing PRs.
- Codex compatibility issues #2972 and #2975 are closed by the release PR or explicitly superseded by one merged Codex compatibility PR.
- PR body for the recovery release has `Closes #...` for the covered child issues.
- Post-release dashboard tracks these closed categories: setup_required, chroma_unavailable, chroma_backoff, provider_bad_request_category, observer_invalid_output_dropped, quota_paused, malformed_json_column.

## Post-Release Watch

For 72 hours after release:

- PostHog top-10 report items should drop materially, especially:
  - Claude executable not found
  - uvx not found
  - Chroma timeout / connection closed / backoff
  - Gemini 400
  - platform source conflict
  - JSON parse error
- GitHub Codex intake for hook parse failures and unsupported `suppressOutput` should stop after users upgrade.
- GitHub intake should route new symptoms into plan masters, not create standalone open issues.
- If Chroma errors remain high after launch fixes, prioritize remote-Chroma opt-out/disable flow and exact dependency pins next.
