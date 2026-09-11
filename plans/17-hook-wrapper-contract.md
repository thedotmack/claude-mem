# [plan-17] Hook Wrapper Contract — thin, cheap, and fail-open on every host

> **Tracker:** #3605 · **Design doc:** `plans/17-hook-wrapper-contract.md` · **Series:** plan-14 #3602 · plan-15 #3603 · plan-16 #3604 · plan-17 #3605 · plan-18 #3606 · plan-19 #3607 · plan-20 #3608 · plan-21 #3609 · plan-22 #3610 · plan-23 #3611 · plan-24 #3618

## Defect

The seven hook entries in `hooks/hooks.json` (generated from `src/build/hook-shell-template.ts`) are neither thin nor fail-open. Two structural properties of the wrapper produce the whole symptom family:

**It does expensive, fragile work in the shell before any memory code runs.** Every invocation spawns a *second* login shell (`export PATH="$($SHELL -lc 'echo $PATH' 2>/dev/null):$PATH"`) — 250–420 ms on macOS/Linux, 1–10 s on Git Bash where the profile chain sources nvm etc.; the plugin-root discovery is a `{ printf; ls -dt; printf; } | while read … break` pipe whose producers keep writing after `break` closes the read end (`printf: write error: Permission denied` on MSYS, surfaced by Claude Code as a blocking hook error); the login shell shares fd 0 with the hook payload so profile scripts can drain stdin (`[bun-runner] empty stdin payload received — issue #2188`, now on darwin too); the nested `bash.exe` login shell is what pops a console window per tool call on Windows and doubles the concurrent MSYS fork burst that can wedge Git Bash system-wide; `"shell": "bash"` resolves to the WSL launcher when Git Bash isn't first on PATH; older shapes also ran `worker-service start` on all four events. On a PostToolUse `*` matcher this tax runs ~550–3,500×/day.

**When the worker is not reachable, it blocks the user instead of degrading.** The fail-open path returns `{continue:true, reason:"worker_unreachable"}`, but `bC()` first bumps a *global, cross-session* counter (`state/hook-failures.json`) and past `CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD` (default 3, `>=` so it never un-trips) writes to stderr and `exit 2`, which Claude Code treats as a block on UserPromptSubmit, a denial on PreToolUse:Read, and a re-wake loop on Stop; the Stop re-entry guard (`stopHookActive`) is only wired for Codex; the `PreToolUse` command lacks the `|| echo '{"continue":true}'` fallback SessionStart has; `summarize` throws uncaught on a missing transcript. SessionStart and UserPromptSubmit are synchronous with `timeout: 60`, and the internal budget (`HOOK_READINESS_WAIT` 10 s + `API_REQUEST` 30 s, both ×1.5 on Windows) sums to exactly 60 s, so a slow-but-alive worker gets the hook killed instead of returning the fallback; `HealthMonitor.httpRequestToWorker()` `fetch()`es with no `AbortSignal` so a wedged listener consumes the whole budget; the VS Code extension's own 60 s init deadline is exceeded by SessionStart alone.

The fix is a contract: the wrapper resolves nothing it can cache, spawns nothing it doesn't need, never writes to a closed pipe, never touches stdin, never shows a window, and **cannot** return a blocking exit code for a worker-availability failure.

## Children

