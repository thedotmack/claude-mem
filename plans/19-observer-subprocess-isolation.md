# [plan-19] Observer Subprocess Isolation — an explicit env, cwd, config, tool set and auth source for the headless generator, with loud degradation

> **Tracker:** #3607 · **Design doc:** `plans/19-observer-subprocess-isolation.md` · **Series:** plan-14 #3602 · plan-15 #3603 · plan-16 #3604 · plan-17 #3605 · plan-18 #3606 · plan-19 #3607 · plan-20 #3608 · plan-21 #3609 · plan-22 #3610 · plan-23 #3611 · plan-24 #3618

## Defect

The headless observation generator is a `claude` CLI child of the worker, and it is spawned as if it were the user's interactive session: it inherits (or is denied) whatever the worker happened to inherit, loads the user's full `~/.claude` config including third-party plugin hooks, runs in a cwd it can write to, keeps peer-messaging tools, resolves the CLI binary once and never again, and picks its credential from a hard-coded chain that ignores what the user actually configured. Each of those is a separate spawn attribute; none of them is declared, and when any of them fails the generator returns prose that plan-18's classifier used to drop silently.

- **Config/hook inheritance:** the SDK child loads all plugin hooks; a third-party SessionStart hook injects "you MUST invoke the skill" and hijacks INIT (empty response, zero observations). `--setting-sources` was emitted with no value in older bundles (`Invalid setting source: --permission-mode`).
- **Tool surface:** `disallowedTools` lists Bash/Read/Write… but not `SendMessage`; observer sessions have sent fabricated instructions to the user's primary session. `CLAUDE_MEM_MAX_CONCURRENT_AGENTS=0` is unrepresentable (`parseInt(...) || 2`).
- **cwd and identity:** on Windows `cross-spawn` routes the SDK spawn through `cmd.exe /d /s /c "<argv joined>"`, so `>` in transcript text creates 0-byte files in the *user's project directory* (and gets committed by `git add -A`); observer transcripts land in `~/.claude/projects/` where Claude Desktop lists them as sessions (452 of them); observer-spawned SDK sessions are re-captured by hooks and filed under a project named after the plugin version dir (`13.12.4`) or the plugin cache basename.
- **Env:** `sanitizeEnv()` strips `HTTP_PROXY`/`HTTPS_PROXY` (403 behind proxies) — since 13.8.0 intentionally; `~/.claude-mem/.env` can only re-inject five keys and not `CLAUDE_CODE_OAUTH_TOKEN`; an *expired* keychain credential returns early and never falls through to a valid `CLAUDE_CODE_OAUTH_TOKEN` env var; the keychain lookup fails when the lineage descends from the desktop app (search list excludes the login keychain) and on Linux when `.credentials.json` has empty tokens.
- **Binary resolution:** `findClaudeExecutable()` is probed via `execFileSync` from the same long-lived process; after a native CLI auto-update the cached realpath is unlinked → ENOENT forever → `setup_required` wedge until manual restart; when `claude` is only installed as a VS Code extension binary it is never found — 3,063 PostToolUse hooks, 0 observations, and the only trace is a WARN in a log file.

## Children

- #2976 — tracking: observer hook spawns accumulate unlimited .jsonl transcript files and mix cross-session context
- #2999 — ENV_PROXY_VARS stripped instead of preserved in sanitizeEnv()
- #3074 — Headless observation generator inherits interactive plugin hooks → third-party SessionStart hook hijacks generation
- #3105 — subscription/cli auth: SDK returns 'Failed to authenticate. API Error: 403' on clean install, isolated to worker's live session
- #3290 — Worker stays wedged in setup_required after Claude Code CLI auto-update — observations silently stop until manual restart
- #3317 — Observation generator always fails: --setting-sources passed without a value → Claude CLI exits 1 (stale bundle; residual: log child stderr on spawn failure)
- #3357 — 0-byte files named after transcript tokens written into the user's working directory (unquoted `>` reaching a shell)
- #3406 — macOS: worker spawned by the Claude Code desktop app can't read the login keychain — every observation silently discarded
- #3417 — Observer transcripts accumulate in ~/.claude/projects/ and flood the Claude Desktop session list
- #3425 — Observer SDK sessions self-captured under project named after plugin version dir ("13.12.4")
- #3566 — Observer session sends fabricated instructions to peer sessions via SendMessage
- #3582 — Silent no-op when `claude` is not on PATH (VS Code extension install): 3,063 PostToolUse hooks, 0 observations, no user-visible warning

