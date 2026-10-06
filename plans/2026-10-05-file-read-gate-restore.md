# File Read Gate — restore the full-file Read block (default ON) with evals

**Date:** 2026-10-05
**Branch:** `smart-read-blocking-evals-0ec5e93c`
**Status:** Approved for `/do` (standing authorization). Ship path: `/do` → PR → `/babysit` → `/version-bump`.

## 1. In plain English

claude-mem once **blocked** Claude Code's `Read` tool for files that already had observations. The denial carried the file's observation timeline and told Claude to use `smart_outline` / `smart_unfold` / `get_observations` instead. That block was softened step by step until today the PreToolUse `Read` hook is `async: true` and returns `allow`, so it cannot block anything.

Restore the block as a **default-ON setting** (`CLAUDE_MEM_FILE_READ_GATE_ENABLED`, `'true'`), turn-off-able from settings.json, env, or the viewer. Prove it with unit tests, a deterministic hook pre-flight against a real seeded worker, and a `claude plugin eval` A/B (gate ON vs OFF) that drives real Claude Code.

## 2. History (verified with `git show`)

| Commit | Date | What the Read hook did |
|---|---|---|
| `fb9d917f8` | 2026-03-18 | `allow` + timeline as `additionalContext` |
| `c80763390` | 2026-03-19 | exit 2 on the first Read per session (FileReadGate, 4 h TTL) |
| `455aeaf65` | 2026-04-06 | **`permissionDecision: "deny"` on every Read with observations**, timeline as `permissionDecisionReason` |
| `ef1b427a2` / `d8947473b` / `c21e49d9f` | 2026-04-07 | deny reason routes to smart tools; path escaping; `Current:` timestamp; docs `docs/public/file-read-gate.mdx` |
| `d0676aa04` | 2026-04-07 | deny → `allow` + `updatedInput {limit:1}` (deny broke Edit: "File has not been read yet") — **v12.0.0 shipped this, the deny never shipped** |
| `2a2008bac` | 2026-04-15 | #1719: keep caller offset/limit; skip when file mtime ≥ newest observation |
| `d13662d5d` | 2026-04-25 | #2094 Edit deadlock: stop rewriting Read; `allow` + context only |
| `1c6c18768` | — | #3480: dedupe injection per (session, file, newest observation) |
| `ce1f52533` | 2026-07-12 | `"async": true` on PreToolUse Read (#3206 latency: P50 ≈2 s per Read) — **async hooks cannot deny** |

The deny-era reason text (`git show c21e49d9f:src/cli/handlers/file-context.ts`, `formatFileTimeline`) is the copy source for the routing wording.

## 3. Phase 0 — Documentation discovery (DONE, consolidated)

### 3.1 Claude Code hook contract (https://code.claude.com/docs/en/hooks.md)

- PreToolUse `hookSpecificOutput`: `permissionDecision` `"allow" | "deny" | "ask" | "defer"`; for `"deny"` "Claude Code cancels the tool call and feeds `permissionDecisionReason` back to Claude". `additionalContext` is supported. `"allow"` **skips the permission prompt**.
- Exit 0 + JSON on stdout. claude-mem never exits 2 (`src/shared/hook-constants.ts:42-46`, `src/shared/hook-io.ts:175-183`).
- `async: true`: "Async hooks can't block or control Claude's behavior: response fields like `decision`, `permissionDecision`, and `continue` have no effect"; context arrives on the next turn.
- Matcher `"Read"` matches only the built-in Read tool (MCP tools are `mcp__<server>__<tool>`).

### 3.2 Verified empirically (Claude Code 2.1.290, haiku, scratchpad `exp-partial-read/run1.jsonl`)

A PreToolUse deny of a full `Read` → Claude sees `PreToolUse:Read hook error: <reason>` (`is_error: true`) → `Read(offset:10, limit:5)` succeeds → **`Edit` on the same file succeeds**. So a targeted Read satisfies Edit's read-before-edit rule. The gate must let targeted reads through.

### 3.3 claude-mem internals (file:line, this branch)

| Need | Where |
|---|---|
| Handler today | `src/cli/handlers/file-context.ts` (allow + additionalContext at 168-174; `buildFileContextTimeline` 178-273; constants 15-20) |
| Dedupe claim | `src/cli/handlers/file-context-dedupe.ts` `claimFileContextInjection(sessionId, absolutePath, newestObservationMs): boolean` (fails open → `true`) |
| HookResult type | `src/cli/types.ts:48-62` (`permissionDecision?: 'allow' \| 'deny'`, `permissionDecisionReason?`, `additionalContext: string` required) |
| Platform field | `NormalizedHookInput.platform` set at `src/cli/hook-command.ts:69`; precedent `input.platform === 'claude-code'` at `src/cli/handlers/context.ts:76` |
| Claude adapter passes `hookSpecificOutput` through unchanged | `src/cli/adapters/claude-code.ts:75-89` |
| Codex forwards deny (would block whole Bash commands) | `src/cli/adapters/codex.ts:133-139` — **must not gate** |
| Kimi prints only `additionalContext` | `src/cli/adapters/kimi.ts:125-131` — **must not gate** |
| Worker call budget | `executeWithWorkerFallback(url, method, body, { timeoutMs })` — absolute cap incl. liveness (`src/shared/worker-utils.ts:2093-2134`) |
| Hook settings read | `loadFromFileOnce()` `src/shared/hook-settings.ts:10-14`; precedent `src/cli/handlers/context.ts:93-99` |
| Settings defaults | `src/shared/SettingsDefaultsManager.ts` interface 142-352, `DEFAULTS` 354-579; booleans are `'true'`/`'false'`; env var of the same name overrides (601-620) |
| Settings API whitelist | `src/services/worker/http/routes/SettingsRoutes.ts` `settingKeys` (~237-284, see 280) and `booleanSettings` (~459-473, see 464) |
| Viewer | `src/ui/viewer/constants/settings.ts:40`, `src/ui/viewer/types.ts:123`, `src/ui/viewer/components/ContextSettingsModal.tsx:636-651` (`ToggleSwitch` group) |
| End-to-end boolean precedent | commit `0d825988e` (#4251): SettingsDefaultsManager + SettingsRoutes + modal + constants + types + configuration.mdx + tests |
| Smart tool names | `mcp__plugin_claude-mem_mcp-search__smart_outline` (`file_path`), `__smart_unfold` (`file_path`, `symbol_name`), `__get_observations` (`ids: number[]`) — `src/servers/mcp-server.ts:575-592, 796-868` |
| Smart tool language map | `LANG_MAP` + `detectLanguage` in `src/services/smart-file-read/parser.ts:38-85` (not exported; parser.ts is **not** in the worker bundle today) |
| Smart tools reject paths outside the MCP cwd | `src/services/smart-file-read/workspace-path.ts:25-50` |
| hooks.json | hand-maintained flags; `scripts/build-hooks.js:106-179` checks only `command` and object-form `timeout` (UserPromptSubmit precedent 141-144) |
| hooks.json tests | `tests/infrastructure/plugin-distribution.test.ts:506-528` (asserts `preToolUse.async === true` at 523 — must change), sync pattern 530-553, timeout pattern 657-668, expectations 597-603 |
| Handler tests | `tests/hooks/file-context.test.ts` (fetch-spy worker 69-85, temp 2,000-byte file 62/89-92, per-test `CLAUDE_MEM_DATA_DIR` 94-98); flippable `hook-settings.js` mock: `tests/cli/handlers/summarize-advisor-capture.test.ts` |
| Settings tests | `tests/worker/http/routes/settings-routes-session-start-sources.test.ts:12-51`, `tests/shared/welcome-hint-default.test.ts:34-54` |
| Observation seeding | `SessionStore.createSDKSession` → `updateMemorySessionId` → `storeObservations(memId, project, [obs], null, 0, 0, epoch)` (`tests/services/sqlite/observations-by-file-path-candidates.test.ts:24-46`); `SessionStore` needs `bun:sqlite` → seed under bun |
| Eval worker pattern | sibling worktree `recent-estimate-368db067/scripts/eval-week-worker.cjs` (untracked): `createWorker` settings (port, `CLAUDE_MEM_WORKER_AUTOSTART:'false'`, `CLAUDE_MEM_PROJECT_ENVIRONMENTS` `**/home/cwd`), `startWorker` via `bun worker-service.cjs start`, `stopWorker`; scaffold `plugin/evals-token-savings/prepare-workspace.sh` symlinks `$HOME/.claude-mem` → data dir |

### 3.4 `claude plugin eval` (claude 2.1.290 `--help` + https://code.claude.com/docs/en/plugin-evals.md)

- Case = dir with `case.yaml` (`schema_version: "1.1"`, `name`, `tags`, `context.scaffold_script`) and/or `prompt.md` (frontmatter `max_turns`, `timeout_seconds`, `allowed_tools`, `model`; body = prompt), plus `graders/*.md`.
- Grader types: `regex` (`target: last_message|trace|files|{source: file, path}`; `match: contains|not_contains|count:N`), `tool_used` (`tool`, `input_match`, `min`, `max`, `arm`), `tool_order`, `file_exists`, `llm`, `baseline`. `tool_used` counts denied calls too — a deny must be asserted with `regex target: trace` on a marker unique to the deny reason.
- Sandbox: temp HOME, cwd `<sandbox>/home/cwd`, **only the plugin loads**, real hooks run, only `EVAL_*` env reaches the run. Real MCP servers need `--mocks off` + `--allow-tools 'mcp__plugin_claude-mem_mcp-search__*'`.
- Flags used: `--eval-dir`, `--case`, `--tag`, `--runs`, `-j`, `--model`, `--ablation none`, `--scaffold`, `--trust-plugin`, `--mocks off`, `--allow-tools`, `--no-publish`, `--keep-temp`, `--output-dir`, `--max-cost-usd`, `--threshold`, `--json`.
- The `without` ablation arm has **no plugin** — it is not "gate OFF". Gate OFF is its own case against an OFF worker, run with `--ablation none`.

### 3.5 Failure modes the restored gate must avoid (from #1719, #2094, #3106, #3206, #3324, #3480, #3483, #2467 and the agents' reports)

1. Async cannot deny → PreToolUse Read must be **synchronous**.
2. Sync = per-Read latency (measured here: ~0.4 s process floor, 0.6–2.3 s with the worker query) → bounded worker budget, fail open fast, tight host timeout.
3. Never rewrite the Read input (`updatedInput`, `limit:1`) — #1719/#2094 deadlocks.
4. Edit needs a real Read → **targeted reads (offset/limit, partial window) must pass**.
5. Deny only where the routing works: Claude Code main session (not subagents, not Codex/Kimi), code files `smart_outline` parses, files inside the project.
6. `"allow"` skips the permission prompt → the non-gating path must **not** return a decision now that the hook is synchronous.
7. Never recommend Bash edits (not rewindable, bypass hooks).
8. Imperative wording, not question menus (#2467); label titles as history, not file contents (#3324).
9. Keep the mtime ≥ newest-observation bypass (#1719) and exact path/project matching (#2691).
10. Durable toggle in settings.json (+ env + viewer), not hooks.json edits (#2094, #3129).

## 4. Design decisions (locked)

- **D1 — When the gate denies.** ALL of: `input.platform === 'claude-code'`; `CLAUDE_MEM_FILE_READ_GATE_ENABLED !== 'false'`; not a subagent (`agentId` unset — existing skip); single `file_path` input; the language from the shared language map is not `unknown`, `markdown`, `yaml` or `toml` (smart-explore itself says use Read for markdown/config); the resolved path is inside `input.cwd`; size ≥ 1,500 bytes; observations exist; file mtime < newest observation; **and the Read would return the whole file**: `(offset ?? 0) <= 1 && (limit === undefined || limit >= totalLines)`. Otherwise fall through to the context path.
- **D2 — Deny output.** `{ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '', permissionDecision: 'deny', permissionDecisionReason } }`. The deny path records the dedupe claim (result ignored) so a following targeted Read does not re-inject the same timeline. Every whole-file Read of a gated file is denied (the claim does not open a free retry — `455aeaf65` rejected that).
- **D3 — Context path** (gate off, targeted reads, other platforms): unchanged dedupe + timeline, but `hookSpecificOutput` carries **only** `hookEventName` + `additionalContext` — no `permissionDecision`.
- **D4 — Deny reason** (marker line is the eval's trace anchor — keep it verbatim):
  ```
  Current: <formatHeaderDateTime()>
  Full-file Read blocked by claude-mem: <path> has prior observations (listed below). Get what you need without reading the whole file:
  - Current code: call smart_outline(file_path="<path>") for its symbols and line numbers, then smart_unfold(file_path="<path>", symbol_name="<name>") for the ones you need (MCP tools mcp__plugin_claude-mem_mcp-search__smart_outline / __smart_unfold; load them with ToolSearch if they are deferred).
  - Past work: call get_observations(ids=[<IDs>]) for the observations below that matter (~300 tokens each).
  - Exact lines, e.g. before an Edit: call Read on this file again with offset and limit around the lines smart_outline reported. Partial reads are allowed and satisfy Edit's read requirement.
  The titles below are history from earlier sessions, not the file's current contents.
  ### <day>
  <id> <time> <icon> <title>
  ```
  `<path>` is the escaped `safePath` (existing escaping, `file-context.ts:84`). `<IDs>` = the displayed observation IDs, comma-separated.
- **D5 — Hook mode.** Remove `"async": true` from `PreToolUse` `Read` in `plugin/hooks/hooks.json`; host timeout **15 s** pinned through the generator manifest (object form). Worker budget in the handler: `FILE_CONTEXT_WORKER_BUDGET_MS = 3_000` passed as `executeWithWorkerFallback(..., undefined, { timeoutMs })`.
- **D6 — Setting.** `CLAUDE_MEM_FILE_READ_GATE_ENABLED`, default `'true'`, read with `!== 'false'` (only an explicit `'false'` turns it off). Surfaces: SettingsDefaultsManager, SettingsRoutes whitelist + booleanSettings, viewer toggle, docs. Env `CLAUDE_MEM_DISABLE_FILE_CONTEXT=1` stays the kill switch for the whole hook.
- **D7 — Language map.** Move `LANG_MAP` + `detectLanguage` out of `parser.ts` into a dependency-free `src/services/smart-file-read/language-map.ts` (exported), import it in `parser.ts` (no behavior change) and in the handler. Keeps tree-sitter code out of the worker bundle.
- **D9 — Deny only when the smart tools can parse (added during `/do`).** The maintainer's installed 13.31.0 plugin cache has `node_modules/tree-sitter-cli/` without the downloaded `tree-sitter` binary, so `smart_outline` answers "Could not parse" for every file (verified in-session; the repo's own parser with the binary parses the same files). The gate must not route Claude to tools that cannot work: move `resolveTreeSitterBinPath` from `parser.ts` into a dependency-free `src/services/smart-file-read/tree-sitter-bin-path.ts` (re-export from `parser.ts` for existing importers) and add `isTreeSitterCliAvailable()` (resolved absolute path exists, or the bare name is found on `PATH`). Check it last in the predicate (one `existsSync`); unavailable → context path. The hook and the MCP server resolve from the same plugin root, so the hook's answer matches the server's.
- **D8 — Eval location.** Suite `plugin/evals-read-gate/` (sibling convention `plugin/evals-token-savings/`), runner `scripts/eval-read-gate.ts` (bun), npm script `eval:read-gate`, run artifacts in `.scratch/read-gate-eval/<ts>/` (data dirs) and `reports/read-gate/<ts>/` (results) — both already gitignored. Add `plugin/evals-read-gate/results/` to `.gitignore`.

---

## Phase 1 — Setting `CLAUDE_MEM_FILE_READ_GATE_ENABLED` (default `'true'`)

**Copy from:** commit `0d825988e` (`git show 0d825988e -- src/`), and `CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY` at each site below.

1. `src/shared/SettingsDefaultsManager.ts`: add `CLAUDE_MEM_FILE_READ_GATE_ENABLED: string;` to the interface next to the context/welcome booleans (~207-212) and `CLAUDE_MEM_FILE_READ_GATE_ENABLED: 'true',` to `DEFAULTS` (~433-438) with a one-line comment: `// 'false' = never block a full-file Read; the file's observation timeline is still added as context`.
2. `src/services/worker/http/routes/SettingsRoutes.ts`: add the key to `settingKeys` (beside line 280) and `booleanSettings` (beside 464).
3. Viewer: `src/ui/viewer/constants/settings.ts` (`'true'` beside line 40), `src/ui/viewer/types.ts` (optional string beside 123), `src/ui/viewer/components/ContextSettingsModal.tsx` — a `ToggleSwitch` in the toggle group at 636-651: `id="file-read-gate"`, label `Block full-file reads`, description `Send Claude to smart_outline/smart_unfold and past observations instead of reading whole files that have history`, `checked={formState.CLAUDE_MEM_FILE_READ_GATE_ENABLED !== 'false'}`, `onChange={() => toggleBoolean('CLAUDE_MEM_FILE_READ_GATE_ENABLED')}`. Check how `toggleBoolean` flips (173-177) so an unset value toggles to `'false'`.
4. Tests (copy `tests/shared/welcome-hint-default.test.ts:34-54` and `tests/worker/http/routes/settings-routes-session-start-sources.test.ts:12-51`): default resolves to `'true'`; POST `'false'` persists; POST `'maybe'` → 400.

**Verify:** `bun test tests/shared tests/worker/http/routes` green; `grep -n CLAUDE_MEM_FILE_READ_GATE_ENABLED src -r` shows all 6 sites.
**Guards:** no new settings plumbing, no migration (loadFromFile overlays DEFAULTS), no `=== 'true'` reads (default must survive missing/odd values).

## Phase 2 — Handler: restore the deny gate

**Copy from:** deny return shape `git show c21e49d9f:src/cli/handlers/file-context.ts` (end of `execute`); routing bullets from the same file's `formatFileTimeline`; platform check `src/cli/handlers/context.ts:76,93-99`.

1. Create `src/services/smart-file-read/language-map.ts` exporting `LANG_MAP` and `detectLanguage` (moved verbatim from `parser.ts:38-85`); `parser.ts` imports them. No behavior change in parser.
2. `src/cli/handlers/file-context.ts`:
   - Split `buildFileContextTimeline` into a lookup that returns `{ observations (deduped/ranked), newestObservationMs, absolutePath, relativePath, totalLines? }` or `null` (stat/size/ENOENT, query with `{ timeoutMs: FILE_CONTEXT_WORKER_BUDGET_MS }`, malformed body, empty, mtime staleness — all unchanged), and keep the claim + format at the call site.
   - Gate predicate per D1 (pure function, unit-testable). Count lines only when every cheaper condition already holds (read the file once, count `\n`).
   - Deny per D2/D4; context path per D3 (drop `permissionDecision: 'allow'`).
   - Rename `FILE_READ_GATE_MIN_BYTES` only if it reads wrong after the change (it still gates both paths — keep the name).
3. `src/cli/types.ts`: no change expected (fields exist). Confirm.
4. Tests in `tests/hooks/file-context.test.ts` (keep the existing fetch-spy + temp-file pattern; use a `.ts` fixture ≥ 1,500 bytes for gated cases, the existing `test.md` for the not-gated markdown case; mock `hook-settings.js` with a flippable value per `summarize-advisor-capture.test.ts`, keeping `CLAUDE_MEM_EXCLUDED_PROJECTS`):
   - denies a whole-file Read on `platform: 'claude-code'` (reason contains `Full-file Read blocked by claude-mem`, `smart_outline(file_path=`, `smart_unfold(`, `get_observations(ids=[`, the observation ID, `history from earlier sessions`; `additionalContext === ''`);
   - setting `'false'` → no deny, timeline in `additionalContext`, no `permissionDecision`;
   - platform `codex`, `kimi`, undefined → no deny (context path);
   - `offset: 40, limit: 20` → no deny; `limit` ≥ total lines → deny; `offset: 1, limit: <total lines>` → deny;
   - `.md`, `.json`, `.yaml` → no deny;
   - path outside cwd → no deny; file < 1,500 bytes → nothing; mtime ≥ newest observation → nothing; worker fallback → nothing; subagent → nothing;
   - two consecutive whole-file Reads in one session → both denied; a targeted Read after a deny → no duplicate `additionalContext`;
   - update existing assertions that expected `permissionDecision: 'allow'` (e.g. ~156, 189-191, 252-268).
   - `tests/hook-command.test.ts:154-194` (handler error → no-op, never deny) stays green.

**Verify:** `bun test tests/hooks/file-context.test.ts tests/hook-command.test.ts tests/hook-lifecycle.test.ts tests/worker/kimi-read-file-path.test.ts` green; `grep -n "permissionDecision: 'allow'" src/cli/handlers/file-context.ts` → nothing.
**Guards:** no `updatedInput`; no exit 2; no stdout/stderr/console in the handler (hook-io discipline, `scripts/check-hook-io-discipline.cjs`); no new HTTP endpoint; no in-memory per-session state; don't touch Codex `filePaths` behavior.

## Phase 3 — Synchronous hook + bounded timeout

1. `plugin/hooks/hooks.json` PreToolUse `Read` entry: delete `"async": true`, set `"timeout": 15`.
2. `scripts/build-hooks.js:149`: `'PreToolUse.0.0': { command: claudeHook(['hook', 'claude-code', 'file-context']), timeout: FILE_CONTEXT_HOOK_TIMEOUT_SECONDS }` with `const FILE_CONTEXT_HOOK_TIMEOUT_SECONDS = 15;` and a comment (copy the UserPromptSubmit block at 100-104/141-144): synchronous so the File Read Gate can deny; bounded well under the old 60 s.
3. `tests/infrastructure/plugin-distribution.test.ts`: move PreToolUse out of the async test (507-528) into a synchronous assertion (`not.toHaveProperty('async')`, pattern 549/552); mirror the object form in `RULE_A_EXPECTATIONS` (603); add a timeout test like 657-668 (timeout 15 and `> FILE_CONTEXT_WORKER_BUDGET_MS / 1000 + 5`).
4. `npm run build` (must not report a template mismatch); confirm `grep -c "Full-file Read blocked by claude-mem" plugin/scripts/worker-service.cjs` ≥ 1.

**Verify:** `bun test tests/infrastructure/plugin-distribution.test.ts` green; `node -e` read of hooks.json shows PreToolUse Read without `async`, timeout 15.
**Guards:** don't touch other hooks' `async`; don't change Codex hooks; don't hand-edit `plugin/scripts/*.cjs`.

## Phase 4 — Docs

1. `docs/public/file-read-gate.mdx`: rewrite to current behavior — default ON, Claude Code only, whole-file vs targeted reads, code-file scope (not markdown/yaml/toml), mtime/size/subagent/outside-project bypasses, the D4 sample message, the decision table (keep), "How to turn it off": settings.json `"CLAUDE_MEM_FILE_READ_GATE_ENABLED": "false"`, the viewer toggle, or env; note `CLAUDE_MEM_DISABLE_FILE_CONTEXT=1` disables the whole hook. Remove the wrong "remove the matcher from ~/.claude/settings.json" and "user can override the deny" claims. Mention the hook is synchronous (15 s cap, 3 s worker budget, fails open).
2. `docs/public/configuration.mdx`: Core Settings row (format of line 24); hook list bullet (~369) and hook timeouts (~680: PreToolUse 15 s, synchronous).

**Verify:** `grep -n "remove the entry with the" docs/public/file-read-gate.mdx` → nothing; mdx frontmatter intact.

## Phase 5 — Evals (proof)

### 5.1 Fixture + suite `plugin/evals-read-gate/`

- `fixture/src/shipping/rate-calculator.ts`: realistic TypeScript, 400–600 lines (≥ 12 KB), ~15 exported functions/classes. One function, `calculateRemoteAreaSurcharge`, holds two distinctive values that appear nowhere else and are not guessable: rate `0.137` (13.7 %) and minimum fee `4.85`. Other functions use different numbers.
- `seed-observations.json`: 4 observations about `src/shipping/rate-calculator.ts` (cwd-relative `files_read`/`files_modified`), titles that hint at structure but never state the two values (e.g. "Remote-area surcharge applies a percentage with a minimum fee").
- `scaffold-gate-on.sh` / `scaffold-gate-off.sh` (copy `prepare-workspace.sh` shape): `set -euo pipefail`; resolve repo root; read `.scratch/read-gate-eval/active-data-dir-on|off` (fail loud if missing); refuse if `$HOME/.claude-mem` exists; copy `fixture/` into cwd; `touch -t 202601010000` every fixture file (mtime older than the seeded observations); `ln -s <data dir> "$HOME/.claude-mem"`.
- Cases (`case.yaml` + `prompt.md` + `graders/`), all `schema_version: "1.1"`, tags `gate-on` / `gate-off`:
  1. `gate-on-answers-question` (scaffold on). Prompt: "What rate and minimum fee does calculateRemoteAreaSurcharge in src/shipping/rate-calculator.ts apply? Give the exact numbers." `allowed_tools: [Read, Glob, Grep, ToolSearch]`, `max_turns: 15`. Graders: `read-blocked` (regex, target trace, pattern `Full-file Read blocked by claude-mem`); `answer-rate` (regex `13\.7|0\.137`); `answer-minimum` (regex `4\.85`).
  2. `gate-on-edits-file` (scaffold on). Prompt: "In src/shipping/rate-calculator.ts change the remote-area minimum fee from 4.85 to 5.25. Change nothing else." `allowed_tools: [Read, Edit, Glob, Grep, ToolSearch]`. Graders: `read-blocked` (trace marker); `edited` (regex, target `{source: file, path: src/shipping/rate-calculator.ts}`, `5\.25`); `old-value-gone` (same target, `4\.85`, `match: not_contains`).
  3. `gate-off-reads-normally` (scaffold off). Same prompt as 1. Graders: `not-blocked` (trace marker, `match: not_contains`); `read-used` (`tool_used`, `tool: Read`, `min: 1`); answer graders as in 1.
- `README.md`: what it proves, how to run, cost note, how to read the summary.

### 5.2 Runner `scripts/eval-read-gate.ts` (bun) + `package.json` `"eval:read-gate": "bun scripts/eval-read-gate.ts"`

1. Args: `--runs` (default 3), `--model` (default `claude-sonnet-5-5`), `-j` (default 3), `--max-cost-usd` (default 10), `--case` passthrough, `--preflight-only`.
2. Require built `plugin/scripts/worker-service.cjs` containing the deny marker (fail loud: "run npm run build").
3. Create `.scratch/read-gate-eval/<ts>/{on,off}`; for each: free port; `settings.json` per the eval-week-worker pattern (`CLAUDE_MEM_WORKER_PORT`, `CLAUDE_MEM_WORKER_AUTOSTART:'false'`, `CLAUDE_MEM_PROJECT_ENVIRONMENTS: [{name:'read-gate-eval', patterns:['**/home/cwd','**/home/cwd/**']}]`, `CLAUDE_MEM_FILE_READ_GATE_ENABLED: 'true'|'false'`, `CLAUDE_MEM_SKIP_TOOLS` listing every tool the cases use incl. the four `mcp__plugin_claude-mem_mcp-search__*` tools so the eval never queues observer work, `CLAUDE_MEM_SEMANTIC_INJECT:'false'`, `CLAUDE_MEM_LOG_LEVEL:'DEBUG'`, `CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH` inside the data dir); `telemetry.json` disabled. Seed `claude-mem.db` with `SessionStore` (project `read-gate-eval`, observation epoch = now − 1 day). Start each worker: `bun plugin/scripts/worker-service.cjs start` with env stripped of inherited `CLAUDE_MEM_*`, `CLAUDE_MEM_DATA_DIR=<dir>`, `CLAUDE_MEM_WORKER_AUTOSTART=true`; require `"status":"ready"`.
4. **Pre-flight (deterministic, no model):** for each arm, build `<arm>/preflight/home/cwd` with the fixture (old mtime) and `home/.claude-mem` → data dir; pipe a PreToolUse JSON (`tool_name: Read`, `tool_input.file_path` absolute fixture path, `cwd`, `session_id`) into `node plugin/scripts/bun-runner.js plugin/scripts/worker-service.cjs hook claude-code file-context` with `HOME=<arm>/preflight/home`; assert ON → `permissionDecision: "deny"` + marker + seeded IDs; OFF → no `permissionDecision`, `additionalContext` contains the timeline. Also assert ON + `offset/limit` → no deny. Record each hook's wall time (latency evidence). `--preflight-only` stops here.
5. Write `active-data-dir-on|off`; run `claude plugin eval ./plugin --eval-dir evals-read-gate --scaffold --trust-plugin --mocks off --allow-tools 'mcp__plugin_claude-mem_mcp-search__*' --ablation none --no-publish --keep-temp --runs N -j J --model M --max-cost-usd C --threshold 0 --output-dir reports/read-gate/<ts>/eval`.
6. Analyze each run's trace (`tracePath`, `chmod -R u+rwx` its sandbox first): per run count whole-file Read attempts on the fixture, how many were denied (tool_result `is_error` + marker), how many succeeded, targeted Reads, calls to `smart_outline` / `smart_unfold` / `get_observations`, turns, `costUsd`, grader results. Copy traces into the report dir.
7. Verdict + `reports/read-gate/<ts>/summary.{md,json}`:
   - gate ON: every run has 0 successful whole-file Reads of the fixture; every run that attempted one saw the deny; answer graders pass in ≥ 2/3 of runs; edit case leaves `5.25` and no `4.85` in ≥ 2/3 of runs.
   - gate OFF: 0 deny markers; ≥ 1 successful Read per run; answer graders ≥ 2/3.
   - Report mean cost/turns per arm and hook latency from the pre-flight (informational, not a gate).
   - Exit non-zero if any verdict fails.
8. Always stop both workers (`worker-service.cjs stop`, then kill anything still using the data dir — copy `stopWorker`), and remove the `--keep-temp` sandboxes it created.
9. `scripts/tests/` or `tests/` unit test for the pure trace-analysis function (fixture trace lines: denied whole Read, targeted Read, smart_outline call).

### 5.3 Run it and record the proof

- `npm run eval:read-gate -- --preflight-only` → must pass first.
- `npm run eval:read-gate` (defaults). If a verdict fails, fix the cause (wording, predicate), rebuild, rerun — don't loosen verdicts without saying why in the README.
- Paste the summary table into `plugin/evals-read-gate/README.md` ("Last run": date, claude version, model, runs, per-arm numbers) and into the PR body.

**Guards:** never point an eval at the user's real `~/.claude-mem` or default worker port; never write outside the repo except Claude Code's own eval sandboxes; no `/tmp` paths in our scripts (`.scratch/` only); no mocks for the gate cases (real worker + real MCP server).

## Phase 6 — Verification

1. `npm run build` clean; `bun test tests` — every failure must be pre-existing: for any failing file, run the same file on `main` (`git worktree add .scratch/main-baseline main`, then remove it) and show it fails there too.
2. `node scripts/check-hook-io-discipline.cjs` passes.
3. Anti-pattern greps: `grep -rn "updatedInput" src/cli/handlers/file-context.ts` → none; `grep -n '"async": true' plugin/hooks/hooks.json` shows PostToolUse/PostToolUseFailure/Stop/SessionEnd/SessionStart-start only; no `/tmp/` literals in new scripts.
4. Eval summary verdicts all PASS.
5. `qa-agent` on the diff → PASS (fix BLOCK findings).

## Ship

`/do` commits per phase on this branch → push → PR (title `feat(hooks): restore the File Read Gate as a default-on setting, with evals`) with the eval summary → `/babysit` until green and review-clean → merge → `/version-bump` (minor: new user-visible behavior + setting).
