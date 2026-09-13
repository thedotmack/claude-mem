<!-- Plan 26 has no GitHub plan master yet. Nearest existing master by fix shape is plan-23
     (#3611, host integration contracts: hook registrations and their handlers). If a master is
     opened, mirror this doc there and add the Tracker line below (oh-my-issues health check). -->

> **Tracker:** none yet · **Design doc:** `plans/26-telegram-session-wrapups.md` · **Branch:** `work/telegram-wrapups` (worktree `.claude/worktrees/telegram-wrapups`, head = `origin/main` `07ba05ae6`) · **Date:** 2026-09-12

# [plan-26] Telegram session wrap-ups — one message per session, from the Stop-hook summary, routed per project, never repeated

Bug report from Alex, verbatim (2026-09-12): *"the 'telegram session wrap-ups' are not derived of the stop hook summary, they're coming at the end of all turns. ALSO NOT scoped that way".*

Source audit: `~/.claude/context/endless/TELEGRAM-WRAPUPS-2026-09-12.md` (read-only, 2026-09-12). Every citation in it was re-checked against this worktree; most had drifted by 60 to 200 lines and one pointed at the wrong function. The line numbers in this doc are the checked ones.

## Defect

`notifyTelegram()` is called once per stored **observation batch** from the PostToolUse path, never from the summary path, and it posts everything to a single global chat. There is no session-end trigger, no per-project route, and no record of what was already sent, so a busy session produces many Telegram messages and none of them is a wrap-up.

## Desired behaviour (the spec this plan is measured against)

1. Exactly one Telegram wrap-up per session, delivered when the session ends.
2. Its text comes from the session's latest stored summary, the one the Stop hook queued. No new model call.
3. It goes to the route configured for that session's project (and route key where configured).
4. An unknown route is rejected with a log line. It never falls back to the global chat.
5. It is never repeated, including across worker restarts and duplicate SessionEnd deliveries.
6. Per-observation alerts survive as a separate feature, default **off**.

## Children

None filed. Alex's verbal report above is the only child.

## Related PRs

None open. `plans/12-provider-and-extensibility-roadmap.md:53` (#3845 Brainbeats) plans to reuse `TelegramNotifier` for observation-triggered webhooks; this plan keeps that observation path intact behind a new default-off switch, so #3845 is unaffected.

---

## Phase 0 — Consolidated discovery (READ THIS; DO NOT RE-DERIVE)

Every fact below carries a `file:line` from this worktree or is marked UNVERIFIABLE with the way to prove it. If a phase's instruction disagrees with a fact here, stop and re-read the file; do not guess.

### 0.1 Where the messages come from today

| Fact | Evidence |
|---|---|
| The Telegram sender is `notifyTelegram(input)`, a plain async function, imported into the response processor. | `src/services/worker/agents/ResponseProcessor.ts:13` |
| It is called fire-and-forget with the observation batch of the current response, after the batch is confirmed and before observations are synced. Summaries are never passed. | `src/services/worker/agents/ResponseProcessor.ts:623-628` (call), `:630-636` (Grok Bot sibling right after it) |
| The summary path is separate: `normalizeSummaryForStorage` builds `{request, investigated, learned, completed, next_steps, notes}` and `syncAndBroadcastSummary` syncs Chroma and broadcasts SSE. Neither touches Telegram. | `src/services/worker/agents/ResponseProcessor.ts:661-682`, `:828-890` |
| The notifier loads settings on every call, exits unless `CLAUDE_MEM_TELEGRAM_ENABLED === 'true'` and a token and chat id exist, then posts one MarkdownV2 message per observation whose type or concept matches the configured triggers. Failures are logged under `'TELEGRAM'`. | `src/services/integrations/TelegramNotifier.ts:67-109` |
| Transport is `postOne(botToken, chatId, text)`: a `fetch` POST to `https://api.telegram.org/bot<token>/sendMessage` with `{chat_id, text, parse_mode: 'MarkdownV2'}`, throwing on non-2xx. `escapeMarkdownV2` and `splitCsv` are module-private helpers. | `src/services/integrations/TelegramNotifier.ts:14-32`, `:49-65` |
| Message template is emoji, type, title, subtitle, project and observation number. `memorySessionId` is accepted but not rendered. | `src/services/integrations/TelegramNotifier.ts:34-47` |
| Upstream trigger is PostToolUse, which runs `hook claude-code observation` (async, 120 s). | `plugin/hooks/hooks.json:48-61` |

### 0.2 What the Stop hook does and why it is per turn

| Fact | Evidence |
|---|---|
| Stop runs `hook claude-code summarize` (async, 120 s). The registered events in the plugin are exactly `Setup, SessionStart, UserPromptSubmit, PostToolUse, PreToolUse, Stop`. **There is no SessionEnd registration.** | `plugin/hooks/hooks.json:76-88` and the whole file |
| The summarize handler takes the last assistant message (or reads it from the transcript) and POSTs `/api/sessions/summarize` with `{contentSessionId, last_assistant_message, platformSource, observedModel, observedBilling}`. | `src/cli/handlers/summarize.ts:76-114`, `:150-160` |
| Handler registry keys are `context, session-init, observation, summarize, user-message, file-edit, file-context`. No `session-end` handler file exists in `src/cli/handlers/`. | `src/cli/handlers/index.ts:13-20`, `:22-30` |
| The route validates with `summarizeByClaudeIdSchema`, upserts the session with `createSDKSession`, then calls `sessionManager.queueSummarize(sessionDbId, cleaned)`. Only three POST routes are registered: `/api/sessions/init`, `/api/sessions/observations`, `/api/sessions/summarize`. | `src/services/worker/http/routes/SessionRoutes.ts:569-576`, `:623-663`, `:522-537` |
| `queueSummarize` enqueues `PendingMessage {type:'summarize', last_assistant_message}` into the in-RAM per-session FIFO buffer. The buffer is not persisted. | `src/services/worker/SessionManager.ts:211-232`; `src/services/worker/SessionMessageBuffer.ts:21-40` (in-RAM docstring), `:56-71` (enqueue), `:210-218` (FIFO claim) |
| `PendingMessage.type` is the union `'observation' | 'summarize'`. | `src/services/worker-types.ts:87-98` |
| Consumers: `ClaudeProvider` yields the summary prompt into the live SDK query and later calls `processAgentResponse` with `activeResponseContext.current`; `OpenAICompatibleProvider` builds the prompt, queries, and calls `processAgentResponse` inline. | `src/services/worker/ClaudeProvider.ts:762-770`, `:472`, `:554`; `src/services/worker/OpenAICompatibleProvider.ts:206-210`, `:316-364` |
| `ResponseContext` is `{project, promptNumber, pendingAgentId, pendingAgentType}` snapshotted from the `ActiveSession`. Nothing per-message reaches the storage site except through `ActiveSession` fields. | `src/services/worker/agents/ResponseProcessor.ts:266-280` |
| Claude Code docs: Stop is a **per-turn** event ("per turn: UserPromptSubmit, Stop, StopFailure"); SessionEnd is **per session**, and the lifecycle text places Stop before SessionEnd. | https://code.claude.com/docs/en/hooks.md (fetched 2026-09-12) |

So "end of all turns" is literally what Stop means. The wrap-up needs SessionEnd.

### 0.3 SessionEnd hook contract (from the docs, fetched 2026-09-12)

| Fact | Evidence |
|---|---|
| Input JSON: common fields (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, …) plus `reason` ∈ `clear, resume, logout, prompt_input_exit, other`. | https://code.claude.com/docs/en/hooks.md, "SessionEnd input" |
| It cannot block; JSON output is discarded. | same, "SessionEnd hooks have no decision control" |
| **Default budget is 1.5 seconds.** Per-hook `timeout` in *settings files* raises it up to 60 s, but "Timeouts set on plugin-provided hooks don't raise the budget." Env override: `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`. | same, SessionEnd timeout paragraph |
| Whether `async: true` is honoured for SessionEnd: docs silent. Whether Ctrl+C or `claude -p` exit fires it: docs silent (would fall under `other` if it fires). | same |
| Plugin registration shape is the same as other events; matcher filters on `reason`; `${CLAUDE_PLUGIN_ROOT}` is available. | https://code.claude.com/docs/en/plugins-reference.md |

Consequence: the SessionEnd hook command must be a quick POST and exit. Phase 2 measures the cold start of `worker-service.cjs hook claude-code session-end` and records the number. The worker does all real work.

### 0.4 Persistence we can build on

| Fact | Evidence |
|---|---|
| Session identity: `sdk_sessions(content_session_id, memory_session_id UNIQUE, project, platform_source, status …)`. | `src/services/sqlite/SessionStore.ts:1021-1035` |
| Lookup by `(platform_source, content_session_id)` is the SELECT inside `createSDKSession`. There is no standalone find-by-content-id method; `resolvePromptSessionDbId` is the nearest helper. | `src/services/sqlite/SessionStore.ts:2744-2749`, `:227-255` |
| `getSessionById(id)` returns `content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, status, observed_model, observed_billing`. | `src/services/sqlite/SessionStore.ts:2640-2651` |
| **Latest summary already exists as a method**: `getSummaryForSession(memorySessionId, platformSource?)` returns the newest `session_summaries` row (`request … notes, prompt_number, created_at, created_at_epoch`). No `id` in its SELECT. | `src/services/sqlite/SessionStore.ts:2629-2646` |
| `storeSummary(memorySessionId, project, summary, promptNumber?, discoveryTokens?, overrideTimestampEpoch?)` returns `{id, createdAtEpoch}`. `session_summaries` has no `platform_source` column. | `src/services/sqlite/SessionStore.ts:2900-2947`, `:1678-1696` |
| Migration pattern: constructor call list ends with `this.ensureToolUsesTable()`; each `ensureXxx` does `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`, then `INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)`. Latest version is **51**. UNIQUE is written inline in the CREATE. | `src/services/sqlite/SessionStore.ts:164-212`, `:1909-1912`; `src/services/sqlite/tool-uses.ts:171-206` (copy template, `UNIQUE(...)` at `:194`) |
| No send ledger, `sent_at`, or idempotency key exists anywhere in `SessionStore`. | grep, 2026-09-12 |
| Canonical project name is `getProjectName(cwd, platform)` (git toplevel basename, `'unknown-project'` fallback); `getProjectContext()` composes `parent/child` for worktrees. | `src/utils/project-name.ts:53-88`, `:97-125` |
| Which of the two strings lands in `sdk_sessions.project` for a worktree session: **UNVERIFIABLE here**. Prove it in Phase 1 by reading `src/cli/handlers/session-init.ts` and the `/api/sessions/init` handler, then checking `sqlite3 ~/.claude-mem/claude-mem.db "select distinct project from sdk_sessions where project like '%/%' limit 5"`. The route resolver below handles both shapes. |
| `platform_source` is a normalised free string: `'claude'` default, `codex`, `cursor`, others pass through. | `src/shared/platform-source.ts:1-19` |

### 0.5 Settings plumbing

| Fact | Evidence |
|---|---|
| Telegram keys: interface `:123-127`, defaults `:253-257` (`ENABLED 'true'`, `BOT_TOKEN ''`, `CHAT_ID ''`, `TRIGGER_TYPES 'security_alert,sensitive'`, `TRIGGER_CONCEPTS ''`). Legacy trigger migration at `:369-383`. | `src/shared/SettingsDefaultsManager.ts` |
| Adding a key = interface field + `DEFAULTS` entry. `loadFromFile(path, applyEnvOverrides = true)` round-trips every key in `DEFAULTS`; env wins per key. | `src/shared/SettingsDefaultsManager.ts:22-153`, `:158-286`, `:316-324`, `:328-395` |
| JSON-valued settings already exist (`CLAUDE_MEM_FOLDER_MD_EXCLUDE: '[]'`, `…_SKELETON_DENYLIST: '[]'`), so a JSON route map is house style. | `src/shared/SettingsDefaultsManager.ts:213-214` |
| Secret masking allowlist for the settings API includes `CLAUDE_MEM_TELEGRAM_BOT_TOKEN`. | `src/services/worker/http/routes/SettingsRoutes.ts:30` |
| Mode files carry no Telegram fields; routing is purely settings-driven. | grep `plugin/modes/*.json`, 2026-09-12 |

### 0.6 Tests and tooling

| Fact | Evidence |
|---|---|
| Runner is `bun test` with `tests/preload.ts` preloaded. Scripts: `test`, `test:sqlite`, `test:agents`, `test:search`, `test:context`, `test:infra`, `test:server`. | `bunfig.toml`; `package.json:99-105` |
| Temp DB pattern: `new SessionStore(':memory:')` in `beforeEach`, `store.close()` in `afterEach`, helper `createSDKSession` + `updateMemorySessionId`. | `tests/sqlite/session-store-summaries.test.ts:1-24` |
| `global.fetch` mock pattern with restore. | `tests/shared/worker-utils-fetch-verbose.test.ts:28-46`, `:205`, `:216-217` |
| Response-processor test harness: `mock.module` on `worker-service.js`, `worker-utils.js`, `ModeManager.js` with snapshot/restore; logger spies in `beforeEach`. | `tests/worker/agents/response-processor.test.ts:12-24`, `:95-103`, `:125-134` |
| CLI handler test harness: `mock.module` on `SettingsDefaultsManager.js`, `hook-settings.js`, `transcript-parser.js`, `observed-billing.js`; `postedBody()` helper reads the last worker POST. | `tests/cli/handlers/summarize-observed-fields.test.ts:8-58`, `:79-91`, `:103-108` |
| Sibling integration with unit tests to mirror: `GrokBotAwarenessPusher` (`loadXxxConfig` from settings, pure `formatXxx`, whole body guarded). | `src/services/integrations/GrokBotAwarenessPusher.ts:18-52`, `:151-186`; `tests/integrations/grok-bot-awareness-pusher.test.ts` |
| **No test touches `TelegramNotifier`** today. | grep `tests/`, 2026-09-12 |
| Baseline: `origin/main` carried 4 pre-existing failures on 2026-09-12 including a 30 s worktree-test timeout (claude-mem observation #124832). Re-run `bun test tests` before Phase 1 and paste the failing names into the Phase 1 commit body so later phases can tell old red from new red. | memory, must be re-proven |

### 0.7 Allowed APIs (use only these; anything else, read the file first)

- `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)` and the `SettingsDefaults` keys listed in 0.5.
- `SessionStore.getSessionById`, `getSummaryForSession`, `createSDKSession`'s SELECT (copy, do not call `createSDKSession` from the session-end path: it upserts).
- `SessionManager.getSession(sessionDbId)`, `queueSummarize` (read for shape only).
- `logger.warn|info|debug('TELEGRAM', …)` as used at `TelegramNotifier.ts:101`.
- `fetch` exactly as `postOne` uses it.
- Hook input access exactly as `summarize.ts:76-114` does it; worker dispatch via `executeWithWorkerFallback(route, 'POST', body)` as at `summarize.ts:150-160`.
- Zod schema shape as `summarizeByClaudeIdSchema` (`.passthrough()` included).

### 0.8 Anti-patterns — do not do these

- Do not queue a new `summarize` at SessionEnd. That is a second paid model call and a second `session_summaries` row per session. The wrap-up **reads** the latest stored summary.
- Do not infer session end from Stop, from `stop_hook_active`, from the summarize route, or from `deleteSession`/`removeSessionImmediate` (those are worker teardown and telemetry flush: `SessionManager.ts:267-350`, `telemetry/buffer.ts:376-387`).
- Do not fall back to `CLAUDE_MEM_TELEGRAM_CHAT_ID` for a wrap-up. Unknown route = reject + log.
- Do not dedupe in RAM. The buffer is process-lifetime only; the ledger must be SQLite.
- Do not put a `timeout` on the plugin SessionEnd hook expecting more time; the docs say plugin timeouts do not raise the 1.5 s budget.
- Do not make the SessionEnd hook wait for the worker to deliver. POST, exit.
- Do not add `platform_source` to `session_summaries` or change its schema.
- Do not invent `SessionStore` methods; if a lookup is missing, add it next to `getSessionById` copying its shape.
- Do not run `npm run build-and-sync` from a phase (it restarts the live worker on this Mac). `npm run build` only.
- No try/catch during the happy-path build of a phase; add guards in that phase's last step, mirroring `GrokBotAwarenessPusher.ts:151-186`.

---

## Design decisions

**D1. Trigger = Claude Code `SessionEnd`, one new hook, one new route.** `plugin/hooks/hooks.json` gains a `SessionEnd` entry running `hook claude-code session-end`; the handler POSTs `/api/sessions/session-end` and exits. Other platforms have no session-end event today (Codex, Cursor, Antigravity map only `Stop`; OpenCode has `session.idle`/`session.deleted`): out of scope, listed below.

**D2. Wrap-up text = latest stored summary for the session.** Delivery reads `getSummaryForSession(memory_session_id)`. If the session has no summary, no wrap-up is sent and an info line says so. This is exactly "derived of the stop hook summary" and costs zero model calls.

**D3. Race handling: flag plus grace, then deliver-after-summary.** SessionEnd can arrive while the Stop summary is still queued or in flight (certain for `claude -p`, possible interactively). The route therefore:
1. resolves `sessionDbId` by `(platform_source, content_session_id)` without upserting;
2. if the session is live in `SessionManager`, sets `session.telegramWrapupRequestedAt = Date.now()` and arms a one-shot timer (`SESSION_END_WRAPUP_GRACE_MS = 5000`, a constant, not a setting) that calls `deliverSessionWrapup(sessionDbId)`;
3. if the session is not live (worker restarted, or the session already tore down), calls `deliverSessionWrapup(sessionDbId)` immediately.
`processAgentResponse`, after `syncAndBroadcastSummary`, calls `deliverSessionWrapup` when `result.summaryId` is set and the flag is set. Two attempts may race; the ledger's atomic claim makes exactly one win.

**D4. Ledger = new table `telegram_wrapups`, schema version 52.** Columns: `id, platform_source, content_session_id, project, route_key, summary_created_at_epoch, status ('claimed'|'sent'), claimed_at_epoch, sent_at_epoch`, with `UNIQUE(platform_source, content_session_id, project, route_key)`. Claim is `INSERT OR IGNORE`; `changes === 1` means this caller sends. On send failure the claim row is deleted so a later SessionEnd redelivery can retry. On success the row is marked `sent`. This is the "never repeated" guarantee and it survives restarts.

**D5. Routing = one JSON setting, exact match, parent-project fallback, otherwise reject.**
`CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES` (default `'{}'`) is a JSON object keyed by project name:
```json
{ "claude-mem": { "chat_id": "-1001234567890", "bot_token": "optional override", "key": "optional route label" } }
```
Resolution order: exact `project`; then, if `project` contains `/`, the part before the first `/` (covers `parent/child` worktree names, see 0.4 UNVERIFIABLE row); otherwise **reject** with `logger.warn('TELEGRAM', 'No wrap-up route for project', {project, platformSource, contentSessionId})` and no send. `bot_token` defaults to `CLAUDE_MEM_TELEGRAM_BOT_TOKEN`; `chat_id` is required per entry. `route_key` in the ledger is `entry.key ?? matched map key`. The global `CLAUDE_MEM_TELEGRAM_CHAT_ID` is never consulted for wrap-ups. An empty map means "not configured": return silently at debug level, no warn per session.

**D6. Switches.** Three new settings, all strings like their neighbours:
- `CLAUDE_MEM_TELEGRAM_WRAPUPS_ENABLED` default `'true'` (nothing sends until routes exist, so the default is safe).
- `CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED` default `'false'`; gates the existing per-observation path in `notifyTelegram`.
- `CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES` default `'{}'`, added to the masking allowlist at `SettingsRoutes.ts:30` because it can carry tokens.
`CLAUDE_MEM_TELEGRAM_ENABLED` stays the master switch for both paths.

**D7. Code shape mirrors the Grok Bot sibling.** New file `src/services/integrations/TelegramWrapupNotifier.ts` with `loadTelegramWrapupConfig(settings)`, `resolveWrapupRoute(config, project)`, `formatWrapupMessage(...)` (pure, testable) and `deliverSessionWrapup(...)`. Shared transport and escaping move out of `TelegramNotifier.ts` into `src/services/integrations/telegram-transport.ts` (`escapeMarkdownV2`, `postTelegramMessage`), imported by both notifiers. No class, no DI container.

**D8. Message format.** MarkdownV2, under 3,500 characters (Telegram caps at 4,096):
```
✅ *Session wrap\-up* — `<project>`
*Request:* <request>
*Completed:* <completed>
*Next steps:* <next_steps>
*Notes:* <notes>            ← omitted when null
_<platform_source> · session <first 8 chars of content_session_id> · turn <prompt_number>_
```
Each field is escaped with `escapeMarkdownV2` and truncated to 600 characters with `…`.

**D9. All `reason` values deliver.** `clear`, `resume`, `logout`, `prompt_input_exit`, `other` each end a content session; no matcher on the hook.

---

## Phase 1 — Ledger, settings, transport split, wrap-up notifier (no wiring) (complete)

Phase 1 completed 2026-09-12 in source commit `cccc597719e31ae604e91c6661d8aed7bdbe5d37`: focused verification passed 3/3 ledger, 6/6 notifier, and 3/3 alert tests, with 222 SQLite/integration tests passing; `npm run build` and TypeScript passed. Full `npm test` recorded 3,745 passing, 28 skipped, and one persistent documented pre-existing failure in `tests/worker/field-deadline-wire.test.ts`.

Fresh Codex session. Branch `work/telegram-wrapups`, commit here, never switch branches.

### 1.1 Baseline first

Run `bun test tests` once and write the names of any failing files into the commit body under `Baseline failures (pre-existing):`. Do not fix them.

### 1.2 Settings

`src/shared/SettingsDefaultsManager.ts`: add the three keys from D6 to the interface next to `:123-127` and to `DEFAULTS` next to `:253-257`, with one-line comments in the style of `:229`. `src/services/worker/http/routes/SettingsRoutes.ts:30`: add `CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES` to the masked list.

### 1.3 Ledger table and store methods

`src/services/sqlite/SessionStore.ts`:
- `ensureTelegramWrapupsTable()` copied from the `ensureToolUsesTable` + `createToolUsesSchema` pattern (`SessionStore.ts:1909-1912`, `tool-uses.ts:171-206`), version **52**, table per D4, index on `(platform_source, content_session_id)`. Append the call after `this.ensureToolUsesTable()` at `:212`.
- `claimTelegramWrapup({platformSource, contentSessionId, project, routeKey, summaryCreatedAtEpoch}): boolean` — `INSERT OR IGNORE`, returns `changes === 1`.
- `markTelegramWrapupSent(...)`, `releaseTelegramWrapupClaim(...)`.
- `findSessionDbIdByContentSessionId(contentSessionId, platformSource): number | null` — the SELECT from `:2744-2749`, no insert.

### 1.4 Transport split

Create `src/services/integrations/telegram-transport.ts` exporting `escapeMarkdownV2` (from `TelegramNotifier.ts:23-25`) and `postTelegramMessage(botToken, chatId, text)` (from `:49-65`, renamed). `TelegramNotifier.ts` imports them; behaviour unchanged except the new gate: return early unless `CLAUDE_MEM_TELEGRAM_OBSERVATION_ALERTS_ENABLED === 'true'` (add right after the `ENABLED` check at `:70-72`).

### 1.5 Wrap-up notifier

Create `src/services/integrations/TelegramWrapupNotifier.ts` per D5, D7, D8 with:
```ts
export interface WrapupDeliveryInput {
  sessionStore: SessionStore;            // ledger + lookups
  sessionDbId: number;
  settings?: SettingsDefaults;           // default: loadFromFile(USER_SETTINGS_PATH)
  fetchImpl?: typeof fetch;              // default: global fetch (tests inject)
}
export async function deliverSessionWrapup(input: WrapupDeliveryInput): Promise<'sent' | 'already_sent' | 'no_route' | 'no_summary' | 'disabled' | 'unknown_session'>
```
Steps inside, in order: settings gates (`ENABLED`, `WRAPUPS_ENABLED`, non-empty routes) → `getSessionById` → `getSummaryForSession(memory_session_id)` → `resolveWrapupRoute` → `claimTelegramWrapup` → format → `postTelegramMessage` → `markTelegramWrapupSent`; on post failure `releaseTelegramWrapupClaim` and rethrow. The return string is what tests assert on. Last step of the phase: wrap the exported function body in the same guard shape as `GrokBotAwarenessPusher.ts:151-186`, logging under `'TELEGRAM'`.

### 1.6 Tests to add (bun)

- `tests/sqlite/session-store-telegram-wrapups.test.ts` (copy harness from `tests/sqlite/session-store-summaries.test.ts:1-24`): fresh `:memory:` store has `schema_versions` row 52 and the table; first claim returns true, second identical claim false; release then claim returns true; `findSessionDbIdByContentSessionId` finds by `(platform, id)` and returns null for an unknown id without inserting.
- `tests/integrations/telegram-wrapup-notifier.test.ts` (fetch mock from `tests/shared/worker-utils-fetch-verbose.test.ts:28-46`, settings passed in explicitly): route resolution exact / parent-prefix / reject; `no_summary` when the session has none; `sent` posts exactly one request to the configured `chat_id` with the route's token, and the body contains the summary's `request`; second call returns `already_sent` with zero additional fetches; `no_route` never calls fetch even when `CLAUDE_MEM_TELEGRAM_CHAT_ID` is set; post failure releases the claim so a retry sends.
- `tests/integrations/telegram-observation-alerts.test.ts`: with `ENABLED='true'`, token, chat id and a matching observation, `notifyTelegram` makes zero fetches when `OBSERVATION_ALERTS_ENABLED` is unset/`'false'` and one when `'true'`.

### 1.7 Verification checklist — Phase 1

```
bun test tests/sqlite/session-store-telegram-wrapups.test.ts
bun test tests/integrations/telegram-wrapup-notifier.test.ts
bun test tests/integrations/telegram-observation-alerts.test.ts
bun test tests/sqlite/ tests/integrations/
grep -n "CLAUDE_MEM_TELEGRAM_CHAT_ID" src/services/integrations/TelegramWrapupNotifier.ts   # must print nothing
grep -n "schema_versions" src/services/sqlite/SessionStore.ts | grep 52
npx tsc --noEmit -p .
```
Commit: `feat(telegram): wrap-up ledger, routes and notifier (plan-26 phase 1)`.

**Stop after Phase 1. Do not start Phase 2.**

---

## Phase 2 — SessionEnd hook, CLI handler, HTTP route, wrap-up request in SessionManager

Fresh Codex session. Read Phase 0 and D1, D3 first.

### 2.1 Hook registration

`plugin/hooks/hooks.json`: add a `SessionEnd` block after `Stop` (`:76-88`), same command shape with `session-end` as the event, `async: true`, no matcher. Do not add a `timeout` (0.3, 0.8).

### 2.2 CLI handler

Create `src/cli/handlers/session-end.ts` copying the input access of `summarize.ts:76-114` (session id, platform source) and the dispatch of `:150-160`, POSTing `/api/sessions/session-end` with `{contentSessionId, platformSource, reason, cwd}`. Read `reason` from the raw hook payload the way `summarize.ts` reads its fields; if the normalised input type lacks it, extend that type in the same file the other handlers use, not with `any`. Server runtime (`resolveRuntimeContext().runtime === 'server'`): log and return; out of scope. Register `'session-end'` in `src/cli/handlers/index.ts:13-30`.

### 2.3 Route

`src/services/worker/http/routes/SessionRoutes.ts`: `sessionEndSchema` beside `:569-576` (`contentSessionId` required, `platformSource`, `reason`, `cwd` optional, `.passthrough()`); `handleSessionEnd` beside `:623-663` that normalises platform source, calls `findSessionDbIdByContentSessionId`, returns `{status:'unknown_session'}` when null, else `await sessionManager.requestSessionWrapup(sessionDbId)` and returns `{status:'accepted'}`. Register at `:522-537`.

### 2.4 SessionManager

`src/services/worker/SessionManager.ts`: `requestSessionWrapup(sessionDbId)` implementing D3 steps 2 and 3. Add `telegramWrapupRequestedAt?: number | null` and `telegramWrapupTimer?: ReturnType<typeof setTimeout> | null` to `ActiveSession` (find the interface with `grep -n "interface ActiveSession" src/services/worker-types.ts`). Clear the timer in `deleteSession` (`:267-326`) and `removeSessionImmediate` (`:334-350`) and deliver immediately there if the flag is still set. The delivery call is `deliverSessionWrapup({sessionStore: this.dbManager.getSessionStore(), sessionDbId})` from Phase 1; nothing else.

### 2.5 Measure the hook

From the worktree, after `npm run build`: `time (echo '{"session_id":"probe","cwd":"'$PWD'","hook_event_name":"SessionEnd","reason":"other"}' | node plugin/scripts/worker-service.cjs hook claude-code session-end)` three times cold. Put the three wall times in the commit body. If any exceeds 1.2 s, note it as a Phase 4 item (a curl-based hook command) instead of widening scope here.

### 2.6 Tests to add (bun)

- `tests/cli/handlers/session-end-handler.test.ts` (copy `tests/cli/handlers/summarize-observed-fields.test.ts:8-58`, `:79-91`, `:103-108`): posts to `/api/sessions/session-end` with `contentSessionId`, `platformSource`, `reason`; no transcript read; server runtime path makes no worker call.
- `tests/worker/http/session-end-route.test.ts` (look in `tests/worker/http/` for the closest route test and copy its harness): unknown session → `unknown_session` and `requestSessionWrapup` not called; known session → `accepted` and called once with the right `sessionDbId`.
- `tests/worker/session-manager-wrapup.test.ts` (fake timers via `bun:test` `setSystemTime`/`mock` as existing SessionManager tests do; find one with `grep -rl "SessionManager" tests/worker/ | head`): live session → flag set and timer armed; timer fire → delivery called once; session not live → delivery called immediately; teardown with flag set → delivery called and timer cleared.

### 2.7 Verification checklist — Phase 2

```
bun test tests/cli/handlers/session-end-handler.test.ts
bun test tests/worker/http/session-end-route.test.ts
bun test tests/worker/session-manager-wrapup.test.ts
bun test tests/cli/ tests/worker/http/
node -e "const h=require('./plugin/hooks/hooks.json');if(!h.hooks.SessionEnd)process.exit(1)"
npx tsc --noEmit -p .
```
Commit: `feat(telegram): SessionEnd hook, session-end route and wrap-up request (plan-26 phase 2)`.

**Stop after Phase 2. Do not start Phase 3.**

---

## Phase 3 — Deliver-after-summary in the response processor

Fresh Codex session. Read Phase 0.1, 0.2 and D3.

### 3.1 The change

`src/services/worker/agents/ResponseProcessor.ts`: after `syncAndBroadcastSummary(...)` (call at `:649-658`), add
```ts
if (result.summaryId && session.telegramWrapupRequestedAt) {
  void deliverSessionWrapup({ sessionStore: dbManager.getSessionStore(), sessionDbId: session.sessionDbId });
}
```
Import from `../../integrations/TelegramWrapupNotifier.js` next to `:13`. Do not touch the `notifyTelegram` call at `:623-628` (it is already gated by Phase 1). Do not add fields to `ResponseContext`.

### 3.2 Tests to add (bun)

- `tests/worker/agents/response-processor-wrapup.test.ts` (harness from `tests/worker/agents/response-processor.test.ts:12-24`, `:95-103`, `:125-134`, plus `mock.module` on `TelegramWrapupNotifier.js` with the same snapshot/restore discipline): a response with only observations and the flag set → delivery not called; a response with a `<summary>` and no flag → not called; a response with a `<summary>` and the flag set → called once with the session's `sessionDbId`.
- Extend `tests/integrations/telegram-wrapup-notifier.test.ts` with the two-caller race: two concurrent `deliverSessionWrapup` calls against one `:memory:` store make exactly one fetch (`Promise.all`, then `expect(fetchMock).toHaveBeenCalledTimes(1)`).

### 3.3 Verification checklist — Phase 3

```
bun test tests/worker/agents/response-processor-wrapup.test.ts
bun test tests/integrations/telegram-wrapup-notifier.test.ts
bun run test:agents
npx tsc --noEmit -p .
```
Commit: `feat(telegram): deliver wrap-up after the session-end summary lands (plan-26 phase 3)`.

**Stop after Phase 3. Do not start Phase 4.**

---

## Phase 4 — Docs, build, anti-pattern sweep, full verification

Fresh Codex session.

### 4.1 Docs

`grep -rln "TELEGRAM" docs/public/` and update every hit: the three new keys, the routes JSON example from D5, the reject rule, and the note that per-observation alerts are now default off. Also `grep -rn -i telegram skills/ plugin/skills/ 2>/dev/null` and align the mode-creator skill's Telegram text if it promises per-observation alerts by default.

### 4.2 Build

`npm run build` (not `build-and-sync`). If `git ls-files plugin/scripts/worker-service.cjs` prints a path, the bundle is tracked and must be committed with this phase; otherwise leave it.

### 4.3 Anti-pattern sweep (all must print nothing)

```
grep -rn "CLAUDE_MEM_TELEGRAM_CHAT_ID" src/services/integrations/TelegramWrapupNotifier.ts
grep -rn "queueSummarize" src/cli/handlers/session-end.ts src/services/worker/http/routes/SessionRoutes.ts | grep -i "session-end\|sessionEnd"
grep -rn "type: 'summarize'" src/services/worker/SessionManager.ts | grep -i wrapup
grep -n "\"timeout\"" plugin/hooks/hooks.json | sed -n '/SessionEnd/,$p' | head -1
```

### 4.4 Full verification

```
bun test tests
npx tsc --noEmit -p .
```
Compare failures with the baseline list recorded in the Phase 1 commit; anything new is this plan's to fix before committing.

### 4.5 Manual smoke on this Mac (no paid calls)

With `CLAUDE_MEM_TELEGRAM_ENABLED=true`, a bot token, and `CLAUDE_MEM_TELEGRAM_WRAPUP_ROUTES='{"claude-mem":{"chat_id":"<the existing CLAUDE_MEM_TELEGRAM_CHAT_ID value>"}}'` in `~/.claude-mem/settings.json`, run a tiny `claude -p "say hi" --model haiku` inside a `claude-mem` checkout, then check: exactly one wrap-up in the chat, one row in `telegram_wrapups`, a second `claude -p` in a directory whose project has no route produces a `No wrap-up route` warn in the worker log and no message. Paste the log lines into the commit body. (The observer's own summary call is the existing Stop path, not a new paid call.)

Commit: `docs(telegram): wrap-up routes, alerts default off; plan-26 verification`.

**Stop after Phase 4. Plan complete.**

---

## Test matrix

- PostToolUse observation batch × alerts off → zero Telegram requests (Phase 1)
- PostToolUse observation batch × alerts on × matching type → one request to the global chat (Phase 1, existing behaviour preserved)
- SessionEnd × session with summary × route configured → exactly one wrap-up to that route (Phases 1–3)
- SessionEnd × route missing × global chat configured → zero requests, one warn (Phase 1)
- SessionEnd × no summary → zero requests, one info (Phase 1)
- SessionEnd twice, or SessionEnd + deliver-after-summary race → one request (Phases 1, 3)
- Worker restart between claim and second SessionEnd → still one request (ledger is SQLite, Phase 1)
- Post failure → claim released, retry sends (Phase 1)
- Session not live in the worker at SessionEnd → immediate delivery from the DB (Phase 2)
- `parent/child` project name → parent route matches (Phase 1; confirm the stored shape per 0.4)

## Out of scope

- Session-end for Codex, Cursor, Antigravity, Gemini, OpenCode adapters (no session-end event today; plan-23 #3611 territory).
- Server runtime (`CLAUDE_MEM_RUNTIME=server`) session-end handling (plan-24 #3618).
- Generating a dedicated end-of-session summary with a model call.
- Per-chat rate limiting, message threading, or editing a previously sent wrap-up.
- Brainbeats / Grok Bot webhook fan-out (#3845, plan-12).
- A settings UI for the routes map.
