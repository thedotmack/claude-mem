# Cynical Deletion Plan — 29 issues → ~7 deletions

**Date:** 2026-04-25
**Branch:** `claude-mem-skill-invocation-and-github-issue-2139`
**Source:** Triage of all 29 open issues for `thedotmack/claude-mem` applied with delete-first lens.

## Headline

The codebase has accumulated **defenders** (orphan cleanup → duplicate detection → restart-port-stealing) and **tolerators** (silent JSON drops, drifted SQL/SSE filters, silent metadata drops). Each defender breeds two more bugs; each tolerator hides the bug it tolerates until it explodes as a "regression." The work is **deleting the moats**, not patching them.

## Coverage map (29 issues)

| Phase | Action | Closes |
|---|---|---|
| P1 | DEL-1 + DEL-2: process-management theater + shell-string spawning | #2090, #2095, #2107, #2111, #2114, #2117, #2135, #2123, #2097 |
| P2 | DEL-9: observer-sessions trust boundary (`CLAUDE_MEM_INTERNAL` env) | #2126, #2118 |
| P3 | CON-2 + DEL-7: multi-account commit, port/path de-hardcoding | #2103, #2109, #2101 |
| P4 | CON-1: extend env sanitizer to proxy vars | #2115, #2099 |
| P5 | FF-1: fail-fast cleanup | #2089, #2094, #2116 |
| P6 | DEL-4 + DEL-5 + DEL-6 + DEL-8: small deletions | #2113, #2087, #2127, #2098, #2054 |
| P7 | #2106 install fixes (UX + shutdown-before-overwrite + uninstall coverage + real-port query) | #2106 |
| P8 | DEL-3 lite: pin chroma-mcp deterministically (full sqlite-vec migration deferred) | #2046, #2085, #2102 |
| P9 | Verification + close-as-dup/already-fixed | #2112, #2123→#2135, #2097→#2135, #2098→#2127, #2126 (closed by P2) |

---

## Phase 0 — Documentation Discovery (DONE)

### Allowed APIs (verified)

- `child_process.spawn(cmd, [args], { detached, stdio, env })` — Node API used in `ProcessManager.ts`. Bun.spawn does NOT support `detached:true` (per `process-registry.ts:633-639` comment). Use Node `child_process` for daemon spawning.
- `Bun.spawn([args], { env })` — used for non-detached children (e.g. `chroma-vector-sync.test.ts:25`). Arg-array form bypasses shell on all platforms.
- `Agent SDK query({ cwd, env, spawnClaudeCodeProcess })` — used by `SDKAgent.ts:145-163` and `KnowledgeAgent.ts:75-84`. Custom `spawnClaudeCodeProcess` lets us inject env vars into the spawned `claude` subprocess.
- `sanitizeEnv()` from `src/supervisor/env-sanitizer.ts` — currently strips `CLAUDE_CODE_*` and `CLAUDECODE_*` (preserve list: `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_GIT_BASH_PATH`).
- `SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT')` — canonical port reader. Default: `37700 + (uid % 100)`.
- `paths.ts` exports: `DATA_DIR`, `OBSERVER_SESSIONS_DIR`, `OBSERVER_SESSIONS_PROJECT`, `USER_SETTINGS_PATH`, `DB_PATH`. All resolve under `CLAUDE_MEM_DATA_DIR` if set.
- Hook exit-code contract (CLAUDE.md:48-58): exit 0 = success, exit 1 = non-blocking error, exit 2 = blocking error. Worker errors should exit 0 to prevent Windows Terminal tab accumulation.

### Anti-patterns to avoid

- **Don't** invent shell-string variants of spawn. Use arg-array form everywhere. PowerShell `-EncodedCommand` and quoting heuristics are deletable once we stop building shell strings.
- **Don't** add new defender code (orphan janitors, duplicate-worker probes, retry-with-backoff loops). The existing defenders are what we're removing.
- **Don't** add new config knobs (env-passthrough whitelist, configurable timeout). Fix the default instead.
- **Don't** add tolerators (`|| true`, silent JSON drops, `.passthrough()` schemas that drop fields). Fail loud or accept the input.
- **Don't** start a sqlite-vec migration in this plan. It's a separate plan with its own discovery.

### Surprising findings worth re-verifying mid-plan