- #2823 — Every hook reports "Failed with non-blocking status code: No stderr output"; 13.4.0 unusable (maintainer reports fixed on main via #2888/#2889 — verify)
- #2846 — Hook infinite retry loop on summarize event (Permission denied)
- #2903 — [Windows] VS Code extension's 60s init deadline exceeded by claude-mem's slow worker cold-boot
- #2914 — hook error (`printf: write error` + worker unreachable after update)
- #2962 — tracking: DEP0190 and bash PATH probe regressions in npx-cli bundle and hook scripts (PATH-probe half; DEP0190 → plan-16)
- #2966 — tracking: unreachable worker causes Stop hook exit-2 → infinite retry loop blocking all Claude Code prompts
- #2973 — tracking: Windows VS Code extension times out at 60s — SessionStart hooks block on cold worker boot
- #3106 — Add an env var to disable the PreToolUse / PostToolUse hooks (Windows console-window focus theft)
- #3161 — Stop hook exits 2 when worker is unreachable, blocking stop and causing an endless wake loop
- #3167 — Stop hook 'summarize' throws uncaught when transcript_path file is missing
- #3169 — v13.3.0: Stop hook prints 'printf: write error', exits 2 (the `.env` OAuth-token half → plan-19)
- #3186 — Every hook spawns a login shell ($SHELL -lc) to probe PATH — ~250-300ms tax per hook event
- #3190 — Hooks spawn a login shell per invocation — adds ~5–10s to every tool call on Windows (Git Bash)
- #3224 — Windows/Git Bash: hooks exit 2 with misleading 'printf: write error: Permission denied'; worker can't self-heal
- #3246 — Bug Report 一直报错 (UserPromptSubmit blocked by hook)
- #3248 — Windows: claude-mem causes system sluggishness — diagnostic report (process leak + hook overhead)
- #3267 — UserPromptSubmit Hook Blocks Commands Intermittently When Worker Is Probably Not Running
- #3303 — SessionStart/UserPromptSubmit hooks synchronous (async=false, timeout=60); Windows internal budget equals the wire timeout
- #3348 — Windows: per-hook login-shell spawn doubles concurrent bash forks — can break ALL Git Bash system-wide
- #3349 — [macOS] Empty stdin to hooks (same failure as #2188, now on darwin) — silently breaks all memory capture
- #3396 — [Windows] 13.11.0 hooks format ("shell": "bash") reintroduces the console-flash-per-hook regression
- #3412 — bash hooks fail silently on Windows when the default WSL distro is docker-desktop
- #3426 — Windows/Git Bash: hooks intermittently fail with 'printf: write error: Permission denied' (pipe race)
- #3434 — UserPromptSubmit session-init hook blocks up to 60s under worker saturation
- #3449 — Windows: hook wrapper burns ~1.8s per invocation before any memory work
- #3451 — Windows: every hook spawns a login shell just to read $PATH (~420ms × ~550 runs/day)
- #3481 — UserPromptSubmit blocked by claude-mem's own stderr write (worker-unreachable notice)
- #3507 — PostToolUse hook spawns a login shell per tool call (~400ms on Windows/Git Bash)
- #3521 — [Windows] claude-mem hooks spawn visible console windows (~1 per tool call) — other plugins' hooks do not
- #3523 — UserPromptSubmit hook blocks all prompts — worker unreachable for 244 hooks
- #3553 — UserPromptSubmit hook times out after long hibernate (Windows) — fetch() has no timeout
- #3559 — claude-mem hooks (visible shell windows per hook on PowerShell)
- #3563 — UserPromptSubmit hook times out on every run (Windows); redundant worker-service start spawn on all four hook events
- #3568 — PreToolUse:Read exits non-zero when the worker is unreachable, so Claude Code denies the Read tool for the rest of the session

Related PRs to evaluate/rebase: #3519 (guard prelude on `command -v node`), #2917 (drop blocking warmup hook, merged?), #2892 (never block harness), #2885 (per-session sentinel), #2865 (printf trigger, merged), #2888/#2889 (EADDRINUSE loser exits 0), #3099 (bound hook invocations), #2945, #2598, #2715, #3069, bounded-fetch PR from @dajiaohuang (#3553).

## Fix sequence