Also carries the auth halves of #3169 (`.env` `CLAUDE_CODE_OAUTH_TOKEN` ignored on Windows) and #3121 (expired-token early return blocks env-var fallback), and the auth half of #3424.

Related PRs to evaluate/rebase: #3291 (`ClaudeExecutableUnspawnableError` + bounded self-restart), #2942, #2919 (transcript accumulation), #2704 (apiKeyHelper equivalent, on plan-12 roadmap).

## Fix sequence

1. **`ObserverSpawnSpec` — one declared object.** `{binary, argv, cwd, env, settingSources: [], disallowedTools (incl. SendMessage/peer tools), permissionMode, sessionDir, authSource}` built in one place and logged (redacted) at INFO on every spawn; the SDK child runs with `settingSources: []` (or an isolated `CLAUDE_CONFIG_DIR` shim) so no user or plugin hooks load; `CLAUDE_MEM_INTERNAL=1` documented for hook authors.
2. **No shell between the worker and the child.** Spawn `claude` directly with an argv array (`windowsVerbatimArguments: false`, no `cross-spawn` cmd.exe path); observation content travels via stdin/stream-json, never as an argument; cwd is `~/.claude-mem/observer-sessions/<id>` (or `--no-session-persistence` + a claude-mem-owned transcript dir) so nothing writes to the user's project and nothing appears in `~/.claude/projects/`; child stderr is captured to the worker log on non-zero exit.
3. **Self-capture guard.** Sessions whose spawn carries the observer marker (env + cwd inside the plugin/data dir) are skipped by `session-init`/`observation`/`summarize` handlers; project derivation refuses cwds inside the plugin install dir or data dir.
4. **Explicit auth source.** `authSource ∈ {env:CLAUDE_CODE_OAUTH_TOKEN, keychain, credentials.json, apiKey, apiKeyHelper}` resolved in a documented order where a *usable* env token always beats an expired platform credential; `.env` allowlist includes `CLAUDE_CODE_OAUTH_TOKEN`; proxy vars are preserved (or `CLAUDE_MEM_PRESERVE_PROXY` default true) and `NO_PROXY` documented; keychain lookup detects desktop lineage and falls back to `credentials.json` with token validity checked; auth failure surfaces as ERROR + `/api/health.auth=failed` + a one-line SessionStart notice, and pauses (plan-18 preserve path) instead of respawning.
5. **Binary resolution that recovers.** `findClaudeExecutable()` probes `realpathSync(candidate)` on ENOENT, searches known editor-extension globs, throws a typed unspawnable error that triggers one bounded successor handoff (plan-15), and `setup_required` is shown in SessionStart context and `doctor` — never only in a log file.
6. **Settings parsing.** `CLAUDE_MEM_MAX_CONCURRENT_AGENTS` and siblings parsed with `??`/NaN checks so `0` means "do not spawn a generator" (search-only mode).

## Test matrix

| Host lineage | Auth | Scenario | Required behavior |
|---|---|---|---|
| terminal / desktop app (macOS) / VS Code ext / Linux desktop | subscription (keychain), `.credentials.json`, env token, api key, proxy | spawn | child authenticates or fails with ERROR + health flag within one attempt; never classified as prose |
| all | expired keychain + valid env token | spawn | env token used |
| all | superpowers-style SessionStart hook installed | INIT | hook not loaded; observations stored |
| Windows | any | transcript text containing `> foo` | zero files created in project cwd |
| all | any | 100 observer runs | zero entries in `~/.claude/projects/`; transcripts under claude-mem dir, bounded by retention |
| all | any | observer spawn | no `sdk_sessions` row for the observer itself; no project named after a version dir |
| all | any | `claude` binary replaced/unlinked mid-run | recovery within one handoff; no permanent `setup_required` |
| all | any | `claude` only in VS Code extension dir | found, or SessionStart context says "claude-mem: setup required — claude CLI not found" |
| all | any | `MAX_CONCURRENT_AGENTS=0` | no generator spawned; search works |
| all | any | observer with peer-messaging tools | `SendMessage` blocked; no cross-session messages |

The matrix lives in CI (`tests/services/worker/observer-spawn-spec.test.ts` with a fake `claude` binary + lineage/env fixtures). A regression must fail CI before a user can file.

## Out of scope

Classification of what the child returns and history budgets (plan-18). Killing/reaping the child (plan-14). Project naming for *user* sessions (plan-20).
