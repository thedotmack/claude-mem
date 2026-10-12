# Grok Bot live timeline INDEX

Live-write a growing observation INDEX into each Grok Bot seat’s Memory mid-attach file, the same spirit as CLAUDE.md folder writers and SessionStart `/api/context/inject`.

CCS (`ccs/seats/*/TIMELINE.md`) is out of product scope. Do not invent a Grok Bot engine hook.

## Phase 0 — Allowed APIs (verified)

| API | Source | Use |
| --- | --- | --- |
| `GET /api/context/inject?projects=&platformSource=` | `SearchRoutes.handleContextInject` | Canonical INDEX text for Claude Code / Cursor. **Do not add query params.** Strictly project-scoped. |
| `generateContextWithStats` / `queryObservationsMulti` | `ContextBuilder.ts`, `ObservationCompiler.ts` | Newest rows for an explicit project list. Empty project → empty / welcome hint. **No house fallback.** |
| SessionStart | `src/cli/handlers/context.ts` | `projects=getProjectContext(cwd).allProjects` (cwd / worktree only). |
| CLAUDE.md live write | `updateFolderClaudeMdFiles` from `ResponseProcessor` after store | Project + folder file paths. Also no house fallback. |
| Compact row | `AgentFormatter.renderAgentTableRow` → `` `${id} ${time} ${icon} ${title}` `` | Keep IDs for `get_observations`. |
| Host Memory fact grammar | `tests/grok-bot-session-inject.test.ts` | `- (YYYY-MM-DD) …`, `[episode]` tier, 500-char clamp, `zz-claude-mem-inject.md` only. |
| Seat mapping | `transcript-watch.json` + `discoverGrokBotAgentDataRoot` | `cmem_work_<slug>` diaries are often thin. |
| Awareness pusher | `GrokBotAwarenessPusher` | Needles into `YYYY-MM.md`. **Not** the INDEX. Leave it. |

### Product rule (thin diaries)

`/api/context/inject?projects=<seat>` and CLAUDE.md regen stay project-scoped. That is correct for Claude Code.

Grok Bot seats are named diaries (`cmem_work_prioritizer`) on a worker that sees the whole house. If the seat project is thin, **union newest seat rows with newest house rows (no project filter), newest-first, slide-off at `WINDOW`**. Do this only in the Grok Bot writer. Do not change inject/hook semantics.

### Anti-patterns

- Do not require or write `ccs/seats/*/TIMELINE.md` as the source of truth.
- Do not add Grok Bot `hooks` / engine SessionStart.
- Do not add new `/api/context/inject` query params.
- Do not write `profile.md` or host-owned `YYYY-MM.md`.
- Do not start the Phase 1 CCS daemon as the product.

## Phase 1 — Writer + settings

Worker-native `GrokBotIndexWriter` (like CLAUDE.md / awareness):

- After observations are stored, debounce-refresh **all** mapped seats (house feed changes every seat).
- Kick once on worker start after the transcript watcher.
- Write `agents/<uuid>/memory/log/zz-claude-mem-inject.md` directly.
- Settings: `CLAUDE_MEM_GROK_BOT_INJECT_ENABLED` (default `true`, no-op without seats), `AGENT_IDS` default `*`, `TIER=episode`, `WINDOW=80`, `FALLBACK=house`, `PLATFORM_SOURCE` empty.

## Phase 2 — Tests

Pure merge/format/path tests + write-grows test. Do not break Claude/Cursor hook tests.

## Phase 3 — Docs

`docs/public/grok-bot/index.mdx`, `configuration.mdx`, Grok Bot install/mem-search skills. Enable/disable and how to prove a seat file grows.

## Phase 4 — Verification / babysit / version-bump

CI green, then MINOR bump (`13.24.23` → `13.25.0`). Leave npm publish to Prioritizer.