1. **Prelude does no discovery work in the common path.** `command -v node >/dev/null 2>&1 || export PATH="$(…) </dev/null"` — the login shell runs only when node is missing, with stdin redirected from `/dev/null` and stderr silenced; the resolved PATH and plugin root are cached under `$CLAUDE_MEM_DATA_DIR/resolved-env` (invalidated by plugin version) so steady state forks nothing but `node`. Plugin-root selection moves into `resolvePluginRoot()` (plan-16); the pipe+`break` producer group is replaced by a `for` loop over an array (no writers after the consumer exits) and every remaining producer gets `2>/dev/null`. On Windows the template resolves Git Bash explicitly (`CLAUDE_CODE_GIT_BASH_PATH` → `C:/Program Files/Git/bin/bash.exe`), detects the WSL launcher and bails with a stderr reason, and every spawn from `bun-runner.js`/`worker-service.cjs` (worker start, health probe, detached daemon) sets `windowsHide: true` and no console-attached shell.
2. **Availability failures cannot block.** Introduce a typed exit policy in the hook handler: `blocking_error` (exit 2) is reserved for malformed input from the host; `worker_unavailable`, `worker_wedged`, `setup_required`, `transcript_missing`, `data_dir_unwritable` all return `{continue:true, suppressOutput:true}` + exit 0 with the notice delivered as `systemMessage`/`additionalContext` (once per session, on SessionStart), never via stderr+exit 2. Every `hooks.json` command ends in the fallback echo. `stop_hook_active` is parsed by the claude-code adapter so Stop cannot re-enter. The fail-loud counter becomes per-session, decays, and only ever produces a *message*, never an exit code. `CLAUDE_MEM_DISABLE_TOOL_HOOKS=1` / `CLAUDE_MEM_DISABLE=1` short-circuit before any work.
3. **Budgets strictly inside the wire timeout.** SessionStart is `async: true` (single non-blocking context hook, no `worker-service start`); UserPromptSubmit stays synchronous (it creates the `user_prompts` row downstream hooks depend on) but its readiness wait + request budget is capped at 10 s (`CLAUDE_MEM_SESSION_INIT_TIMEOUT_MS`), never multiplied to the wire timeout; every hook-side `fetch` and `isPortInUse` carries `AbortSignal.timeout()` ≤ 5 s; a liveness miss (plan-15 authority) short-circuits to the fallback in < 1 s instead of waiting the cold-boot window; PostToolUse capture is fire-and-forget after enqueue.
4. **Stdin is read once, defensively.** `collectStdin()` distinguishes "no payload expected" from "payload lost" and logs the latter at ERROR with the parent process name; nothing in the wrapper touches fd 0 before `bun-runner.js`.
5. **Doctor row.** `claude-mem doctor` measures one full hook round-trip (`SessionStart`, `PostToolUse`) and reports wall time, forks, and whether the console-window suppression flag is effective, so regressions are one command away.

## Test matrix

| Host | Shell | Scenario | Required behavior |
|---|---|---|---|
| macOS / Linux | bash, zsh | node on PATH | PostToolUse hook ≤ 60 ms wrapper overhead; zero login shells spawned (strace/dtruss assertion in CI) |
| Linux (distrobox) / macOS | bash with profile that reads stdin | PostToolUse | payload intact; no `empty stdin payload` |
| Windows 10/11 | Git Bash | `CLAUDE_PLUGIN_ROOT` set | no `printf: write error`; wrapper overhead ≤ 300 ms |
| Windows | Git Bash, PowerShell host, Windows Terminal | 50 tool calls | zero visible console windows (Win32 window enumeration in the Windows job) |
| Windows | `bash` = WSL launcher (docker-desktop) | any hook | exit 0 with `{continue:true}` and one stderr line naming the cause |
| all | all | worker stopped | UserPromptSubmit / PreToolUse:Read / Stop each exit 0 with `{continue:true}`; prompt accepted; Read allowed; Stop returns; notice appears once in SessionStart context |
| all | all | worker bound-but-wedged | UserPromptSubmit returns fallback in ≤ 10 s; PostToolUse in ≤ 5 s |
| Windows | VS Code extension | cold start with no worker | SessionStart completes < 5 s; extension init succeeds |
| all | all | Stop with missing transcript file | exit 0, no throw, summary skipped with a WARN |
| all | all | 100 consecutive worker-unreachable hooks | no exit 2 anywhere; counter never blocks |

The matrix lives in CI (`tests/infrastructure/hook-wrapper-contract.test.ts` running the real `hooks.json` commands under each shell + the Windows job with window enumeration). A regression must fail CI before a user can file.

## Out of scope

Deciding whether the worker is alive and reclaiming ports (plan-15). Which plugin root the wrapper resolves (plan-16 owns `resolvePluginRoot()`; this plan only consumes it). Codex/OpenCode host hook schemas (plan-23).
