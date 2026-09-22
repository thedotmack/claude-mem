# Stop-hook context clear — A/B make-plan

**Date:** 2026-09-08
**Status:** Plan only. Not approved for `/do`. No feature code in this PR.
**Repo:** [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)
**Prior art:** Notion [stop-hook-clear-plan — Az gate](https://app.notion.com/p/3d5771da7f4d81deabd6eeb7d749316e) (2026-09-08). This document restates that gate against the current tree and adds a Cursor A/B so Az can pick a clock.

This PR ships **this file only**. Do not implement, wire settings, or edit hook JSON until Prioritizer/Az approve a variant.

---

## 1. In plain English

Az already does this by hand: when a long session fills up, wait until claude-mem’s observer has written the turn summary, `/clear`, and keep going from the plan.

Automate that:

1. **Stop** fires at the end of an assistant turn.
2. Wake **notify-bot** (generic bearer webhook).
3. Wait until the **observer summary is actually stored** (`session_summaries` row, not merely queued).
4. If session context is **≥30%** (target band **30–40%**; above 40 still fires, log overshoot) **and** the summary landed, clear.
5. Next context start continues from the plan (last summary `next_steps` + “do not repeat”).

Auto-clear is **off by default**. Interactive chats **nudge only** — never poke a PTY, never auto-type `/clear`.

---

## 2. Why this exists

Today Stop only **queues** a summary and exits (`src/cli/handlers/summarize.ts` → `POST /api/sessions/summarize` → `SessionManager.queueSummarize`). The observer writes the row later in `ResponseProcessor` (`syncAndBroadcastSummary`). Nothing measures how full the session is, nothing waits for the row, nothing nudges a clear.

If you clear before the summary lands, SessionStart injects a stale or empty last-summary and the next turn repeats work. That is the failure this feature is for.

---

## 3. Az-locked constraints (do not reopen)

| Lock | Meaning | Non-negotiable |
|---|---|---|
| **Nudge-only in interactive sessions** | Human-visible hint only. No PTY poke, no auto-submitted `/clear`, no Cursor `followup_message` that types the slash command. | Interactive path may **recommend** `/clear`. It must not execute it. |
| **Bearer webhook auth** | notify-bot is a generic JSON POST with `Authorization: Bearer <token>`. URL + token live in settings. Empty URL = off. | No unsigned webhooks. No Telegram-shaped payload as the contract (TelegramNotifier stays a separate product). Confirm URL/shape with Az before `/do`. |
| **Skip widgets still gated** | Do not ungate skip / permission widgets. Do not set `permissionDecision: allow` to auto-dismiss hook or permission UI. Do not add skip-widget chrome to the viewer. | This feature must not change who can skip a hook prompt. |

Also from the Notion gate (treat as locked unless Az reverses):

- Stop hook stays **short** (≤120s, the existing Stop timeout in `plugin/hooks/hooks.json`).
- Auto-clear **off by default**.
- Daemon auto-clear is feature-detected `op:"reply" /clear`, fail-silent.
- `/clear` vs `/compact` is one executor string — default `/clear`; swap later if research wins.

---

## 4. Current seams (verified against `main` @ `fd0ecf02`)

| Piece | Where it lives today | What a `/do` must respect |
|---|---|---|
| Stop hook | `plugin/hooks/hooks.json` `Stop` → `hook claude-code summarize`, **`async: true`**, timeout **120** | Already fire-and-forget. Async Stop **cannot** return a in-band clear/nudge that the harness applies on that same turn. |
| Stop handler | `src/cli/handlers/summarize.ts` | PURE hook (hook-io discipline). Queues summary; exits 0 on every failure. `stopHookActive` and `agentId` already short-circuit. |
| Worker summarize | `SessionRoutes.handleSummarizeByClaudeId` → `queueSummarize` → `ensureGeneratorRunning(..., 'summarize')` | Response is `{ status: 'queued' }`. The row does **not** exist yet. |
| Summary write-site | `SessionStore.storeSummary` + `ResponseProcessor.syncAndBroadcastSummary` | **This** is “summary landed.” Chroma/cloud/SSE already nudge from here. Clear-decision belongs beside this write, not in the hook. |
| SessionStart | `plugin/hooks/hooks.json` matcher `startup\|clear\|compact` → `hook claude-code context` | `/clear` already re-injects timeline. Continuity copy is a `context.ts` / `SummaryRenderer` change, not a new hook event. |
| `source` field | Codex adapter forwards `startup\|resume\|clear`. **claude-code adapter does not.** | Continuity-on-clear needs `source` on Claude Code SessionStart (and Cursor if that payload has it). |
| Usage in transcript | `extractLastAssistantTurn` / `extractLastAssistantModel` in `src/shared/transcript-parser.ts` | Reads last assistant **text + model**. Does **not** read `message.usage`. Context % is new, same one-pass scan. |
| Timeline JSON | `GET /api/observations`, `GET /api/timeline`, `GET /api/context/recent` | Notion also wants thin `GET /api/latest` — newest observations, **same shape** as existing timeline JSON. No new schema. |
| Hook result | `HookResult.systemMessage` = USER_HINT (`src/shared/hook-io.ts`) | Interactive nudge = `systemMessage` (and/or notify-bot). Not stdout model context. |
| Settings | `SettingsDefaultsManager` | New keys must be declared + defaulted or `loadFromFile` drops them. Empty-secret = off (TV-token / CloudSync pattern). |
| Cursor Stop | `docs/context/cursor-hooks-reference.md` — `followup_message`, `loop_count`, max 5 | Auto-follow-up is **not** a clear. Using it to submit `/clear` in an interactive Cursor chat violates the nudge lock. |

House contracts that this feature inherits:

- Hooks swallow errors and exit 0 on transport failure (`hook-command.ts`).
- Long work is queue-and-return on the worker; hooks do not poll.
- Every persisted conversation string goes through `stripMemoryTags`.
- Do not edit `CHANGELOG.md` (generated).

---

## 5. A/B — pick a clock

Both variants implement the same product: notify-bot on Stop, wait for the summary row, clear (or nudge) at ≥30%, continue from the plan. They disagree on **who waits**.

```
                    Stop                    Observer                     Next context
Plan A (hook waits)  |-- measure -- POST -- wait-for-row -- decide --|   SessionStart
                     |<----------- ≤120s hook process ------------>|

Plan B (worker waits)|-- measure -- POST stop-event -- exit --------|   …summary INSERT…
                     |                                              |-- decide (nudge / daemon clear)
                     |                                              |                    SessionStart
```

### Plan A — sequential Stop hook (matches the one-liner, fights the tree)

Stop process: measure context % → POST summarize (existing) → POST notify-bot → **poll or hang until `session_summaries` exists** → if ≥30% and row present, emit nudge / trigger clear → exit.

| | |
|---|---|
| **Fits** | The English story “Stop → notify → wait → clear.” One process, easy to narrate. |
| **Breaks** | Az clock split. Current Stop is `async: true` — the harness does not apply a Stop JSON decision from an async hook. Making Stop sync so it can wait **and** return a nudge blocks the user up to 120s. Observer generation often exceeds 120s; timeout = clear-without-summary, the bug we are fixing. Polling from a hook process violates queue-and-return. |
| **Interactive** | Nudge via `systemMessage` only if Stop is **sync**. Async Stop cannot deliver that nudge in-band. |
| **Daemon clear** | Would have to happen inside the hook timeout or still be handed to the worker — at which point A has become B. |

**Verdict:** Documented so the sequential story has a name. **Do not build A** unless Az explicitly reverses the clock split.

### Plan B — clock-split (Az gate, recommended `/do`)

Split by clock. No polling.

1. **Stop hook (short, ≤120s):** one transcript pass for last-assistant usage + model; POST **one** stop-event to the worker (context %, tokens, model, `contentSessionId`, interactive/daemon hint). Existing summarize POST stays. Fire notify-bot (from hook or worker — see §6.3). **Do not wait for the summary.**
2. **Worker (long-lived):** when `storeSummary` / `syncAndBroadcastSummary` commits a row for that session, join against the pending stop-event. If context % ≥ 30 and the row is real → decide.
3. **Decide:**
   - Interactive → nudge only (systemMessage on the next eligible **sync** hook, and/or notify-bot body `action: "nudge_clear"`).
   - Daemon / bg → if `CLAUDE_MEM_AUTO_CLEAR=true` **and** feature-detect succeeds → `op:"reply" /clear` (or the one executor string Az picks). Ping + fail-silent. Default off.
4. **After clear:** SessionStart `source=clear` injects last summary `next_steps` + “do not repeat” so work continues from the plan.

| | |
|---|---|
| **Fits** | Notion gate, existing async Stop, existing write-site nudges (CloudSync, Chroma, SSE, Telegram). |
| **Risk** | Private daemon protocol is a version-pinned bet. Mitigate: feature-detect + fail-silent + default-off. Interactive users still get a nudge even if daemon clear never ships. |
| **Interactive** | Never auto-clears. Nudge may arrive on the *next* turn (UserPromptSubmit) or via notify-bot, because Stop is async. That is acceptable under the lock. |

**Verdict:** Build B after Az gate. Phases below are B.

---

## 6. Shared contracts (both plans; lock these before code)

### 6.1 Context %

- Source: last **assistant** transcript entry with `message.usage` (same backward JSONL scan as `extractLastAssistantTurn` — **one read**, do not scan twice).
- Numerator (proposed): `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (Anthropic usage object). If usage is missing → **no clear, no nudge**. Log `usage_missing` and exit the decision path.
- Denominator: resolved context window for `message.model` (table + conservative fallback). If window unknown → treat as missing usage.
- Percent: `floor(100 * numerator / window)`.
- Band:
  - `< 30` → no-op (still notify-bot if configured; still queue summarize).
  - `30–40` → in-band; this is the target.
  - `> 40` → **still fire**; log `overshoot` with percent. Do not wait for a later Stop.

Az open ask: confirm ≥30 fire / overshoot-above-40. Until reversed, implement that.

### 6.2 “Summary landed”

A row exists in `session_summaries` for this `contentSessionId` → `sdk_sessions.memory_session_id` join, with `created_at_epoch` **after** the stop-event timestamp (or `id` greater than the last summary id recorded on the stop-event). Queued / `DUP_SUPPRESSED` / privacy-skipped / empty-assistant-message is **not** landed.

Skipped summaries (`normalizeSummaryForStorage` returns null, `summary.skipped`) must **not** trigger clear.

### 6.3 notify-bot

Generic outbound webhook. Not Telegram.

Proposed settings (names are a `/do` detail; emptiness = off):

- `CLAUDE_MEM_NOTIFY_BOT_URL` (empty default)
- `CLAUDE_MEM_NOTIFY_BOT_TOKEN` (empty default)

Proposed POST:

```http
POST {CLAUDE_MEM_NOTIFY_BOT_URL}
Authorization: Bearer {CLAUDE_MEM_NOTIFY_BOT_TOKEN}
Content-Type: application/json
```

```json
{
  "event": "stop",
  "contentSessionId": "...",
  "project": "...",
  "platformSource": "claude-code",
  "contextPercent": 34,
  "band": "target",
  "usage": { "inputTokens": 0, "cacheReadTokens": 0, "cacheCreationTokens": 0, "windowTokens": 0 },
  "observedModel": "...",
  "interactive": true,
  "summary": { "status": "queued" },
  "action": "stop_recorded"
}
```

Rules:

- 401/403 from the bot → log, do not retry in a loop, do not fail the hook.
- Missing URL or token → no-op.
- Confirm this URL/shape with Az **before** `/do`. The field list can shrink; the auth cannot.
- A later `action: "nudge_clear"` / `"cleared"` POST from the worker (summary-landed) is allowed so the bot can show “summary ready — `/clear` now.” That is still a nudge, not a PTY.

### 6.4 Interactive vs daemon

| Signal | Interactive | Daemon / bg |
|---|---|---|
| How we detect | Default **interactive** unless a positive daemon signal is present (CI/headless/private protocol ping). Fail closed: unknown → interactive. | Feature-detect the private protocol (version-pinned). No detect → treat as interactive. |
| At ≥30% + summary landed | Nudge only (`systemMessage` / notify-bot). | If auto-clear setting on: send executor string (`/clear` default). Fail-silent. |
| Skip / permission widgets | Untouched. | Untouched. |

Do not detect “interactive” by `process.stdout.isTTY` on the **hook** child — hook stdio is a pipe. Prefer harness fields (`stop_hook_active` is the opposite signal — re-entry, already skipped) and an explicit setting / env for daemon sessions.

### 6.5 Executor string

Default ` /clear `. One constant. If research prefers `/compact`, change the constant; do not fork the decision tree. SessionStart already matches both `clear` and `compact`.

### 6.6 Continuity after clear

On SessionStart `source=clear` (and `compact` if that executor is used):

- Keep existing timeline inject (`contextHandler` → `/api/context/inject`).
- Prepend a short continuity block: last summary `next_steps` (already rendered by `SummaryRenderer` when `CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY=true`) plus an explicit **do not repeat** line.
- This is pointer + plan residue, not a bottle rewrite. Endless Mode / bottle plans stay out of scope.

Forward `source` through `claudeCodeAdapter.normalizeInput` (Codex already does).

### 6.7 `GET /api/latest`

Thin read. Newest observations, **same JSON shape** as the existing timeline/observations list (`DataRoutes.handleGetObservations` / `GET /api/timeline`). Limit default small (e.g. 20). No new columns. Loopback like the other worker GETs. Useful after a clear so UIs and notify-bot can show “what just landed” without inventing a second timeline.

---

## 7. Phased `/do` (Plan B) with verification

Each phase is a separate implementable slice. A phase that cannot pass its checklist is not done. Do not start a later phase by smuggling its code into an earlier one.

### Phase 0 — Az gate (this PR)

- [x] Restate Notion plan in-repo.
- [x] Name A vs B and recommend B.
- [ ] Az confirms ≥30 / overshoot-above-40.
- [ ] Az confirms notify-bot URL/shape (or “use §6.3 as-is”).
- [ ] Az confirms `/clear` as the executor string (or names `/compact`).
- [ ] Prioritizer marks this plan buildable.

**This PR’s only job is Phase 0.** Stop here.

---

### Phase 1 — Measure context % (pure)

**Goal:** one transcript pass yields `{ usage, model, percent, band }` or `missing`.

**Touch:** `src/shared/transcript-parser.ts` (extend the existing last-assistant scan; do not add a second file read). Small window table next to it or in `src/shared/context-window.ts`. Tests beside `tests/cli/handlers/summarize-*.test.ts` / a new `tests/shared/transcript-usage.test.ts`.

**Do not:** POST anything, change hooks.json, add settings.

**Checklist**

- [ ] Fixture JSONL with Anthropic `message.usage` → percent matches hand math.
- [ ] Missing usage → `band: "missing"`, no throw (same class as empty transcript).
- [ ] Torn last JSONL line skipped (existing parser contract).
- [ ] Cursor-shaped `{ role: "assistant" }` lines still work if usage is present.
- [ ] `extractLastAssistantTurn` still one read; summarize tests that count `extractCallCount === 1` still pass.
- [ ] Unknown model → missing band, not a guessed 200k window used for a clear.

---

### Phase 2 — Stop-event on the worker (no wait)

**Goal:** Stop handler attaches measurement to the existing summarize POST **or** adds `POST /api/sessions/stop-event` that stores a pending row/record keyed by `contentSessionId`. Hook still returns immediately.

**Touch:** `summarize.ts`, `SessionRoutes` zod schema, a small pending-stop store (sqlite table **or** in-memory map with session id + epoch — prefer sqlite if it must survive worker restart; in-memory is acceptable for v1 if documented). `SettingsDefaults` only if a kill-switch is required (`CLAUDE_MEM_STOP_CLEAR_ENABLED=false` default).

**Do not:** wait, poll, webhook, clear, SessionStart copy.

**Checklist**

- [ ] Hook payload includes percent/band/usage; existing fields (`last_assistant_message`, `observedModel`, `observedBilling`) unchanged.
- [ ] Privacy / `agentId` / `stopHookActive` / excluded-project skips still skip **both** summarize and stop-event.
- [ ] Worker responds `{ status: 'queued' }` in hook-budget time (existing `HOOK_TIMEOUTS.API_REQUEST`).
- [ ] Worker restart: pending stop-event either survives or decision path no-ops (fail-silent). Document which.
- [ ] `tests/cli/handlers/summarize-*.test.ts` still pass; add cases for attached usage fields.
- [ ] Hook-io discipline: handler stays PURE.

---

### Phase 3 — notify-bot (bearer JSON)

**Goal:** on stop-event, POST §6.3. Fail-silent.

**Touch:** new small helper modeled on `TelegramNotifier.ts` (generic fetch, not Telegram API). Settings keys. Call site: worker stop-event handler (preferred — hook stays short) **or** hook fire-and-forget with `AbortSignal.timeout`. Prefer worker so the token never lives in a 120s hook log more than it must.

**Do not:** implement Telegram as notify-bot. Do not auto-clear from the bot’s response body.

**Checklist**

- [ ] Empty URL → zero HTTP.
- [ ] Empty token → zero HTTP (even if URL set).
- [ ] `Authorization: Bearer <token>` exactly; 401 fixture does not throw into the hook.
- [ ] Token never logged (same rule as TV token / sync token).
- [ ] Hook / stop-event still succeeds when the bot is down.
- [ ] Unit test the header + JSON mapper (export a pure `buildNotifyBotPayload`); no live network.

---

### Phase 4 — Decision at summary write-site

**Goal:** after a real `session_summaries` INSERT, if a pending stop-event for that session is ≥30%, emit the decision. No polling.

**Touch:** `ResponseProcessor.syncAndBroadcastSummary` (or immediately after `storeSummary` returns an id). Join pending stop-event. Interactive → record `nudge_clear`. Daemon + setting on + feature-detect → executor string, fail-silent. Log overshoot. Notify-bot optional second POST (`action: "nudge_clear"` / `"cleared"`).

**Do not:** PTY. Do not `followup_message: "/clear"` on Cursor. Do not flip skip widgets. Do not default auto-clear on.

**Checklist**

- [ ] Summary skipped / null `summaryId` → no decision.
- [ ] Summary for a session with no pending stop-event → no decision.
- [ ] `< 30` → no decision (notify-bot already fired in Phase 3 if configured).
- [ ] `30–40` + landed → nudge (interactive) or clear attempt (daemon + on).
- [ ] `> 40` + landed → same fire + `overshoot` log.
- [ ] Interactive + auto-clear setting **on** → still nudge only (setting cannot override the lock).
- [ ] Feature-detect fail → log + nudge; never throw.
- [ ] Tests: table-driven band × interactive × summary-present. No harness required.

---

### Phase 5 — Continuity on SessionStart `clear`

**Goal:** after a clear, the model reads the plan residue and does not redo the last turn.

**Touch:** `src/cli/adapters/claude-code.ts` (forward `source`). `src/cli/types.ts` (`sessionSource` already has `startup|resume|clear`; add `compact` if missing). `context.ts` / context inject path — prepend continuity when `source` is `clear` (and `compact` if that executor is used). `SummaryRenderer` already has Next Steps.

**Do not:** rebuild Endless Mode / bottle. Do not inject the full transcript.

**Checklist**

- [ ] Claude Code SessionStart `source=clear` reaches `contextHandler`.
- [ ] Continuity block includes last `next_steps` when a summary exists.
- [ ] Continuity block includes an explicit do-not-repeat sentence.
- [ ] `source=startup` unchanged (no extra “you just cleared” lie).
- [ ] Excluded projects still inject nothing (`shouldTrackProject`).
- [ ] Codex path does not double-inject (it already has `sessionSource`).
- [ ] Existing context handler tests + a new source=clear fixture.

---

### Phase 6 — `GET /api/latest`

**Goal:** newest observations, existing timeline JSON shape.

**Touch:** `DataRoutes` or `SearchRoutes`. Reuse pagination helper / timeline mapper. No new table.

**Checklist**

- [ ] Response shape matches `GET /api/observations` or documented `GET /api/timeline` — pick one and test equality on a fixture DB.
- [ ] Default limit capped.
- [ ] Loopback unauthenticated (same as other local GETs). If later exposed off-LAN, inherit TV-token rules — **do not** expose `/api/latest` on the TV allowlist in this feature unless Az asks.
- [ ] Route test next to `tests/worker/http/routes/data-routes-*.test.ts`.

---

### Phase 7 — Interactive nudge delivery (sync hook)

**Goal:** the human (and/or the model via USER_HINT) sees “context at 34% — summary saved — `/clear` to continue from the plan.”

**Touch:** a **sync** hook that already returns `systemMessage` — most likely `UserPromptSubmit` / `session-init` (`plugin/hooks/hooks.json` timeout 60, not async). Read pending `nudge_clear` for this `contentSessionId`, emit once, mark delivered.

**Do not:** convert Stop to sync to deliver the nudge. Do not use Cursor `followup_message` to auto-submit `/clear`.

**Checklist**

- [ ] Nudge appears at most once per stop-event.
- [ ] Nudge is `systemMessage` (USER_HINT), not stuffed into `additionalContext` unless we deliberately want the model to see it — default **user-visible**; model-visible is an Az ask.
- [ ] No nudge when band missing or summary never landed.
- [ ] Skip widgets / permission prompts unchanged (no `permissionDecision`).
- [ ] Hook-io tests: stdout JSON has `systemMessage`; no raw stderr leak of the token.

---

## 8. If Az picks Plan A instead

Do **not** mix A and B in one `/do`. A would require:

1. Phase 1 as above (measurement is shared).
2. Flip Stop to **sync** in `plugin/hooks/hooks.json` (drop `"async": true`) so a `systemMessage` can land — **user-visible latency**, must be called out in the PR.
3. Hook waits on a worker “landed” endpoint with a hard deadline ≪ 120s; on timeout, **do not clear**.
4. Daemon clear still cannot live in the hook if generation is slow — you will grow a worker path anyway.

Checklist additions vs B:

- [ ] Stop is sync; measured p95 hook wall time on a warm worker.
- [ ] Timeout never clears.
- [ ] Interactive still cannot PTY.

This is why B is the recommendation: A either blocks the user or re-implements B inside the timeout.

---

## 9. Out of scope

- Endless Mode / bottle renderer (`plans/2026-07-17-endless-mode-v1.md`).
- Observer-side history compaction (30% reinject of the **observer** window — different product).
- Ungating skip / permission widgets.
- Telegram as notify-bot.
- Changing default Stop `async: true` (unless Az picks A).
- Changelog edits.
- Cursor `followup_message` loops (max 5) as a clear mechanism.
- Exposing `/api/latest` on Observation TV without a separate plan.
- Auto-clear on by default.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Observer slower than 120s | B: wait on write-site, not in the hook. |
| Usage object absent (some platforms / compacted transcripts) | Missing → no-op. Same as today’s empty-assistant skip. |
| Private daemon `op:"reply"` changes | Version pin + ping + fail-silent + default-off. Interactive nudge still works. |
| Clear before summary | Decision is **after** INSERT. Queued is not landed. |
| Double clear / hook re-entry | Existing `stopHookActive` skip. One decision per stop-event id. |
| Interactive user surprised by auto `/clear` | Impossible if Phase 4 checklist holds (setting cannot override interactive). |
| Webhook token leak | Settings file + Bearer header; never log; empty = off. |
| Skip-widget regression | No `permissionDecision` writes; no viewer widget work in this feature. |

---

## 11. Open asks (Az)

Copy of the Notion gate, still open:

1. Confirm **≥30% fire** and **overshoot-above-40 still fire**.
2. Confirm executor **`/clear`** vs `/compact` (one string).
3. Confirm notify-bot **URL + JSON shape** in §6.3 (or send the real contract).
4. Confirm Plan **B** (clock-split) as the `/do` path.

Until those four are answered, this file is the deliverable.

---

## 12. Success for a future `/do` (not this PR)

A session that hits 30–40% context, gets an observer summary, then:

- **Interactive:** user sees a nudge; nothing is typed for them; skip widgets look the same; `/clear` they type themselves continues from next_steps.
- **Daemon (flag on, protocol present):** one `/clear` reply; SessionStart continuity; notify-bot got stop + outcome.
- **Daemon (flag off or protocol missing):** same as interactive (nudge / webhook only). Fail-silent.

This PR succeeds if it is merged as **plan-only** and Az can choose A or B from §5 without rereading the tree.