- **#2090/#2095** may already be fixed: `session-init.ts:78` returns `EXIT_CODE.SUCCESS` on worker-unreachable. Verify against the issue's repro before patching.
- **#2115** root cause confirmed: `sanitizeEnv` does NOT strip `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`. Extend the sanitizer; don't add a passthrough knob (#2099).
- **#2094** `file-context.ts:184,196` truncation is intentional token economics. The bug is that the truncated Read return value confuses Claude into infinite Edit retries. Fix: don't return a partial Read result from a hook — emit an injected-context note instead, or let the full Read happen.
- **#2126** items 2, 3, 4, 6 collapse into the P2 trust-boundary fix. Items 1 (basename glob) and 5 (cleanup CLI extension) are real but small.

---

## Phase 1 — Delete process-management theater (DEL-1 + DEL-2)

**Closes:** #2090, #2095, #2107, #2111, #2114, #2117, #2135, #2123, #2097

### What to delete

1. **`aggressiveStartupCleanup()`** at `src/services/infrastructure/ProcessManager.ts:659-727`. Including:
   - Windows WQL filter block (lines 563-606) — deletable; PowerShell WQL bug (#2114) disappears
   - Linux/macOS `ps -eo pid,etime,command | grep` block (lines 607-644)
   - `AGGRESSIVE_CLEANUP_PATTERNS` and `AGE_GATED_CLEANUP_PATTERNS` constants
   - `ORPHAN_MAX_AGE_MINUTES` constant
   - All callers of `aggressiveStartupCleanup` (grep for usage; expected: `worker-service.ts` startup)
2. **PowerShell `-EncodedCommand` wrapper** at `ProcessManager.ts:944-1041`. Replace with `child_process.spawn(cmd, [args], { detached: true, stdio: 'ignore', windowsHide: true })`. Arg-array form bypasses shell on Windows, no quoting needed. The `setsid` Unix wrapper stays (it's correct).
3. **Restart-with-port-steal sequence** at `worker-service.ts:1154-1175`. Replace with: try `httpShutdown(port)` → if port still bound after 5s, log error and exit 1 (let user resolve). Don't loop. Don't kill PID by force. The user sees the error and acts.
4. **Worker-cli duplicate-worker self-detection.** Read `src/cli/worker-cli.js` (or wherever the restart entry-point lives). Find the path that triggers duplicate detection on a `restart` command and remove it. The PID file owns the lock; restart should atomically swap.

### What stays

- **`verifyPidFileOwnership()`** at `process-registry.ts:160-182` and `captureProcessStartToken()` at lines 94-146 — these are correct. PID file with start-time token is exactly the OS-trust pattern we want.
- **The PID file itself** at `~/.claude-mem/worker.pid` (or `$DATA_DIR/worker.pid`). This is the lock.
- **`waitForPortFree()`** with a short timeout — used to confirm shutdown completed. Stays.

### Implementation steps

1. `git grep -n aggressiveStartupCleanup` → list every callsite. Delete the function and every callsite. Run `npm run build-and-sync`.
2. Replace daemon-spawn body in `ProcessManager.ts:944-1041`:
   - Single platform-uniform path: `child_process.spawn(execPath, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()`
   - Keep `setsid` wrapper on Unix when available (process-group cleanup on parent death).
   - Delete the PowerShell branch entirely.
3. Rewrite `worker-service.ts:1154-1175` restart case:
   ```
   await httpShutdown(port)
   const free = await waitForPortFree(port, 5000)
   if (!free) {
     console.error('Port still bound after shutdown. Resolve manually.')
     process.exit(1)
   }
   removePidFile()
   spawnDaemon(__filename, port)
   ```
4. Re-verify #2090/#2095 are already fixed by reading `session-init.ts:30-80`. If yes, log "no-op" in plan execution notes. If the original repro still fires, add `|| true`-equivalent at the hooks.json shell wrapper layer (NOT in the handler itself).
5. Confirm #2117 (cleanup SIGKILLs own ancestors) goes away once cleanup is deleted.

### Verification

- `git grep aggressiveStartupCleanup` returns zero hits.
- `git grep -E "EncodedCommand|powershell.*Start-Process"` returns zero hits in `src/`.
- Manual: kill worker, restart, confirm clean restart. Spawn 3 workers in parallel from different shells, confirm 2 fail with PID-file-owned errors and the first one wins (no kill cascade).
- Windows VM (or CI): username with space (`C:\Users\Alex Newman\`) — confirm spawn works without quoting drama. Closes #2135/#2123/#2097.
- Manually verify #2094 is NOT regressed (separate concern; covered in P5).

### Anti-pattern guards

- Don't add a "lighter" cleanup. There is no lighter cleanup. The OS owns process lifecycle.
- Don't add a "warn user about orphan workers" branch. If orphans exist, they're someone else's bug.
- Don't add platform branches in the spawn code beyond the existing `setsid` check.

---

## Phase 2 — Observer-sessions trust boundary (DEL-9)

**Closes:** #2126 (items 2, 3, 4, 6 by deletion; items 1, 5 by small fix), #2118

### What to do

Replace the `cwd === OBSERVER_SESSIONS_DIR` discriminator pattern (which has to be repeated by every consumer and inevitably drifts) with a single env-var trust boundary.

### Implementation steps

1. **Set the env var at every spawn site:**
   - `src/services/worker/SDKAgent.ts:113` (`buildIsolatedEnv`) — add `CLAUDE_MEM_INTERNAL: '1'` to the returned env.
   - `src/services/worker/knowledge/KnowledgeAgent.ts:73` — same.
   - Confirm both call `Agent SDK query()` with `env: isolatedEnv` so the spawned `claude` subprocess inherits.

2. **Check the env var first in `shouldTrackProject`:**
   - `src/shared/should-track-project.ts:35-44` — first line of function: `if (process.env.CLAUDE_MEM_INTERNAL === '1') return false;`
   - Keep the existing `isWithin(cwd, OBSERVER_SESSIONS_DIR)` check as a belt-and-braces fallback.

3. **Delete now-redundant filters:**
   - `src/services/worker/PaginationHelper.ts:115-117` — keep (UI hides observer rows; harmless).
   - `src/services/worker/PaginationHelper.ts:178` — change hardcoded string `'observer-sessions'` to `OBSERVER_SESSIONS_PROJECT` const for consistency. Tiny fix.
   - `src/services/worker/SSEBroadcaster.ts:45-60` — add the SAME filter that SearchManager uses (`SearchManager.ts:194`). Don't invent a new one. Extract the filter predicate to a shared helper used by both. Closes #2118.

4. **#2126 item 1 (basename glob fix):** Read the issue's exact bug. Likely `EXCLUDED_PROJECTS` matches by full path instead of basename. Fix in the matcher; one-liner.

5. **#2126 item 5 (cleanup CLI):** Extend `src/services/infrastructure/CleanupV12_4_3.ts:185-205` to take a `--dry-run` and report counts. Don't write a new CLI; add the flag to existing.

### Verification

- Add a test: spawn `SDKAgent`, verify the spawned subprocess has `CLAUDE_MEM_INTERNAL=1` in its env.
- Add a test: `shouldTrackProject('/any/path')` with `CLAUDE_MEM_INTERNAL=1` set returns `false`.
- Manual: trigger an observer session, confirm zero new rows under user's project in the DB.
- SSE: connect a client to `/api/events`, trigger an observer session, confirm no observer events on the SSE stream.

### Anti-pattern guards

- Don't add a `CLAUDE_MEM_OBSERVER_SESSION_DIR` env override (#2126 item 2). `CLAUDE_MEM_DATA_DIR` already overrides; the observer dir is derived.
- Don't add per-consumer filter knobs. One trust boundary, two existing filters (PaginationHelper, SSE), shared helper.

---

## Phase 3 — Multi-account commit + port/path de-hardcoding (CON-2 + DEL-7)

**Closes:** #2103, #2109, #2101

Discovery showed multi-account is ~80% there: `DATA_DIR` is fully overridable, per-UID port already exists, PID files are DATA_DIR-relative. The remaining gap is 8 hardcoded `37777` literals + hooks.json bare-port assumption.

### What to do

1. **Eliminate every hardcoded `37777`:**
   - `src/ui/viewer/constants/settings.ts:8` — change to read from settings/env at runtime if possible; otherwise leave as build-time default (least bad).
   - `src/npx-cli/commands/runtime.ts:154`, `install.ts:545`, `uninstall.ts:109` — replace fallback with `SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT')`.
   - `src/integrations/opencode-plugin/index.ts:97` — same. Read from settings.
   - `src/services/integrations/OpenClawInstaller.ts:171` — drop the default; require the caller to pass it.
   - `plugin/skills/timeline-report/SKILL.md:23,53` — replace literal with `${CLAUDE_MEM_WORKER_PORT:-37700}` or instruct the skill to read from settings.json. Closes #2103.

2. **Fix hooks.json port handling for #2109:**
   - `plugin/hooks/hooks.json` — every hook command needs to either (a) inherit the port from env or (b) read from settings.json. Update the `bun-runner.js` wrapper to do this once.
   - On Windows + Git Bash, ensure POSIX path → Windows path conversion happens before passing to `node.exe`. The `bun-runner.js` wrapper is the right place.

3. **Multi-account commit:**
   - Document in CLAUDE.md: multi-account works by setting `CLAUDE_MEM_DATA_DIR=/path/to/account-N` per shell. All paths derive from it. Per-UID port collision is handled automatically.
   - Add a one-line CLI command: `claude-mem profile use <name>` that exports the right env vars (or just print the export command for user to eval).
   - Close #2101 with documentation pointing at the above.

### Verification

- `git grep -nE "37777" src/ plugin/` returns only the build-time default in `settings.ts`.
- Run two workers in parallel under different `CLAUDE_MEM_DATA_DIR` values; both bind successfully on different ports; both have separate PID files; both serve separate SSE streams.
- Run timeline-report skill against a non-default port; it picks up the right port from settings.

### Anti-pattern guards

- Don't add a "discover running workers on common ports" probe. The settings.json port is the source of truth.
- Don't add a `--port` flag to every CLI command. The env / settings.json owns it.

---

## Phase 4 — Extend env sanitizer (CON-1)

**Closes:** #2115, #2099

### What to do

1. `src/supervisor/env-sanitizer.ts` — extend `ENV_PREFIXES` and/or add a `PROXY_VARS` set that strips:
   - `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (and lowercase variants)
   - Optionally: `npm_config_proxy`, `npm_config_https_proxy`
2. Decide whether the strip should be unconditional or opt-in. Default: unconditional. Worker spawns `claude` for internal AI calls; the user's proxy config should not bleed in.
3. **Reject #2099's passthrough-whitelist feature.** Close with: "we now strip proxy vars by default; if you have a real use case for letting them through, file a new issue with details."

### Verification

- Set `HTTPS_PROXY=http://bad-proxy:1234` in the worker shell. Spawn an SDK subprocess. Confirm the subprocess's env does NOT contain `HTTPS_PROXY`. Add a test for this.
- `git grep -n "HTTP_PROXY\|HTTPS_PROXY"` shows the sanitizer is the only place that knows about them.

---

## Phase 5 — Fail-fast cleanup (FF-1)

**Closes:** #2089, #2094, #2116. **#2118 is closed by P2.**

### #2089 — stdin-reader silent drop

`src/cli/stdin-reader.ts:156-164` — `onEnd` resolves with `undefined` even on parse failure. Change to: if input is non-empty AND parse fails, throw or call the safety-timeout error path. Match what the issue asks for: distinguish "no input" from "malformed input." Document in the function header.

### #2094 — PreToolUse:Read truncation causes Edit deadlock

`src/cli/handlers/file-context.ts:141-143, 184, 196` — the truncation is intentional (token economics), but returning a truncated Read result confuses Claude. Fix:

- Hooks should not return modified Read results. They can inject context as `additionalContext` or skip entirely.
- Audit what the handler returns to Claude Code. If it returns a fake Read response with 1 line, that's the bug. It should either return `{ continue: true }` (let the real Read happen) or inject context via `additionalContext` field.
- Read Claude Code's PreToolUse hook contract for what fields are allowed in the response.

### #2116 — `/api/memory/save` silently drops metadata

`src/services/worker/http/routes/MemoryRoutes.ts:16-20, 38-67` — the schema uses `.passthrough()` which keeps unknown fields, but discovery suggests fields are dropped at insert time. Audit:

- Where do the schema's accepted fields get inserted? If only `text/title/project` are in the INSERT statement, the metadata is dropped silently.
- Fix: either accept arbitrary metadata into a `metadata` JSON column, or reject requests with unknown fields (`.strict()` instead of `.passthrough()`). Pick one. Default: accept into a JSON column.
- The "force project to plugin's own project" line at `MemoryRoutes.ts:40` (`const targetProject = project || this.defaultProject`) is fine. It uses caller's value if provided. Verify the issue reporter wasn't omitting `project` field.

### Verification

- Test: `POST /api/memory/save` with `metadata: { foo: 'bar' }` — confirm the data is retrievable.
- Test: malformed JSON to stdin-reader fires error, not silent undefined.
- Manual: trigger PreToolUse:Read on a large file — confirm Edit succeeds afterward (no deadlock).

---

## Phase 6 — Small deletions (DEL-4 + DEL-5 + DEL-6 + DEL-8)

### DEL-4 — Un-bundle Zod from hook scripts (#2113)

- `scripts/build-hooks.js:163-171, 203-230, 294` — add `'zod'` to the `external` list for hook builds.
- If hooks need validation, write a 20-line shape check (`typeof x.foo === 'string'` etc.). Don't reach for Zod for hook input.
- Audit `src/hooks/` for Zod imports; replace with hand-rolled checks.
- Worker (`worker-service.cjs`) can still bundle Zod — the conflict is only in hook-bundled scripts loaded by OpenCode.

**Verification:** `node -e "require('./plugin/scripts/<hook>.js')"` shows no Zod in the bundle. Run with OpenCode hook environment; #2113's TypeError doesn't reproduce.

### DEL-5 — Delete GeminiAgent fallback (#2087)

- `src/services/worker/GeminiAgent.ts:130-132` — delete `setFallbackAgent`.
- `src/services/worker/GeminiAgent.ts:365` — delete the `if (this.fallbackAgent)` branch. On 429: log + throw.
- `src/services/worker/OpenRouterAgent.ts:79-81` — same.
- `tests/gemini_agent.test.ts:279, 313` — delete the fallback tests; add an explicit "429 throws" test.
- Update docs anywhere that mentions Gemini-falls-back-to-Claude (it never did in production).

### DEL-6 — Delete the 4-hour session timeout knob request (#2127, #2098)

- Find `MAX_SESSION_WALL_CLOCK_MS` (likely `src/services/worker/sessions/SessionManager.ts` or similar). Read the surrounding code: what does the timeout do? (Likely cleanup of stale sessions.)
- If the timeout is arbitrary: raise to 24h or remove. Document why.
- If the timeout exists for a real reason (memory pressure, abandoned sessions): document the reason in code, raise to a value nobody hits in practice, and close both issues with the explanation.
- Close #2098 as dup of #2127.

### DEL-8 — Delete `installCLI()` alias (#2054)

- `plugin/scripts/smart-install.js:345-395` — delete `installCLI` function.
- `plugin/scripts/smart-install.js:633` — delete the call.
- `src/npx-cli/commands/uninstall.ts` — add a one-time legacy-alias-strip pass:
  - Read `~/.bashrc`, `~/.zshrc`, `~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1`.
  - Remove any line matching `^alias claude-mem=` or `^function claude-mem`.
  - Print "Removed legacy claude-mem alias from <file>" so users know.
- Update README + docs: canonical entry points are `npx claude-mem <cmd>` and `bunx claude-mem <cmd>`.

**Verification:** Fresh install creates no shell-config mutations. Existing user with the alias runs uninstall — alias is gone. `which claude-mem` after uninstall returns nothing.

---

## Phase 7 — #2106 install fixes (modest scope)

**Closes:** #2106 (items 1, 3, 4, 6 by fix; items 2, 7 by close-as-already-fixed/insufficient-detail; item 5 by documentation).

### Fixes

1. **Item 1 — multiselect default:** `src/npx-cli/commands/install.ts:275-277` — change `initialValues: detected.filter(...).map(...)` to `initialValues: []`. Force explicit opt-in.
2. **Item 3 — install-shutdown-before-overwrite:** Extract `uninstall.ts:109-132` (HTTP shutdown + poll) to `src/services/install/shutdown-helper.ts`. Call it from both `uninstall.ts` and `install.ts` before `copyPluginToMarketplace`.
3. **Item 4 — uninstall path coverage:** `src/npx-cli/commands/uninstall.ts` — add removal of:
   - `~/.npm/_npx/*/node_modules/claude-mem`
   - `~/.cache/claude-cli-nodejs/*/mcp-logs-plugin-claude-mem-*`
   - `~/.claude/plugins/data/claude-mem-thedotmack/`
   - Cascade shutdown to chroma-mcp (call its shutdown endpoint or kill PID).
4. **Item 6 — real port query:** `install.ts:545` — after `smart-install.js` completes, hit `http://127.0.0.1:<settingsPort>/api/health` and report the actually-bound port. If health fails, just print "worker not yet ready" and exit cleanly.
5. **Item 5 — documentation:** Add to install summary output: "Close all Claude Code sessions before uninstalling, or `~/.claude-mem` will be recreated by active hooks."

### Close

- Item 2 (SQLite migration race): closed as already fixed by `ba37b2b2`/`68e92edc`.
- Item 7 (vague SessionStart errors): closed as insufficient detail.

### Verification

- Fresh install on a clean VM: only the IDEs the user explicitly checks are installed.
- Reinstall while worker is running: install succeeds, no "overwrite" loop.
- Uninstall + `find ~/.npm ~/.cache ~/.claude -name "*claude-mem*"` returns empty.
- Install summary prints the actual port when the user has overridden via env or settings.

---

## Phase 8 — Chroma deterministic pinning (DEL-3 lite)

**Closes:** #2046, #2085, #2102

Full sqlite-vec migration is a separate plan (would require replacing the embedding pipeline currently owned by chroma-mcp's bundled SBERT). For this plan: stop using `uvx --with` flags ad-hoc and pin chroma-mcp to a specific version with locked deps.

### Implementation

1. **Pin chroma-mcp version.** `src/services/sync/ChromaMcpManager.ts:200-244` — change `buildCommandArgs()` to invoke a specific pinned version: `uvx --python 3.11 chroma-mcp==<X.Y.Z>` (pick a known-good version that bundles its own deps).
2. **Re-add `--with httpcore --with httpx` ONLY if the pinned version requires them.** Verify by running the pinned command in a clean uvx cache. If the deps are declared properly upstream, the `--with` flags are unnecessary.
3. **Verify #2102 fix is intact:** commit `05114bec` added transport cleanup on timeout, stale onclose handler guard, and 10s reconnect backoff. Read `ChromaMcpManager.ts` to confirm these are still present.

### Decision deferred to a separate plan

- Replacing chroma-mcp with sqlite-vec or a different vector store. This requires picking an embedding strategy (OpenAI? local model?) and rewriting `ChromaSync.ts`. Not in this plan.

### Verification

- Fresh install on a clean machine: `~/.claude-mem/chroma/` populates, `chroma_query_documents` returns results without errors.
- No "No module named 'httpcore'" error in worker logs (closes #2046, #2085).
- Force a chroma-mcp timeout (e.g. kill the subprocess); confirm the worker reconnects after backoff without spawning duplicate subprocesses (closes #2102).

---

## Phase 9 — Verification + close-as-dup

### Cross-cutting verification

1. `git grep -nE "aggressiveStartupCleanup|EncodedCommand|setFallbackAgent|installCLI"` — all return zero hits.
2. `git grep -nE "37777" src/ plugin/` — only the build-time default in `viewer/constants/settings.ts`.
3. Full test suite passes.
4. `npm run build-and-sync` completes; worker starts; SessionStart context injection works (manual test: open a new session, confirm memory recap appears).
5. CI runs on Windows (or manual VM): username with space spawns successfully.

### Close issues

- #2112: already fixed → close with link to fix commit.
- #2123: dup of #2135.
- #2097: dup of #2135.
- #2098: dup of #2127.
- #2126: closed by P2 trust-boundary fix.
- #2099: closed by P4 (proxy strip is the right fix; passthrough whitelist not needed).
- #2101: closed by P3 documentation + multi-account commit.
- #2117: closed by P1 (deletion of aggressive cleanup).
- #2087: closed by P6 (DEL-5).

All other issues close as part of their respective phase verification.

---

## Plan execution order

P1 first (highest leverage; closes 9 issues; reverses regression treadmill). Then P2 (single trust boundary closes 2 issues + prevents future leaks). P3-P8 are independent and can run in parallel by different sessions. P9 last.

If time-constrained, the high-value subset is **P1 + P2 + P5**: kills the two structural patterns (defenders, tolerators) plus the trust-boundary leak. That alone closes 14 of 29 issues with mostly deletions.
