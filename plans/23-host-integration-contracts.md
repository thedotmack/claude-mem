# [plan-23] Host Integration Contracts — every non-Claude-Code adapter and the MCP/HTTP tool surface validated by contract tests against the host's actual schema

> **Tracker:** #3611 · **Design doc:** `plans/23-host-integration-contracts.md` · **Series:** plan-14 #3602 · plan-15 #3603 · plan-16 #3604 · plan-17 #3605 · plan-18 #3606 · plan-19 #3607 · plan-20 #3608 · plan-21 #3609 · plan-22 #3610 · plan-23 #3611 · plan-24 #3618

## Defect

Each host integration (OpenCode plugin, Codex hooks, Antigravity CLI/IDE, hook-CLI platforms, transcript watcher, and the `mcp-search` MCP server / worker HTTP surface) is a hand-rolled adapter whose only test is "does the source file import". None of them is checked against the host's real loader/hook/tool schema, and the shared plumbing they depend on (port resolution, generator start, viewer source filter) has per-adapter forks:

- **OpenCode:** the plugin binds `chat.message` (removed upstream; now `message.updated`/`message.part.updated`), fires capture POSTs without awaiting, exports two `as const` arrays from the plugin entry that opencode's loader rejects (`Plugin export is not a function`) — regressed 13.4.0 → 13.4.1 and still present on 13.14.0 — resolves the worker port from env/defaults instead of `settings.json`, and the installer refreshes a stale 12.4.7 npx-cached plugin file. OpenCode is not a viewer source.
- **Codex:** `codex-hooks.json` emits `suppressOutput` (rejected by Codex), and POSIX shell command strings with no `commandWindows` so the Windows Codex app runs them through PowerShell (`ParserError`).
- **Antigravity / transcript watcher:** `--ide antigravity` wires only `agy` CLI hooks while the GUI IDE never fires them; the transcript watcher's `Bun.Glob` lacks `dot: true` so the IDE's `.system_generated/logs/transcript_full.jsonl` is never discovered; the Windows agy path records nothing; the installer depends on a marketplace file it does not install; the custom watch schema is undocumented.
- **Hook-CLI platforms:** `worker-service.cjs hook <platform> observation` returns `{"status":"queued"}` but the generator never starts for sessions registered through `/api/sessions/init` outside Claude Code.
- **MCP / HTTP surface:** tool definitions have no `annotations.readOnlyHint` so plan mode re-prompts every session; server-beta `observation_add` loses `content` between the protocol layer and the handler; `claude mcp list` renders the entry garbled; `skillOverrides: off` does not hide bundled skill descriptions and there is no plugin-level opt-out of the smart-* tools; the CORS allowlist regressed to localhost-only prefixes so settings cannot be saved from a LAN viewer (was #1029); the stdio MCP server closes after ~59 s when the worker fails to start (Windows).

The fix is a contract per host — a checked-in fixture of the host's loader/hook/tool schema, an adapter that is generated or validated against it in CI, and shared resolvers (port, project, generator start) instead of forks.

## Children

- #2832 — OpenCode plugin loads but captures nothing on opencode 1.16.2 (dead chat.message hook + un-awaited POSTs)
- #2854 — opencode plugin loading error: "Plugin export is not a function"
- #2871 — Codex PostToolUse hook outputs a field current Codex does not support (suppressOutput)
- #2916 — observation_add: content parameter undefined at server-beta despite being passed by caller
- #2968 — tracking: OpenCode plugin captures nothing — dead hook names, un-awaited POSTs, invalid export shape
- #2975 — tracking: Codex PostToolUse hook emits unsupported suppressOutput field — hook rejected on every tool call
- #2986 — OpenCode plugin loads but automatic capture does not initialize (outdated OpenCode hook: chat.message)
- #3075 — Codex plugin hooks on Windows need commandWindows overrides
- #3101 — Windows Codex App executes codex-hooks.json POSIX commands with PowerShell, causing ParserError
- #3239 — Antigravity GUI IDE: no automatic transcript capture (only agy CLI hooks are wired)
- #3328 — OpenCode plugin fails to load in v13.11.0: "Plugin export is not a function" (non-function const exports)
- #3330 — OpenCode plugin fails to load in v13.11.0: "Plugin export is not a function" + wrapped-fetch .text() returns object (dupe of #3328)
- #3334 — Antigravity CLI integration on Windows does not record any sessions/observations; reinstall fails (install half → plan-16)
- #3365 — OpenCode plugin ignores CLAUDE_MEM_WORKER_PORT from settings.json, breaks capture
- #3471 — A mess when checking Claude mcp list
- #3483 — Plan mode re-prompts for mcp-search tools every session (no readOnlyHint annotation)
- #3504 — OpenCode is not shown as a separate source in the Web Viewer source filter
- #3512 — transcript-watcher: Bun.Glob needs dot: true — transcripts behind dot-directories are never discovered
- #3526 — Regression: 500 "CORS not allowed" saving settings from a non-localhost origin (13.14.0, was #1029)
- #3578 — skillOverrides "off" does not hide bundled skill descriptions from the session
- #3585 — Hook CLI observations from non-Claude-Code platforms are queued but never generate

Related PRs to evaluate/rebase: #2855, #2985 (OpenCode events + await), #2953 (Codex suppressOutput), #3208 (OpenCode port), #3527 (readOnlyHint), #3070 (remote MCP), #2699/#2679 (Codex Windows), #1214 (original CORS fix). Net-new hosts (Hermes #2825, Goose #3329, omp #3355, HTTP/SSE MCP transport #3086) are tracked on the roadmap master #2785 and become cheap once this contract exists.

## Fix sequence

1. **Host schema fixtures + contract tests.** Check in the loader/hook/tool schema for each host version we claim to support (`fixtures/hosts/opencode-<ver>.json`, `codex-hooks-<ver>.json`, `antigravity-<ver>.json`, `claude-code-mcp-annotations.json`); CI imports the *built* `dist/opencode-plugin/index.js` and asserts every export is a function or `{server: fn}`, that registered hook names ⊆ the host's event list, and that Codex hook JSON contains only host-accepted keys and has `commandWindows` for every entry.
2. **Adapters share resolvers.** OpenCode plugin, Codex adapter, Antigravity/transcript watcher, and hook-CLI all call the same `resolveWorkerEndpoint()` (settings.json → env → default, `CLAUDE_MEM_DATA_DIR`-aware), the same `resolveProjectIdentity()` (plan-20), and the same `ensureGeneratorRunning(sessionDbId)` so a session initialized from any host generates; every capture POST is awaited with a bounded timeout.
3. **Antigravity IDE and custom transcripts.** `Bun.Glob(..., {dot: true})`; a built-in Antigravity IDE schema; the custom `transcript-watch.json` schema documented with a validator command; `--ide antigravity` reports honestly which surface (CLI vs IDE) is captured; installer refreshes host plugin files on upgrade and prints the version installed.
4. **MCP/HTTP surface.** `readOnlyHint: true` on all read-only tools and annotations forwarded in `tools/list`; server-beta write tools pass `content` through (integration test on the MCP protocol path, not the handler); a plugin-level `CLAUDE_MEM_MCP_TOOLS` allowlist to trim `smart_*`; skill descriptions honor `skillOverrides`/`CLAUDE_MEM_SKILLS_DISABLED`; CORS allows same-host origins and a `CLAUDE_MEM_ALLOWED_ORIGINS` list with a JSON error body; `mcp-server.cjs` reports a clean name/title/description and exits promptly with a reason when the worker cannot be reached (plan-15 owns worker start).
5. **Viewer.** `platform_source` propagates end-to-end and the source filter is generated from distinct values (OpenCode, Codex, Antigravity, Cursor, hook-CLI).

## Test matrix

| Host | Version(s) | Scenario | Required behavior |
|---|---|---|---|
| OpenCode | 1.16, 1.17, 1.18 | load + one tool call + one message | plugin loads; `/api/sessions/init|observations|summarize` received on the settings.json port; observation stored with `platform_source=opencode` |
| Codex CLI / Codex App | current, on macOS + Windows | PostToolUse | hook accepted (no unsupported keys); Windows runs `commandWindows`; observation stored |
| Antigravity CLI + IDE | current | session | CLI: hooks capture; IDE: transcript watcher discovers dot-dir transcript and ingests |
| hook-CLI (`hook <platform>`) | any | init + observation | generator starts; observation row exists ≤ 60 s |
| Claude Code plan mode | current | `search`, `timeline`, `get_observations`, `smart_*` | no permission prompt (readOnlyHint) |
| server-beta MCP | current | `observation_add` over stdio | row written |
| viewer from `http://<lan-host>:<port>` | current | settings save | 200; CORS same-host allowed; explicit deny returns JSON 403 |
| Codex | current | `enabled_tools`/`CLAUDE_MEM_MCP_TOOLS` | only listed tools advertised |

The matrix lives in CI (`tests/integrations/*-contract.test.ts` against checked-in host fixtures, plus a Docker job that installs the real OpenCode CLI). A regression must fail CI before a user can file.

## Out of scope

Claude Code's own hook wrapper (plan-17). Which plugin copy the installer materializes (plan-16). Worker start/liveness behind the MCP server (plan-15). New host integrations (roadmap #2785).
