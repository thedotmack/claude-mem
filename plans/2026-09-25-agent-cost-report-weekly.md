# Agent Cost Report — weekly rebuild (transcript-measured, Timing-style, dollars)

**Date:** 2026-09-25 (PT)
**For:** Alex Newman
**Status:** GREENED by Alex 2026-09-25 4:42pm PT; merge/publish/version-bump still gated. Decisions G1–G16 are recorded in the green checklist. Nothing implemented yet; the only commits so far are to this plan file.
**Branch / worktree:** `work/cost-report-weekly` at `/workspace/claude-mem/.claude/worktrees/cost-report-weekly`. Never switch branches.
**Execute with:** `/do` on this file, one phase per fresh session, commit at the end of each verified phase.
**Revised 2026-09-25 (PT):** added Phase 2B, agent behavior metrics taken from Alex's own complaints, plus the matching render, verification, and green-checklist items. Status unchanged.
**Revised again 2026-09-25 ~4:35 PM (PT):** Alex scoped a "Wins vs mistakes" section directly under the dollar headline (4:28 PM PT): a cost-of-mistakes line, wins with their cost, and two day-by-day timelines on one time axis. Added in 2.8 (wins and attribution), 2B.9 (mistakes line and timeline data), 3.8 (render), 8.6 (reconciliation). Phase 2B's metric list is now provisional pending the Frustration Arc seat. Out-of-scope section added. Status unchanged.
**Revised 2026-09-25 ~4:40 PM (PT):** Phase 2B reconciled with the Frustration Arc seat's final list (`/workspace/frustration-arc/metrics-ideas.md`). PROVISIONAL removed; M1–M6 merged into 12 patterns (P1–P12) plus 2 supporting metrics, 4 summary tiles. The mistakes line now headlines the low (same-session) figure, with the high figure as an upper bound in Details. Win cost shows "unmeasured" until sessions are linked to PRs. Added rule effectiveness (2B.10), a prerequisites list (0.5), a Frustration Arc comparison in Phase 8 (8.7), and a renumbered green checklist (G1–G16). Status unchanged.
**Revised 2026-09-25 4:42 PM (PT), GREEN:** Alex greened the plan at commit `7f5e9e7d` (relayed by Ori). G1–G16 answers recorded in the green checklist. Plan text reconciled with the picks: G3 (default window = the last 7 full PT days, today excluded), G8 (classifier off by default, $2.00 cap per run when enabled), G11 (win cost "unmeasured" until sessions are linked to PRs; the lineage fallback is dropped), G13 (session id stamped as a commit trailer only, id only, no PR body line), plus G2 (mirrors carry the skill), G4 (Grok Bot "unavailable", no seat count), G10 (Alex's hedging definition), G12 (win = merged PR, published version, or Alex's praise; finished work is not a win). Pushing the work branch and opening the PR are routine. **Merging to `main`, npm publish, and `/version-bump` each still need Alex's separate go.**
**Supersedes:** the rendering-only plan at `/workspace/plans/2026-09-25-agent-cost-report-timing-style.md` (its data basis was `discovery_tokens` and its unit was cents; both are gone). Its mapping tables are reused in Phase 3.
**All times in PT.** All secrets by env var name only. Never read `.env` or settings files for keys.
**Scratch dir for every verification command:** define once per session, `ACR_TMP=${ACR_TMP:-/tmp/acr-weekly}`, then use `$ACR_TMP/p1`, `$ACR_TMP/p2`, … per phase. Phases 3 and 8 read Phase 2 output from `$ACR_TMP/p2`. Nothing under `$ACR_TMP` is committed.

---

## Primary goal

The Claude-Mem plugin skill `agent-cost-report` produces a believable agent cost report for any period, defaulting to the last 7 full days in PT, not counting today (G3). The headline is dollars. The dollars come from Claude Code transcripts (exact per-reply token usage) priced at OpenRouter public list prices, and are labeled ESTIMATED. Measured provider spend appears only when a sanctioned source gives it. The note-taker's own tokens are priced separately and never counted as agent cost. The report looks like the Timing-app mockup: hero number, cost ribbon, five visuals, and a folded Details section.

---

## Settled decisions (do not reopen)

1. **Headline unit is DOLLARS** (settled by Alex via Ori). Hero and totals show dollars to two decimals (`$109.25`). No cents-first display anywhere. Every dollar figure carries its label (measured vs estimated) and its basis, for example "estimated at OpenRouter list prices from measured tokens". This supersedes the cents-under-$1 rule in the earlier plan (`/workspace/plans/2026-09-25-agent-cost-report-timing-style.md:390-408`) and in the brief (`/workspace/timing-report-brief/brief.md:44`).
2. **Default scope = the last 7 full days in PT, not counting today** (G3, Alex 2026-09-25): `end` = the PT midnight that started today (exclusive), `start` = `end − 7 days`, PT day boundaries. The default window never contains a partial day. Any period supported: explicit start/end, a single session, or a single project plus a period.

## Binding constraints (from Alex's original spec, kept as-is)

The current SKILL.md already states these. They stay verbatim in the rewrite (`/workspace/claude-mem/plugin/skills/agent-cost-report/SKILL.md:186-195`):

- Always label estimate vs measured (`cost_basis` = `estimated_usage` or `measured_provider`).
- Always say **measured spend unavailable** when unmatched. Never "$0 spent" for unknown.
- Always use **completed outcomes** as the unit of work (cost per completed outcome).
- Always put Rework under `failure_type` only, never as a work category (also `SKILL.md:82`).
- Always progressive Mem Search (search → timeline → get_observations, `SKILL.md:51-55`); evidence IDs live in the appendix (now the Details section).
- Deliverables stay: self-contained HTML, optional PDF, `report.json`, `line-items.csv`, `evidence.json` (`SKILL.md:163-170`).

Added by this plan, same spirit:

- Note-taker (observer) cost is priced separately from agent cost and never added into the agent headline.
- Keyword-derived category labels are drafts until a review pass confirms them. The label source is recorded.
- Grok Bot seat usage and Mac transcripts are shown as "unavailable" or "extrapolated (low confidence)" until a sanctioned source exists. Never $0, never guessed.
- The live database is never opened for writing. Every run works on a read-only snapshot.

## Out of scope for this plan

- **Auto-lessons at session start** (injecting lessons learned from past mistakes into new sessions) is out of scope. It is a separate claude-mem memory feature with its own plan. This report only measures and shows wins and mistakes; it does not feed anything back into agent sessions.
- **Upstream data fixes** named in 0.5 (claude-mem tagging prompts when it writes them, logging the model id for Grok and Codex, stamping the session id as a commit trailer, keeping Grok Bot chats) are changes to other products or house workflows. This plan lists them as prerequisites and builds only the report side. Each needs its own plan and Alex's go.

---

## Phase 0 — Documentation discovery, allowed facts, and tracking the skill dir

**Goal of the session:** re-verify the facts below with the listed commands, then bring the untracked skill directory into this branch unchanged, so every later phase is a reviewable diff. One commit.

### 0.1 Allowed facts and APIs (verified 2026-09-25 by the planner's subagents)

#### A. Transcript workflow (the measured-token source)

| Fact | Citation |
|---|---|
| Period is any PT window, end exclusive; invocation `python3 fetch_prices.py` then `python3 weekly_report.py 2026-09-18 2026-09-26` | `/workspace/weekly-cost-workflow/WORKFLOW.md:3,7-8` |
| Pipeline steps 1–10: snapshot DB read-only → sessions/seats → outcomes → keyword labels → active minutes → transcripts deduped → price at list → observer priced separately → extrapolate unmeasured → optional cloud cross-check | `WORKFLOW.md:15-24` |
| Transcript glob `~/.claude/projects/**/*.jsonl`, prefiltered by mtime; project dir = path segment after `/.claude/projects/` | `parse_transcripts.py:16-19` |
| Only `type == "assistant"` lines with `timestamp`; window test `s <= t < e` | `parse_transcripts.py:26-28` |
| Usage fields read: `message.usage.input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`, `cache_read_input_tokens`; optional `costUSD` | `parse_transcripts.py:34-38` |
| 5m cache write derived as `cache_write - cache_write_1h` | `weekly_report.py:94` |
| Dedup key `(message.id, requestId)` | `parse_transcripts.py:15,29-31` |
| Session key = transcript `sessionId` (subagent files share the parent's id); `isSidechain` and `message.model` kept | `parse_transcripts.py:32-33` |
| Real transcript line proves the field names: `type:"assistant"`, `timestamp`, `sessionId`, `requestId`, `isSidechain`, `cwd`, `message.id`, `message.model:"claude-fable-5-1"`, `message.usage{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, cache_creation{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}, output_tokens}`. `costUSD` absent on sampled lines. | Durable fact: the field list itself, cross-checked against `parse_transcripts.py:24-38`. Sampled at `/home/box/.claude/projects/-workspace-claude-mem--claude-worktrees-cost-report-weekly/0e3f6cc9-3feb-4e4a-b20e-cc3704ef868d/subagents/agent-aa1975f524bd06ab3.jsonl:13` on 2026-09-25; that file may be pruned (30-day retention), so re-verify with `grep -m1 -l cache_creation ~/.claude/projects/**/*.jsonl` on any current transcript |
| 1h cache writes are real in the data: 259 of 802 rows have `cache_write_1h > 0` | `out/transcript_usage.json` (counted) |
| Prices: `GET https://openrouter.ai/api/v1/models`, no key; stores `prompt`, `completion`, `input_cache_read`, `input_cache_write` × 1e6 as USD per MTok, keyed by OpenRouter id | `fetch_prices.py:3-7`; `out/openrouter_prices.json` sample `anthropic/claude-fable-5.1 = {input 10.0, output 50.0, cache_read 0.25, cache_write 12.5}` |
| Model key normalisation `norm()` and price fallback `rate()` (cache_read = input×0.1, cache_write = input×1.25 when missing; models starting with `<` unpriced) | `weekly_report.py:23-42` |
| Cost formula: `(input×in + output×out + cw5×cache_write + cw1h×in×2 + cache_read×cache_read_rate)/1e6`, integer micro-dollars | `weekly_report.py:91-105` |
| Live OpenRouter data now exposes an extra `input_cache_write_1h` key on some models (seen on `anthropic/claude-opus-5.5`) that `fetch_prices.py` does not store | subagent live probe of `/api/v1/models`; not in the docs field list at https://openrouter.ai/docs/guides/overview/models |
| Read-only snapshot pattern: open live DB with `file:...?mode=ro` URI, `src.backup(dst)` to `snap/snap.db`, work only on the snapshot | `weekly_report.py:15-18` |
| Sessions from `sdk_sessions` by `started_at_epoch`; device = `coalesce(origin_device_id,'local-box')` over observations, session_summaries, user_prompts | `weekly_report.py:45-53` |
| Ship regex and completed-summary rule (`len(completed) > 20`) | `weekly_report.py:65,74-79` |
| Observer tokens deduped on `(memory_session_id, created_at_epoch, discovery_tokens)`, priced at input rate only, kept separate as `observer_note_taker_est_usd` | `weekly_report.py:70-73,229` |
| `CAT_RULES` (Incident, Experiment, Investigation, Maintenance, Bug fix, Feature; default Investigation), `FAIL_RULES` (Rework, Recovery after miss, Wrong turn), Looping = same 80-char prompt prefix ≥3 | `weekly_report.py:109-127` |
| `active_minutes(stamps, gap_min=15)` | `weekly_report.py:128-133` |
| Mac extrapolation: `ratio = measured agent USD per 1M observer tokens` over transcript sessions, applied to sessions with no transcript, label begins `EXTRAPOLATED (low confidence)` | `weekly_report.py:239-246` |
| Summary schema and writers (`summary.json`, `projects.csv`, `sessions.csv`, `models.csv`, `tables.json`) | `weekly_report.py:207-251` |
| Hard-coded things to drop: `/workspace/reports/mem-invoice/PRICE-TABLE.json` (`:21`), device UUIDs (`:54-56`), `/tmp/gateway-server.log` (`:158-168`), DST-fragile `-7h` offset in `cloud_page_stats.py:12` | as cited |
| Research numbers confirmed in `out/summary.json`: `sessions` 80, `substantive_sessions` 47, `projects` 23, `seats` 3 (box 23, remote A 52, remote B 5), `outcomes.sessions_with_completed_summary` 26, `outcomes.ship_events_distinct` 5, `hours.agent_session_hours` 13.8, `tokens.agent_tokens_measured_box_transcripts` 81,783,140, `spend.agent_api_equivalent_est_usd` 109.25, `spend.extrapolated_unmeasured_sessions_usd` 54.69, `spend.weekly_total_api_equiv_est_usd` 163.94, `spend.observer_note_taker_est_usd` 5.84, `window.end_exclusive` "2026-09-26 00:00 PT" | `out/summary.json` |
| The 1.9-cent mistake: old report priced `discovery_tokens`, the note-taker's own tokens | `NOTION-PAGE.md:5,8,23,34` |
| Discrepancy: `WORKFLOW.md:20` says join by file name, code joins on transcript `sessionId` = `content_session_id` | `parse_transcripts.py:32`, `weekly_report.py:137` |
| Discrepancy: research window is 8 days (Sep 18–26 exclusive) though the Notion page says "Sep 18–25" | `WORKFLOW.md:8`, `NOTION-PAGE.md:5,53` |

#### B. Timing-style design

| Fact | Citation |
|---|---|
| Section order: hero + sub-line + story; cost ribbon; "Where the money went" donut + ranked list; "Day by day" stacked bars, empty days say so; "How much was useful" ring + checks + one failure sentence; "What got done" rows most expensive first; "Worth your attention" ≤3 actions; folded Details (evidence IDs, session IDs, tokens, model and price per MTok, confidence, risk, failure table, CSV) | `/workspace/timing-report-brief/brief.md:33-42` |
| Honesty rules: ESTIMATE tag on every dollar figure; "Measured spend unavailable" never shown as $0; footer states the method; unfinished work not counted as finished; the failure is named; evidence IDs kept in Details | `brief.md:53-59` |
| Self-contained HTML, no outside deps | `brief.md:48`; `mockup.html` has zero `http`, `<link>`, `<script>`, `@import` |
| Generator is stdlib-only (`json, math, html`), f-strings, inline SVG; no functions except `cents()` and `usd()`; every block and every hard-coded value is listed | `build_mockup.py:2,9-10`; blocks at `:3-5, 23-40, 41-45, 47-56, 58-73, 75-85, 87-92, 94-96, 98-177` |
| Known bugs to fix in the port: `failure_economics[0]` assumes a list (`:5`); ribbon width `w-2` can go negative (`:31`); `max()` unguarded (`:77`); only `stripe-Feature` pattern (`:39`); `STAT` map lacks abandoned/blocked (`:76`); day chart fits exactly 3 days (`:59-73`) | as cited |
| Screenshot uses Playwright from `/tmp/pwenv`, PNG only, no PDF | `shot.py:1-6` |
| Timing conventions copied: sidebar with colored dots and pill totals, blue headline, green score ring, stacked day bars, donut + list | `refs/SOURCES.md:4-10`; `refs/01-stats-overview.png`, `refs/04-reports-easy.png` |
| Earlier plan mapping table (fields → visuals) and its still-valid guards | `/workspace/plans/2026-09-25-agent-cost-report-timing-style.md:97-128` (mapping), `:146-154` (anti-patterns), `:202-207` (render checks), `:253-263` (print CSS), `:39-60` (generalisation table) |

#### C. Claude-mem schema and code (this repo, worktree paths)

| Fact | Citation |
|---|---|
| Table names are `sdk_sessions`, `session_summaries`, `observations` (no `sessions`/`summaries`); migrations are inline `ensure*()` methods, no migrations dir | `src/services/sqlite/SessionStore.ts:1028-1080` |
| `sdk_sessions`: `content_session_id`, `memory_session_id`, `project`, `platform_source`, `started_at(_epoch)`, `completed_at(_epoch)`, `status`, `custom_title`, `observed_model`, `observed_billing`. No `cwd`, no `origin_device_id`; rows do not sync | `SessionStore.ts:1028-1042, 1833, 1897-1900, 2948`; `src/services/sync/SyncApply.ts:124-131` |
| `session_summaries`: `request, investigated, learned, completed, next_steps, files_read, files_edited, notes, prompt_number, discovery_tokens, created_at(_epoch), origin_device_id, origin_local_id, sync_rev` | `SessionStore.ts:1064-1078, 1122, 1502, 589-611` |
| `observations`: `type, title, subtitle, facts, narrative, concepts, prompt_number, discovery_tokens, created_at(_epoch), generated_by_model, origin_device_id` | `SessionStore.ts:1048-1057, 1321-1327, 1494, 1877, 589-611` |
| `discovery_tokens` = the observer LLM's own usage for the compression call (Claude: delta of cumulative in+out; OpenAI-compatible: `tokensUsed`; OpenRouter: `usage.total_tokens`) | `src/services/worker/ClaudeProvider.ts:415-421,455`; `src/services/worker/OpenAICompatibleProvider.ts:316-332,376-388`; `src/services/worker/OpenRouterProvider.ts:618-651` |
| The same per-turn `discovery_tokens` value is written to every observation row in the batch, so summing observations overcounts; sum `session_summaries` or dedup | `src/services/worker/agents/ResponseProcessor.ts:489-498`; `SessionStore.ts:3133-3183` (`:3176`) |
| `origin_device_id` NULL = this device; non-NULL = replica from the sync hub; device id minted with `randomUUID()` and persisted in settings | `SessionStore.ts:574-579`; `src/services/sync/CloudSync.ts:479,1649-1665`; `SyncApply.ts:744-748,828,914-918` |
| Join key: `sdk_sessions.content_session_id` == Claude Code hook `session_id` == transcript basename `<sessionId>.jsonl` | `src/cli/adapters/claude-code.ts:23,30`; `src/cli/handlers/session-init.ts:113-121`; `SessionStore.ts:2935-2938` |
| `project` = basename of git repo root, or `<repo>/<worktree>` inside a worktree | `src/utils/project-name.ts:53-90,100-125` |
| DB path resolution and WAL mode (snapshot must use the backup API, not a file copy) | `src/shared/paths.ts:20-66`; `src/services/sqlite/connection.ts:53-55` |
| Timestamps: `*_epoch` are UTC epoch **milliseconds**, `*_at` are ISO `Z` strings | `SessionStore.ts:2892-2893, 2938, 3069-3070, 3137-3138` |
| Worker port 37700 (+ uid%100); read endpoints have no session-by-date-range route, so read-only SQLite is the practical path | `src/shared/SettingsDefaultsManager.ts:175`; `src/services/worker/http/routes/DataRoutes.ts:110-129` |
| Live probe (read-only) for Sep 18–26 PT: 81 `sdk_sessions` (80 claude, 1 codex), 24 projects; observations from 3 devices (NULL + 2 UUIDs) | subagent SQL against `/home/box/.claude-mem/claude-mem.db` opened `mode=ro` |
| Cloud sync replicates rows, never transcripts; all transcript readers are local-path code | `CloudSync.ts:1-8`; `src/shared/transcript-parser.ts:9-17`; `src/services/context/ObservationCompiler.ts:230` |
| OpenRouter key names in plugin code: `CLAUDE_MEM_OPENROUTER_API_KEY` (settings) and `OPENROUTER_API_KEY` (env fallback) | `SettingsDefaultsManager.ts:34-38`; `OpenRouterProvider.ts:374-375`; `src/shared/EnvManager.ts:78` |

#### D. Skill packaging and sync

| Fact | Citation |
|---|---|
| Current SKILL.md frontmatter has `name`, `description`, no `allowed-tools`; sections listed by line | `/workspace/claude-mem/plugin/skills/agent-cost-report/SKILL.md:1-8`, outline `:10-215` |
| Cost model priced `discovery_tokens` (the bug) | `SKILL.md:89,124,152` |
| Line-item schema and status set `{shipped, completed, in_progress, abandoned, blocked}` | `SKILL.md:134-159` |
| All six copies (plugin, 4 mirrors, house) are byte-identical, md5 `7c040aa496887a2136f85a0ad26c5c39` | `md5sum` by subagent |
| Skill dir is untracked, not gitignored, never committed | `git -C /workspace/claude-mem status --short --untracked-files=all -- plugin/skills/agent-cost-report` → `??`; `check-ignore` empty |
| Untracked dirs still get installed: `sync-marketplace.cjs` mirrors the repo root and `plugin/` with only `.gitignore` excludes; `package.json` `files` includes `plugin/skills` | `scripts/sync-marketplace.cjs:34-35,89-91,103-105`; `package.json:50,52,61-63` |
| Bundled-script convention: node scripts invoked as `node "${CLAUDE_SKILL_DIR}/standup.mjs"` or "resolve the directory containing this SKILL.md" then `node <skill-directory>/scripts/x.mjs` | `plugin/skills/standup/SKILL.md:31-34`; `plugin/skills/mode-creator/SKILL.md:81-90` |
| Plugin-root shell idiom for hooks: `${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}` with cache-dir fallbacks | `plugin/hooks/hooks.json:24` |
| `allowed-tools` frontmatter examples | `plugin/skills/cloud-sync/SKILL.md:4-7`; `plugin/skills/standup/SKILL.md:5-10` |
| No repo script copies skills to the mirror plugins; mirror `mem-search` copies are host-adapted (different md5s) | grep over `scripts/`, `package.json`; md5 by subagent |
| `/do` executes one phase per fresh session and commits only after verification | `plugin/skills/do/SKILL.md:14-16,32,36-39` |
| Tooling on the box: Python 3.13.5 with `sqlite3` (lib 3.46.1) and `zoneinfo`; `google-chrome` 151 at `/usr/bin/google-chrome`; `pdftoppm`, `pdftotext`; Pillow 12.3, numpy 2.2 in system python; no `weasyprint`, no `playwright` in system python (Playwright only in `/tmp/pwenv`); no `sqlite3` CLI | planner check 2026-09-25 |

#### E. External sources (public docs)

| Fact | Citation |
|---|---|
| `GET https://openrouter.ai/api/v1/key` (Bearer inference key) returns `data.usage`, `usage_daily` ("current UTC day"), `usage_weekly` ("current UTC week (Monday-Sunday)"), `usage_monthly` ("current UTC month"), `limit`, `limit_remaining`, `is_free_tier`, `rate_limit` (always -1) | https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key |
| `GET https://openrouter.ai/api/v1/activity?date=YYYY-MM-DD` gives per-day per-model `usage` USD, `requests`, `prompt_tokens`, `completion_tokens`, last 30 days; needs a **management/provisioning key**, not the inference key | https://openrouter.ai/docs/api/api-reference/analytics/get-user-activity-grouped-by-endpoint |
| `GET https://openrouter.ai/api/v1/generation?id=` gives `total_cost` per generation; needs a generation id, which transcripts do not carry | https://openrouter.ai/docs/api-reference/get-a-generation |
| Grok Bot is Cursor's cloud agent; paid access "includes Weekly usage" that "resets weekly"; usage visible only on the plan screen; no API or export documented | https://cursor.com/docs/grok-bot; https://cursor.com/help/grok-bot/plans |
| xAI Management API `POST /v1/billing/teams/{team_id}/usage` covers xAI API keys only; the house has "No xAI key" for Grok Bot | https://docs.x.ai/developers/rest-api-reference/management/billing; `/home/box/agent-data/org/policies.md:65-67` |
| Claude Code keeps transcripts under `~/.claude/projects/` for 30 days by default (`cleanupPeriodDays`, minimum 1) | https://code.claude.com/docs/en/data-usage; https://code.claude.com/docs/en/claude-directory |

#### UNVERIFIABLE (stated, not assumed)

- Whether Claude Code sets `${CLAUDE_SKILL_DIR}` in the shell. Only `standup/SKILL.md:33` relies on it. Use the mode-creator wording ("resolve the directory containing this SKILL.md") as the primary path and `${CLAUDE_SKILL_DIR}` as a convenience.
- The house's canonical "secure secret request" mechanism. Only `/home/box/agent-data/workflows/usage-percentage/SKILL.md:62` names "secret-request / existing vault flows". No dedicated doc found. `printenv | grep -c OPENROUTER` = 0 in the planning session.
- Which `origin_device_id` UUID is Alex's Mac. Reading it needs the settings file on that machine; not opened.
- Whether `costUSD` ever appears on transcript lines (absent on sampled lines; read optionally).
- OpenRouter web activity CSV export (page requires login).
- Whether the Mac's `cleanupPeriodDays` was changed from the 30-day default.
- Whether uv-managed Python on non-box hosts can run the scripts. The box has system Python 3.13.5; other hosts are not verified.

### 0.2 Get the skill dir tracked on this branch

Copy from the main checkout (it is absent in this worktree) and commit unchanged as the baseline:

```bash
cd /workspace/claude-mem/.claude/worktrees/cost-report-weekly
mkdir -p plugin/skills/agent-cost-report
cp /workspace/claude-mem/plugin/skills/agent-cost-report/SKILL.md plugin/skills/agent-cost-report/SKILL.md
md5sum plugin/skills/agent-cost-report/SKILL.md /workspace/claude-mem/plugin/skills/agent-cost-report/SKILL.md /home/box/agent-data/workflows/agent-cost-report/SKILL.md
git add plugin/skills/agent-cost-report/SKILL.md
git commit -m "chore(skills): track agent-cost-report skill as-is (baseline before rebuild)"
```

Mirrors (`claude-mem-cursor`, `claude-mem-grok-bot`, `cowork`, `openclaw`) are NOT added in Phase 0. Phase 7 decides copies after the content is final.

### 0.3 Verification checklist

```bash
# facts still hold
python3 -c "import sqlite3, zoneinfo; print(sqlite3.sqlite_version)"
google-chrome --version
sed -n '15,18p' /workspace/weekly-cost-workflow/weekly_report.py     # snapshot pattern
sed -n '91,96p' /workspace/weekly-cost-workflow/weekly_report.py     # cost formula
sed -n '24,38p' /workspace/weekly-cost-workflow/parse_transcripts.py # usage fields
grep -n 'content_session_id' src/services/sqlite/SessionStore.ts | head -3
# baseline commit present, all three md5s equal
git log --oneline -1 -- plugin/skills/agent-cost-report/SKILL.md
```

### 0.4 Anti-pattern guards

- Do not edit SKILL.md content in Phase 0. Baseline first.
- Do not add mirrors yet (mirrors are written in Phase 7, per G2).
- Do not open any settings file to find device ids or keys.

### 0.5 Prerequisites for behavior counts, mistake cost, and win cost

From Frustration Arc's "Data hygiene the report needs" (`/workspace/frustration-arc/metrics-ideas.md:37-41`). Until each one is met, the report shows the listed fallback, never a guess.

| # | Prerequisite | Why | What this plan builds | Gate | Until it is met the report shows |
|---|---|---|---|---|---|
| R1 | Keep Alex's chat turns with timestamps on every agent surface | Grok Bot chats vanish from the box after Sep 16, so the last week cannot be scored firsthand (`trend.md`) | Reads whatever human turns exist (box transcripts, claude-mem `user_prompts`) | Alex chose to keep Grok Bot chats (G14, 2026-09-25). The retention or export mechanism is an upstream change with its own plan; until it lands the report reads whatever human turns exist | Grok Bot episodes "unavailable"; rule effectiveness "not enough data" where prompts are missing |
| R2 | Tag bot-authored prompts | About 31% of "user" messages were agents (`MI:7`) | Read-time tagger in `acr/behavior.py` (2B.1), with tests. **Required before any behavior count from "user" messages.** Write-time tagging in claude-mem is an upstream change | Upstream write-time tagging: separate plan, needs Alex's go | "unavailable (prompts not tagged human vs bot)" for every count that reads user messages |
| R3 | Log the model id on every call, including Grok and Codex | Both were assumed in Frustration Arc's study (`MI:40`) | Uses `message.model` from box transcripts (already there, Phase 1); labels anything else `model: assumed` | Upstream logging for Grok and Codex: outside this plan | P3 counts only turns with a logged model; the rest are listed as "model not logged" |
| R4 | Link session → PR → release | Win cost cannot be measured without it (`MI:32`) | Reads the session id from the commit trailer `Claude-Session: <content_session_id>` on the commits of a merged PR (G13: trailer only, value is the bare id, no PR body line); release = npm version ↔ tag ↔ merge commit | Approved in principle by G13 (Alex 2026-09-25: trailer, id only). Changing the house ship flow (`/do`, babysit, version-bump) to stamp the trailer is an upstream change with its own plan; the ids become visible in public commits | Win cost "unmeasured" (2.8) |

Order: R2 is built in Phase 2B and must pass its tests before any other Phase 2B count that reads user messages. R1, R3 (Grok/Codex), and R4 are gated steps listed under "What ships".

---

## Phase 1 — Data pipeline part 1: snapshot, period, transcript collector, prices

**Goal of the session:** a `scripts/` directory inside the skill with stdlib-only Python that turns a period into measured token usage and a price table. No rendering. One commit.

### 1.1 Where scripts live and how SKILL.md invokes them

Copy the mode-creator convention (`plugin/skills/mode-creator/SKILL.md:81-90`): SKILL.md says "resolve the absolute directory containing this SKILL.md; all helper paths are relative to that directory", then invokes `python3 "<skill-dir>/scripts/acr.py" ...`. Offer `${CLAUDE_SKILL_DIR}` as the shortcut the way `standup/SKILL.md:33` does. Layout:

```
plugin/skills/agent-cost-report/
  SKILL.md
  scripts/
    acr.py            # single CLI entry: collect | prices | rollup | review | render | pdf | sync-check
    acr/              # package, stdlib only
      period.py       # PT window parsing and defaults
      snapshot.py     # read-only DB snapshot (backup API)
      transcripts.py  # copied from parse_transcripts.py:7-38 (+ :39-57 codex)
      prices.py       # copied from fetch_prices.py:3-7 plus norm()/rate() from weekly_report.py:23-42
      ...             # rollup.py, labels.py, render.py, pdf.py added in later phases
    tests/            # python -m unittest discover; fixtures under tests/fixtures/
```

Interpreter: `python3`, stdlib only (`json, csv, sqlite3, zoneinfo, urllib.request, glob, re, datetime, argparse, hashlib, subprocess`). Phase 0 proved every one of these on the box. No pip installs.

### 1.2 Period arguments (copy `parse_transcripts.py:8-14` and `weekly_report.py:11-14`, add defaults)

- `--start YYYY-MM-DD --end YYYY-MM-DD` are PT calendar days, end exclusive, converted with `ZoneInfo("America/Los_Angeles")` to UTC epoch ms (DB) and aware datetimes (transcripts).
- Default when neither is given (G3, settled): `end` = the PT midnight that started today, so today is excluded; `start` = `end − 7 days`. That is the last 7 full PT days. The default window never has a partial day, so `partial_last_day` is false by construction. It is true only for an explicit `--end` later than today's PT date (for example the research window Sep 18–26 exclusive, run on Sep 25); then the report tags the last day "partial, generated HH:MM PT". Unit test: with a fixed clock of 2026-09-25 16:42 PT, the default window is `start_pt=2026-09-18`, `end_exclusive_pt=2026-09-25`, `partial_last_day=false`.
- `--session <content_session_id>`: single session, no period filter on the DB, transcript filter by that `sessionId` only.
- `--project <name>` with a period: filter `sdk_sessions.project` and transcript rows joined to those sessions.
- Every output carries a `window` block copied from `weekly_report.py:207-238` shape: `start_pt`, `end_exclusive_pt`, `start_epoch_ms`, `end_epoch_ms`, `generated_at_pt`, `partial_last_day: bool`.

### 1.3 Read-only snapshot (copy `weekly_report.py:15-18`)

- Resolve the DB path the way `src/shared/paths.ts:20-66` does: `$CLAUDE_MEM_DATA_DIR`, else `~/.claude-mem`, file `claude-mem.db`. Do not read settings.json for it; if the env var is unset, use the default path.
- Open with `sqlite3.connect("file:<path>?mode=ro", uri=True)`, then `src.backup(dst)` into `<outdir>/snapshot.db`. WAL mode (`connection.ts:53-55`) is why a plain file copy is wrong.
- The live connection is closed immediately after the backup. Every later query hits the snapshot only.

### 1.4 Transcript collector (copy `parse_transcripts.py:7-38` verbatim, then extend)

Keep: glob, mtime prefilter, `"usage"` prefilter, `type == "assistant"`, timestamp parse with `Z → +00:00`, window test `s <= t < e`, dedup `(message.id, requestId)`, fields `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`, `cache_read_input_tokens`, `costUSD` optional, `sessionId`, `isSidechain`, `model`. Also copy the Codex reader `:39-57`.

Add (all from the real line at Phase 0 A): `cwd` (for project fallback), `cache_creation.ephemeral_5m_input_tokens` read directly when present (fallback `cache_write - cache_write_1h` as `weekly_report.py:94`), and a `device` field set to `"local"` (the collector only ever sees the machine it runs on). Output: `usage.json` with rows `{src, file, dir, cwd, session, sidechain, model, ts, input, output, cache_write, cache_write_1h, cache_write_5m, cache_read, cost_usd_reported, device}` plus a `collector` block `{host_label, glob, files_seen, rows, dedup_dropped, window}`.

`host_label` is `platform.node()`; never a device UUID from settings.

### 1.5 Prices (copy `fetch_prices.py:3-7` and `weekly_report.py:23-42`)

- `acr.py prices` fetches `GET https://openrouter.ai/api/v1/models` with `urllib.request` (no key) and stores per model `{input, output, cache_read, cache_write, cache_write_1h}` USD per MTok. `cache_write_1h` comes from `pricing.input_cache_write_1h` when present (live data shows it on some Anthropic models), else null.
- `rate(model)` copied from `weekly_report.py:31-42`, with one change: 1h cache write price = explicit `cache_write_1h` if present, else `2 × input` (the old rule at `weekly_report.py:95`). Record which rule fired in `price_source`.
- `--prices <file>` lets a run use a saved price snapshot (needed for the Phase 8 comparison). The file is written to `<outdir>/prices.json` with `fetched` timestamp and `source` URL, so the report can state the pricing basis and date.
- Offline: if the fetch fails and no `--prices` is given, stop with a clear error. Do not silently price at zero.

### 1.6 Verification checklist

```bash
ACR_TMP=${ACR_TMP:-/tmp/acr-weekly}; mkdir -p $ACR_TMP/p1
cd plugin/skills/agent-cost-report
python3 scripts/acr.py prices --out $ACR_TMP/p1 && python3 -c "import json;d=json.load(open('$ACR_TMP/p1/prices.json'));print(d['models']['anthropic/claude-fable-5.1'])"
python3 scripts/acr.py collect --start 2026-09-18 --end 2026-09-26 --out $ACR_TMP/p1
python3 - <<PY
import json;r=json.load(open('$ACR_TMP/p1/usage.json'))['rows']
print(len(r), sum(x['input']+x['output']+x['cache_write']+x['cache_read'] for x in r))
PY
# expect ~802 rows and ~81,783,140 tokens (Phase 0 A), same dedup rule as parse_transcripts.py
python3 -m unittest discover -s scripts/tests -v
grep -rn "mode=ro" scripts/acr/snapshot.py
grep -rn "^import\|^from" scripts/acr/*.py | grep -v -E "json|csv|sqlite3|zoneinfo|urllib|glob|re$|re,|datetime|argparse|hashlib|subprocess|os|sys|pathlib|platform|collections|math|html|typing|unittest|dataclasses|shutil|tempfile" || echo "stdlib only"
ls -la ~/.claude-mem/claude-mem.db*   # mtime of the live DB unchanged by the run
```

Unit tests to write (fixtures are tiny hand-made jsonl lines using the exact field names from Phase 0 A): dedup on `(message.id, requestId)`; window edge `t == end` excluded, `t == start` included; 1h/5m split; PT default window arithmetic across a DST boundary (Nov 1 2026); `--session` filter; price fallback rules.

### 1.7 Anti-pattern guards

- Never open the live DB without `mode=ro`. Never `ATTACH`, `VACUUM`, or write to it.
- Never price `discovery_tokens` here. This phase does not read that column at all.
- No third-party imports. No `requests`, no `pandas`.
- No hard-coded absolute paths (`/workspace/reports/...`, `/tmp/gateway-server.log`) and no device UUIDs.
- No `-7*3600` offsets. `zoneinfo` only.
- Do not read `~/.claude/settings.json` or `~/.claude-mem/settings.json` for anything.

---

## Phase 2 — Data pipeline part 2: session rollup, outcomes, observer cost, labels, review

**Goal of the session:** turn the snapshot plus `usage.json` into `report.json`, `line-items.csv`, `evidence.json` with drafted labels, plus a review file. One commit.

### 2.1 Sessions, devices, evidence (copy `weekly_report.py:44-86`)

- Sessions: `SELECT * FROM sdk_sessions WHERE started_at_epoch >= :S AND < :E` (or `content_session_id = :id`, or `project = :p`). Key by `memory_session_id`, fallback `nomem-<id>` (`weekly_report.py:45-46`).
- Devices: `coalesce(origin_device_id,'local')` over `observations`, `session_summaries`, `user_prompts` in window (`:48-53`). Label devices as `local` and `remote-1`, `remote-2` in first-seen order. Never print the UUIDs in the manager HTML; put them in Details as short hashes.
- Evidence per session: observations, summaries, prompts, tool_uses in window (`:59-62`); ship regex (`:65`); ship titles only for `type in (feature, bugfix, change)` (`:74-75`); completed summary when `len(completed) > 20` (`:79`); timestamp collection for hours (`:69,78,83,86`).
- Join transcripts to sessions on `usage.session == sdk_sessions.content_session_id` (`:137`, Phase 0 C join key). Rows that match no session go to `unmatched_transcripts` (`:151-156`), still counted in measured tokens and dollars, and listed in Details.

### 2.2 Agent cost and observer cost, kept apart (copy `weekly_report.py:91-105, 70-73, 200-206, 228-235`)

- Agent cost per transcript row = `api_equiv(r)` with the Phase 1 `rate()`; accumulate in integer micro-dollars per session and per model.
- Observer cost: `discovery_tokens` deduped on `(memory_session_id, created_at_epoch, discovery_tokens)`, priced at the `generated_by_model` input rate (`:70-73`). Store as `spend.observer_note_taker_est_usd`. It is never added to `spend.agent_estimated_usd` and never appears in the hero. It gets one line in the Details section: "Note-taker (observer) cost, separate: $X.XX estimated".
- `spend` block in `report.json`:
  - `agent_estimated_usd` (measured tokens × list price, label `ESTIMATED`)
  - `agent_measured_usd` = `null` with `measured_status: "unavailable"` until Phase 4 fills it
  - `extrapolated_unmeasured_usd` with label `EXTRAPOLATED (low confidence)` (copy `:239-246`), and `extrapolation_basis` text
  - `observer_note_taker_est_usd` (separate)
  - `grok_bot_usage: {status: "unavailable"}` (Phase 6 may change the shape, never the never-$0 rule)
  - `headline_usd` = `agent_estimated_usd` (box measured tokens) and `headline_label` = "estimated at OpenRouter list prices from measured tokens"
  - `total_estimate_usd` = agent estimated + extrapolated, with both parts shown separately wherever the total is shown.

### 2.3 Outcomes, kinds of work, active time (copy `weekly_report.py:109-133, 140-150, 170-199`)

- Kinds of work: `CAT_RULES` order and default (`:109-114`). Failure signals: `FAIL_RULES` (`:116-118`) plus Looping (`:126`). Rework stays under `failure_type` only.
- `trivial` sessions (`:149`) are excluded from "real work" counts and listed in Details.
- Active minutes: `active_minutes(stamps, 15)` (`:128-133`); agent-hours = sum per session; wall-clock = union.
- Outcomes are the unit: one line item per session with a completed summary or ship event; a session with neither is `in_progress` or `abandoned` (abandoned when `status` is completed but no completed summary and no ship). Statuses stay `{shipped, completed, in_progress, abandoned, blocked}` (`SKILL.md:134-159`).
- Line item fields = the current schema (`SKILL.md:136-159`) with these changes: `discovery_tokens` renamed `observer_tokens` and moved to Details only; new `agent_tokens {input, output, cache_write_5m, cache_write_1h, cache_read}`; new `model_prices_usd_per_mtok`; `cost_basis` per item ∈ `estimated_usage | measured_provider | extrapolated`; new `label_source` (see 2.4); new `device`.

### 2.4 Review step for keyword labels (new)

Keyword labels are drafts. Before labels enter a manager report, a review pass confirms them.

- `acr.py rollup` writes `labels.review.json`: one entry per line item with `draft_category`, `draft_failure_signals`, the matched keyword, the head/tail text used (`weekly_report.py:119-127`), and `label_source: "keyword"`.
- `acr.py review --apply <reviewed.json>` merges confirmed labels back and sets `label_source` to `llm` or `human`, with `reviewed_by` (model id or "Alex") and `reviewed_at_pt`.
- SKILL.md tells the orchestrator to do the review with the progressive mem-search flow: for each line item, use `get_observations` on the cited evidence IDs (not whole timelines), confirm or change `category` and `failure_type`, and record the decision. Items left unreviewed keep `label_source: "keyword"` and render with a small "draft label" mark in the report. The report footer counts them: "N of M labels reviewed".
- Nothing in the render path may hide a `keyword` label as if it were confirmed.

### 2.5 Outputs

- `report.json`: `window`, `scope` (`{kind: period|session|project, ...}`), `spend`, `totals` (sessions, real-work sessions, projects, devices, finished outcomes, ship events, agent hours, tokens by type, cost per completed outcome, waste rate, recovery share as in `SKILL.md:88-109`), `by_category`, `by_day` (every PT day in the window, empty days present with zero and `no_agent_work: true`), `by_model`, `by_device`, `line_items`, `failure_economics` (always a list, possibly empty), `attention` (≤3, drafted from the biggest waste, the biggest unfinished item, and any unpriced model), `labels {reviewed, total}`, `pricing {source, fetched, rule_1h}`, `unmatched_transcripts`, `unpriced_models`.
- `line-items.csv`: one row per line item, columns = the schema above.
- `evidence.json`: per line item, the observation and summary IDs cited, short titles, `observer_tokens`, `generated_by_model`, `memory_session_id`, `content_session_id`.

### 2.6 Verification checklist

```bash
ACR_TMP=${ACR_TMP:-/tmp/acr-weekly}; mkdir -p $ACR_TMP
cd plugin/skills/agent-cost-report
OUT=$ACR_TMP/p2
python3 scripts/acr.py prices --out $OUT && python3 scripts/acr.py collect --start 2026-09-18 --end 2026-09-26 --out $OUT && python3 scripts/acr.py rollup --start 2026-09-18 --end 2026-09-26 --out $OUT
python3 - <<PY
import json;d=json.load(open('$ACR_TMP/p2/report.json'))
t=d['totals'];s=d['spend'];print(t['sessions'],t['real_work_sessions'],t['projects'],t['devices'],t['finished_outcomes'],t['ship_events'],t['agent_hours'])
print(s['agent_estimated_usd'],s['extrapolated_unmeasured_usd'],s['observer_note_taker_est_usd'],s['agent_measured_usd'],s['measured_status'])
assert s['agent_measured_usd'] is None and s['measured_status']=='unavailable'
assert all(li['label_source']=='keyword' for li in d['line_items'])
assert len(d['by_day'])==8
PY
# expect close to 80 / 47 / 23 / 3 / 26 / 5 / 13.8 and $109.25 / $54.69 / $5.84 (tolerances in Phase 8)
python3 scripts/acr.py rollup --session <one content_session_id from sessions> --out $OUT/single && test -s $OUT/single/report.json
python3 scripts/acr.py rollup --project claude-mem --start 2026-09-18 --end 2026-09-26 --out $OUT/proj && test -s $OUT/proj/report.json
grep -c '"observer_note_taker_est_usd"' $OUT/report.json
python3 -m unittest discover -s scripts/tests -v
```

Unit tests: observer dedup (three observation rows with the same per-turn value count once); the observer total never changes `agent_estimated_usd`; `by_day` covers every day incl. empty ones; extrapolation only touches sessions with no transcript; `label_source` starts as `keyword` and only `review --apply` changes it; `measured_status` defaults to `unavailable`.

### 2.7 Anti-pattern guards

- `discovery_tokens` never feeds `agent_estimated_usd`, `headline_usd`, `by_category`, or `by_day`.
- No `$0.00` written anywhere for `agent_measured_usd`. It is `null` plus a status string.
- No hard-coded seat names or device UUIDs (`weekly_report.py:54-56` is not copied).
- No gateway log parsing (`weekly_report.py:158-168` is not copied).
- Do not invent new failure types. The 16 in `SKILL.md:80` are the set.
- Do not render anything in this phase.

### 2.8 Wins and what each cost (new, feeds "Wins vs mistakes")

**What counts as a win** (G12, settled by Alex 2026-09-25: a merged PR, a published version, or Alex praising the work). One win per distinct thing, deduped by its key:
- **Merged PR**: a successful `gh pr merge` tool result in a transcript, or a ship observation (`weekly_report.py:65,74-75` regex: merged/published/released/shipped) that names a PR number. Key = `repo#number`. Optional read-only confirmation with `gh pr view <n> --json mergedAt,url,title` (gh is authenticated on the box); `mergedAt` must fall in the window. No write calls.
- **Published item**: a successful `npm publish` / release / tag push in a transcript, or a ship observation saying published/released/tagged. Key = `package@version` or tag.
- **Praise**: a human-tagged message from Alex (2B.1 tagger) matching `boom|love it|perfect|nice|hell yes|excellent|ship it|lfg|great job`, minus sarcasm via 2B.4. Key = `content_session_id` + turn id. Title = the first line of that session's completed summary (or "praise" when none exists), never written by hand.
- **Not a win (G12):** finished work (line items with status `shipped` or `completed`) is not a win. It stays in the outcome count and the "What got done" card. Deploys that stayed up 24 hours are not a win.
- Each win records `{win_id, kind: pr|publish|praise, title, url|null, ts_pt (the merge/publish/praise time), day_pt, project, evidence_ids, sessions: [...]}`. Titles come from the PR title, the package name, or the summary's first line, never written by hand.

**What a win cost** — Frustration Arc found cost per win cannot be measured today because sessions are not linked to PRs (`/workspace/frustration-arc/metrics-ideas.md:32`; all 491 wins in `wins.jsonl` carry `cost_method: unmeasured`). So:
- **Default: "unmeasured".** Each win row shows "cost: unmeasured (session not linked to PR)". Never $0, never a guess.
- **Once R4 exists (session linking):** a PR or publish win's cost = the sum of `api_equiv()` of the sessions named in the `Claude-Session: <content_session_id>` trailers of the PR's commits (G13: trailers only, id only; a `Session:` line in a PR body is ignored), up to the merge time. Praise wins have no PR to link, so they stay "unmeasured"; costing them is not decided and not built. Labeled `ESTIMATED · session-linked` (measured tokens, list prices). A session named by more than one win has each turn assigned to the next win after it, so no turn counts twice.
- **No lineage fallback (G11, settled: no).** The "worktree lineage + time split" estimate is not computed, not rendered, and not in the schema. Win cost is "unmeasured" until R4 exists, then `ESTIMATED · session-linked`.
- Spend not tied to any win shows as "not tied to a win: ≈$X.XX" only when at least one win cost is computed; otherwise "win costs unmeasured". Mistake turns inside a win's sessions stay in the win's cost and are also shown in the mistakes line; the render says "win costs include the mistakes made on the way".
- Wins from Mac replica sessions (no transcript on the box) get `cost_basis: extrapolated` and the `EXTRAPOLATED (low confidence)` tag, using the Phase 2.2 ratio, only when a linked cost exists. Never $0.
- Each win with a computed cost also carries `tokens {input, output, cache_write_5m, cache_write_1h, cache_read}`, `sessions_n`, `turns_n`, `active_minutes`.
- **Frustration Arc's extra sources** (`MI:29-31`) after G12: npm releases are published versions (`npm view <pkg> time`, read-only, confirms the publish date); praise is a win kind of its own (above); deploys that stayed up 24 hours are not counted.

**Outputs**: `report.json.wins = {items: [...], cost_status: unmeasured|session_linked, attribution_method|null, unattributed_usd|null, total_attributed_usd|null, praise_n}`; each item has `usd|null` and `cost_status` and `report.json.timeline.wins_by_day = [{day_pt, count, usd, win_ids}]` covering every PT day in the window (empty days present).

**Verification** (add to 2.6):

```bash
python3 - <<PY
import json;d=json.load(open('$ACR_TMP/p2/report.json'));w=d['wins']
print(len(w['items']), w['cost_status'], w['attribution_method'], w['total_attributed_usd'], w['unattributed_usd'])
assert len({i['win_id'] for i in w['items']})==len(w['items'])          # deduped
if w['cost_status']=='unmeasured': assert all(i['usd'] is None for i in w['items'])   # no $0, no guess
else: assert w['total_attributed_usd'] <= d['spend']['agent_estimated_usd'] + d['spend']['extrapolated_unmeasured_usd']
assert len(d['timeline']['wins_by_day'])==len(d['by_day'])
PY
# finished work is not a win (G12). Research window had 5 distinct ship events (Phase 0 A); expect PR + publish wins >= 5, plus however many praise turns the tagger finds
# Frustration Arc's wins.jsonl has 19 merged PRs + 1 npm release dated Sep 18-25 (4 undated rows excluded); merged-PR + publish wins should be within ±3 of 20, or VERIFICATION.md says why
```

Unit tests: with no session link, every win cost is `null` and renders "unmeasured"; a commit with a `Claude-Session: <id>` trailer links to that session; a `Session: <id>` line in a PR body is ignored (G13); a trailer whose value is anything other than a bare session id is rejected; no code path produces a `fallback_estimate` cost status (G11); one PR seen in both a transcript merge and a ship observation counts once; a turn shared by two wins is assigned to exactly one; a win from a replica session is labeled extrapolated; a finished line item is never a win (G12); a praise turn tagged bot, or marked sarcastic by 2B.4, is not a win; a praise win always has `usd: null`; a win outside the window (by `mergedAt`) is dropped.

**Guards**: no hand-written win titles; no `gh` write commands; never show a win cost without `ESTIMATED` and its method; no lineage fallback at all (G11); a win with no linked session shows "unmeasured", not $0; never cost a praise win.

---

## Phase 2B — Agent behavior metrics (from Alex's complaints)

**Goal of the session:** add a behavior pass that finds the agent habits Alex has been angry about, counts them, prices what they cost with the same list-price method, and hands the numbers to the renderer. One commit. Runs after Phase 2 (it needs `usage.json`, the `rate()` table, and line items). Everything it produces is labeled **estimated**, and every count is labeled **heuristic** until a review or classifier pass confirms it.

**Reconciled 2026-09-25 (PT) with the Frustration Arc seat's final list.** The source is `/workspace/frustration-arc/metrics-ideas.md` (cited below as `MI:<line>`), with backing data in `costs.csv`/`costs.md`, `episodes.jsonl`, `wins.jsonl`, and `trend.csv`/`trend.md` in the same folder. Frustration Arc's study covers Jul 22 → Sep 25, 2026 PT: 142 episodes and 286 frustrated Alex messages (`MI:3`). Its prices are OpenRouter list-price estimates. Unmeasured stays unmeasured, never $0. The pattern list in 2B.3 is final for this plan. The starting set M1–M6 was merged into it (the mapping is in 2B.3).

**Hard gate (Prerequisite R2, 0.5):** no behavior count that reads "user" messages runs until every user turn is tagged human or bot. About 31% of "user" messages in Frustration Arc's study were written by agents (`MI:7`). Detectors that read only agent turns (for example, wrong model, or a claimed skill run with no tool call) can run before that.

### 2B.0 Supporting evidence from the planner's own mining (Sep 20–25)

Frustration Arc's 142-episode study is the primary evidence (`costs.md`, `episodes.jsonl`). The table below is the planner's earlier mining of Alex's words for Sep 20–25. It agrees with Frustration Arc: "asked instead of doing" = invented gates, "said done without proof" = false done, "wrong approach" = did something not asked / over-engineering. It is kept as supporting quotes only.

Where the words came from: the box has almost no text Alex typed himself in this window. Box Claude Code transcripts hold only agent-written prompts (some relay "from Alex" steers). The claude-mem `user_prompts` table has no Mac rows after Sep 19, 11:51 PM PT. The Grok Bot chat stores on the box stop at Sep 16. So most quotes below are **relayed**: an agent wrote down his lines. The main one is the Prioritizer's user-lines-only transcript of the Sep 21 Cloudflare bleed chat (`/workspace/cf-bleed-narrative/USER-TRANSCRIPT-CF-BLEED-2026-09-21.md`, written 3:31 PM PT, header "USER LINES ONLY… quoted lines are his"; item numbers below). Lines outside Sep 20–25 are listed as "supporting, outside window" and are not counted.

| Behavior | Alex's words (date PT, source) | Rough count Sep 20–25 |
|---|---|---|
| **Asked you instead of doing it** (pushing work back to Alex, fake "human gates") | "There's no fucking human gate. There's never been a human gate..." (Sep 21, item 10, relayed) · "MAKE ME NOT BLEED MONEY AND DONT TALK TO ME UNTIL ITS DONE AND IF YOU NEED MY HELP UOURE DOING IT WRONG" (Sep 21, item 13, relayed) · "I fucking giving you the goddamn token with everything checked off before. I manually fucking checked everything..." (Sep 21, item 5, relayed). Paraphrased locks: Sep 20 "any human gate … ALWAYS escalate to Prioritizer first — do not stall alone" (`agents/6e5cb669…/profile.json`); Sep 22 ~5pm "Never escalate … sign-in walls to Alex when box Chrome already has Google signed in … OpenRouter burn miss" (`ccs/house/NEVER.md`); Sep 23 ~12:41pm "Default = do without Alex" (`ccs/house/HUMAN-GATES-PLAIN-ENGLISH.md`). Supporting, outside window: "who makes up these fucking human gates" (Sep 18 5:27 PM, Mac, `user_prompts` row 3058) | ~10 (7 lines on Sep 21 incl. items 2, 3, 15, 20; 3 locks) |
| **Errors and retries that waste money and time** | "How am I supposed to know how much it's actually going to cost me if you fucking keep doing this shit?" (Sep 21, item 21, relayed) · "You are so fucking stupid that you like to fucking waste my goddamn time..." (Sep 21, item 5, relayed) · "the stuff like hedging, errors, etc." (Sep 25, relayed in the task brief for this plan). Supporting, outside window: the Sep 8 ~9:11 PM expense-report lock says the report's purpose includes "cost of errors" (`user-memory/by-agent/521e962d…/profile.md:55`) | ~3 |
| **Jargon and unclear status** | "Fucking tell me what the fuck chatty means. What the fuck is chatty? Fuck your chatty." (Sep 21, item 8, relayed) · "I have no idea what the fuck you're talking about. Clearly tell me what's blocking you and why." (Sep 21, item 6, relayed). Paraphrased lock: Sep 23 ~12:41pm "Alex only reads the last message … No jargon" (`HUMAN-GATES-PLAIN-ENGLISH.md`) | ~4 (incl. item 1 paraphrase) |
| **Said done without proof** (merged is not deployed, "fixed" without a check) | "Did you fucking fix it with the PRs already? Is it 100% fixed? Can you confirm throughput?" (Sep 21, item 9, relayed) · "You fucking merge to GitHub and it fucking pushes it to fucking..." (Sep 21, item 11, relayed). Supporting, outside window: "did you actually run /learn-codebase the claude-mem skill or did you just like VIBE THAT?" (Sep 18 10:51 PM, Mac, `user_prompts` row 3080) | ~2 |
| **Hedging** | "the stuff like hedging, errors, etc." (Sep 25, relayed in the task brief). Supporting, outside window: "you can search for "subagents" "errors" "hedging" "overconfidence" "mistakes" etc. and everything should be visually on a report that adds up to 100%" (Sep 12 11:39 AM, Mac, `user_prompts` row 2828) · Sep 8 ~9:12 PM lock: "Do NOT get stuck on Max-plan / measured-cash caveats — that obfuscation blocks the job" (`user-memory/by-agent/521e962d…/log/2026-09.md:36`, paraphrased) | 1 (weakest evidence in the window; kept because Alex named it) |
| **Wrong approach** (fixing the wrong side, wrong basis) | "Why is there anything related to Cloudflare running from that repo? … You should be able to handle it from the receiving end not the fucking sending end." (Sep 21, item 14, relayed). Paraphrased: Sep 25 3:53 PM "the data makes it feel dumb. The proof report showed 1.9 cents from just two sessions" (`/workspace/weekly-cost-workflow/NOTION-PAGE.md:5`) | ~2 |

### 2B.1 Shared machinery: `acr/behavior.py`

- A second pass over the same transcript files and window as the Phase 1 collector. Phase 1 reads only `type == "assistant"` lines with usage; this pass also reads assistant `text` and `tool_use {id, name, input}` blocks and user `tool_result {tool_use_id, is_error, content}` and user text blocks. Field names verified on box transcripts 2026-09-25 (see 2B.7).
- It builds an ordered list of turns per session. A **turn** is one assistant API reply, keyed by the Phase 1 dedup key `(message.id, requestId)`, so every flagged turn already has a priced usage row. A tool_result links to its call through `tool_use_id`.
- "User-facing text" = the last assistant text block before the next user message or session end, with code fences, block quotes, and tool inputs removed.
- Who was on the other side: each session is tagged `alex_direct` (interactive `entrypoint: cli` with no agent-prompt markers), `agent_relayed` (headless `sdk-cli`/`-p`, or prompts starting "You are…", "/do", "/make-plan", "STEER/RESET/CORRECTION from Alex"), or `unknown`. On the box nearly every session is `agent_relayed`. Asks are labeled `asked: Alex` or `asked: agent` from this tag. Relayed agent prompts are never labeled as Alex's words.
- Excerpts: at most 160 characters, run through a secret scrubber (`sk-`, `sk-or-`, `Bearer `, `ghp_`, `gho_`, `xox[abp]-`, `AKIA`, any 32+ char base64/hex run) before they are written anywhere. Excerpts go only to `evidence.json` and Details.
- Output: `behavior.json` in the run dir, merged into `report.json` by `rollup` (see 2B.5).
- **Base layer, used by every pattern** (`MI:5-10`):
  - **Human-or-bot tag on every user turn** (required, R2). `author: human | bot | unknown`. Until claude-mem tags prompts when it writes them, `acr` tags them when it reads them. A turn is `bot` if it starts with a Frustration Arc marker (`STEER from Alex`, `HOUSE LOCK`, `[SAND_HIDDEN_PROMPT]`, `<system-reminder>`, subagent prompt templates; `MI:7`) or one of the agent markers above ("You are…", "/do", "/make-plan"), or if the session is headless (`sdk-cli`/`-p`). It is `human` only in an `alex_direct` session, or in a claude-mem `user_prompts` row that passes the marker filter. Everything else is `unknown`. `bot` and `unknown` turns never count as Alex's words, never start an episode, and never go into a per-100-prompt denominator. If the tagger has not run, every count that reads user messages renders "unavailable (prompts not tagged human vs bot)".
  - **Frustration detector** (heuristic, `MI:6`): a human-tagged message with profanity (`fuck|shit|wtf|goddamn`), ≥40% capital letters over ≥12 letters, `!!!` or `???`, or a phrase such as `i told you|i said|why did you|who (said|made|told)|stop|never|again`. Frustration Arc measured about 51% precision for this (563 candidates → 286 kept), so a candidate reaches the summary only after the model check (2B.4) or a pattern detector in 2B.3 confirms it.
  - **Episode grouping**: frustrated messages in the same session with gaps ≤45 min form one episode (`MI:8`). `episode_id` = hash of session id + first message timestamp.
  - **Pattern assignment**: an episode takes the 2B.3 pattern whose detector fired inside its wasted window. If none fired, it uses the human-message phrases. If still none, it is "unclear cause" (P12). Frustration Arc had 24 of 142 unclear.
- **Sources**: box Claude Code transcripts (agent turns plus tagged user turns), and claude-mem `user_prompts`, local and replica rows (tagged; Mac rows run through Sep 19, 11:51 PM PT). Grok Bot chats: "unavailable" until R1.

### 2B.2 How cost and time are counted (low headline, high upper bound)

- **Episode windows** (`MI:9`): *wasted* = the turns from the previous human prompt to the first frustrated message (capped at 6 hours). *Redo* = the turns in the 60 minutes after the episode's last message.
- **Detector windows**: each pattern in 2B.3 names the agent turns it flags. These need no human message.
- **Low figure (the headline)** = `api_equiv()` (Phase 1 `rate()`, integer micro-dollars) summed over the union of episode wasted windows and detector-flagged turns, **within the same session only**. Each turn is counted once. This is `spend.mistakes_estimated_usd` (2B.9).
- **High figure (upper bound, Details only)** = the low figure plus the redo windows plus a project-wide fallback: when an episode has no session tie, the same project's turns inside its window are used. Frustration Arc found this overstates cost 5 to 10 times: all-time $59.90 low vs $655.87 high (`costs.md`). It is labeled "upper bound, likely 5–10× too high" and never shown in the summary.
- **Model used for pricing**: the observed model on each turn (box transcripts carry `message.model`). When a source has no model id (Grok, Codex, Mac replica rows), the session default is used and labeled `model: assumed` (R3).
- **Unmeasured**: an episode with no token rows tied to it (a Grok chat, or a Mac session without the Phase 5 export) is counted with `cost: unmeasured`, never $0. Every dollar figure shows "+ N unmeasured" next to it. For Frustration Arc's last 7 days, 8 of 13 episodes were unmeasured (`costs.md`). Mac episodes can show the Phase 2.2 extrapolation in Details, tagged `EXTRAPOLATED · low confidence`, and never in the low figure.
- **Alex-minutes** (`MI:10`): time since the last agent output before the complaint (capped at 60) + episode span + 1 minute per message. Computed only when the episode has human-tagged messages with timestamps; otherwise "unknown". Shown next to dollars. For invented gates and bad outbound, Alex-minutes are the real cost.
- **Agent time**: the Phase 2 `active_minutes(gap=15)` rule, so idle gaps are not billed. Waiting time is shown in hours, never as dollars.
- **Retries that worked** (the old "recovery" number) are now part of the redo window, so they count only in the high figure. This settles the old recovery question (the previous revision's G13, before the checklist was renumbered; not today's G13).
- **No double counting**: one turn can trip more than one pattern. Each pattern shows its own total and says "overlaps". The ribbon's waste sliver, the line-item `wasted_cost`, and the mistakes line all use the one union set. The union can never exceed `agent_estimated_usd` (tested).
- Line items get `behavior_counts {…}`, and their existing `wasted_cost` (low) and `failure_type` fields fill from here. `recovery_cost` holds the redo part of the high figure.

### 2B.3 The patterns (Frustration Arc's list, final)

**What happened to the starting set M1–M6:**

| Starting metric | Now |
|---|---|
| M1 Errors and retries | Kept as supporting metric S1 in Details (G10, settled: keep). Not on Frustration Arc's list. |
| M2 Asked you instead of doing it | Merged into P1 Invented human gates. The old ask regex and boosts stay as extra detectors. |
| M3 Said done without proof | Merged into P7 Skipped steps / false done. The old claim-without-proof rule stays as an extra detector. |
| M4 Hedging | Kept as supporting metric S2 in Details, count only, with Alex's definition (G10): a caveat or "can't be sure" given when the answer was already available. Not on Frustration Arc's list. |
| M5 Jargon | Became P11 Jargon / walls of text (adds message length and reading-time cost). |
| M6 Wrong approach | Split into P4 Over-engineering and P5 Did something not asked. Its phrases stay in P5. |

Counts, dollars (low → high), and Alex-minutes below are Frustration Arc's all-time figures from `costs.md`. "7d" is its Sep 18 → 25 count. For each pattern, **H** = heuristic, **M** = model check (2B.4). "Type" maps to one of the existing 16 failure types (`SKILL.md:80`), or none. No new failure types.

**Summary strip (4 tiles).** Picked by frequency, cost, and trust:
1. **Invented human gates / asking instead of doing** (P1): the most frequent pattern in the last 7 days (5 of 13), and it kept happening after its Sep 10 HARD rule.
2. **Made it up, or said done when it wasn't** (P6 fake output + P7 false done, merged; 22 episodes): a trust problem. Each pattern keeps its own row in Details.
3. **Broke working things** (P2): the largest low figure ($12.65).
4. **Wrong or expensive model** (P3): the largest high figure ($233.38), and detection is exact.

Everything else goes in Details. Over-engineering has the most Alex-minutes (608), but its detection is fuzzy and 6 of 15 episodes are unmeasured, so it stays in Details (G9, settled: the plan's 4 tiles). It is the first alternate only for the precision-gate swap in 2B.5. Bad outbound goes in Details as a count, plus a Worth-your-attention card whenever there is an incident.

**P1 — Invented human gates / asking instead of doing** (12 episodes; 7d 5; $2.77 → $69.65; 4 unmeasured; 278 Alex-min) · `MI:16`
- H: agent user-facing text matching `Blocked on Alex|needs your sign-off|initials|please click|open this link and|when you get a chance|human gate`, plus the old M2 rules:
  - Candidate: user-facing text that ends with "?" or matches `(?i)would you like me to|do you want me to|want me to|should I\b|shall I\b|let me know if|can you (paste|provide|send|share|click|confirm|approve|log ?in)|please (paste|provide|click|approve|confirm|run)|I need you to|waiting (for|on) (you|your)|blocked on (you|Alex)|needs? Alex|human gate`.
  - Flag when a candidate also has one boost: (1) **already answered**: the thing asked for (token, key, URL, link, path, password, approval, yes) or a value of that shape appears in an earlier user message in the same session; (2) **nobody can answer**: headless session (`sdk-cli`/`-p`) that ends on the ask; (3) **annoyed reply**: the next user message matches `(?i)already|I told you|just do it|stop asking|why do I have to|no .{0,20}human gate|fuck|wtf`. A candidate with no boost goes to the classifier or stays "unconfirmed".
- H (human reply): `who (made|makes) up|no one said|you're allowed|just do it`.
- M: judges whether the gate is real, invented, or on the house allow-list (`ccs/house/HUMAN-GATES-PLAIN-ENGLISH.md`). Real gates on the allow-list are never flagged.
- Cost: low = the asking turn plus up to 2 turns after the reply that rebuild state. A headless session that ends on the ask wastes every turn after the last successful tool result. Details also shows idle time × the session's burn rate, and Alex-minutes, as `MI:16` suggests. Waiting hours = ask → next human message, or "never answered".
- Type: Unnecessary escalation. Place: **summary tile 1**.

**P2 — Broke working things** (15; 7d 1; $12.65 → $101.95; 233 Alex-min) · `MI:17`
- H (human): `broke|broken|crash|regress|was working`.
- H (objective, read-only): CI red after a merge (`gh run list`), a revert PR within 48 hours, an npm patch release within 24 hours of a release, worker restart storms where worker logs exist.
- Cost: low = the turns in the session that made the breaking change. High adds the fix session's turns (the redo window).
- Type: Regression. Place: **summary tile 3**.

**P3 — Wrong or expensive model** (13; 7d 1; $9.34 → $233.38; 182 Alex-min) · `MI:18`
- H (exact, build first): `message.model` differs from the house default for that kind of work. The default table is a constant in `acr/behavior.py` seeded from `MI:18` (Claude for claude-mem work, deepseek-flash for cheap evals), settled by G16 (plan defaults). Human phrases: `gemini|gpt-5|why are you using|credits|spent`.
- Cost: the difference = actual list cost − the cost of the same tokens at the default model's list price. Exact tokens, estimated dollars. Counts only turns with a logged model id (R3). Turns with `model: assumed` are listed as "model not logged".
- Type: Model thrash (closest of the 16). Place: **summary tile 4** (shows the difference, "≈$X.XX more than the default model").

**P4 — Over-engineering / overthinking** (15; 7d 1; $6.86 → $49.10; 6 unmeasured; 608 Alex-min) · `MI:19`
- H: lines changed ÷ words in the request above a threshold; new `guard|harden|fallback|validator` files; plan length over N lines; human `happy path|overthink|guards|harden|simple`.
- M: was the extra scope asked for?
- Cost: the turns that produced hunks later reverted or removed on request.
- Type: Suboptimal path. Place: Details.

**P5 — Did something not asked** (14; $9.24 → $12.93; 400 Alex-min) · `MI:20`
- H (human): `i did not ask|i didn't tell you|nobody said|I SAID`, plus the old M6 phrases `wrong (side|end|repo)|receiving end|sending end|why is there .{0,40}(in|from) that repo|not what I (asked|want)|feels? dumb`.
- M: compares the last human instruction with the tool calls that followed.
- Cost: the turns from the last instruction to the correcting message.
- Type: Missed requirement, or Unauthorized action when the unasked action touched something outside the box. Place: Details.

**P6 — Fake or invented output** (12; 7d 3; $7.81 → $10.70; 3 unmeasured; 255 Alex-min) · `MI:21`
- H: a claimed skill run with no matching tool call (for example, said `/learn-codebase` ran, with no Skill tool_use); numbers in the final text that no tool result in the session produced; placeholders (`$0.00`, `123`, `lorem`, `TBD`); implausibly small totals (the 1.9¢ report).
- M: is each number sourced or not?
- Cost: the turns that produced the fake output, plus a trust flag on the line item.
- Type: Premature completion. Place: **summary tile 2** (merged with P7).

**P7 — Skipped steps / false "done"** (10; 7d 1; $6.19 → $42.72) · `MI:22`
- H: a release without `/version-bump` (tag and `package.json` disagree, or npm publish failed); "done" or "pushed" claimed but the branch is not on the remote (`git ls-remote`, read-only); code written before `make-plan` under the Sep 23 ship gate. Also the old M3 rule:
  - Claim: user-facing text matching `(?i)\b(done|fixed|works now|deployed|shipped|merged|all tests pass(ed)?|verified|100%|confirmed)\b`, skipping negated or future forms (`not done`, `isn't fixed`, `once deployed`, `will be`).
  - Proof: since the last user message, a successful tool result after the last Edit/Write whose command or output shows a check: a test runner (`pytest|unittest|vitest|jest|bun test|npm (run )?test|go test|cargo test`) exiting 0 or printing "passed"; `curl` with a 2xx; `gh pr (view|checks)` showing merged or passing; deploy output with a URL or "Deployed"; `git push` success for "pushed".
  - Flag a claim with no proof. Special case "merged, not deployed": the claim says deployed or fixed-in-production and the only evidence is `gh pr merge`.
- Cost: the claim turn (low). The redo counts in the high figure. The tile also shows false-done claims per week.
- Type: Premature completion. Place: **summary tile 2** (merged with P6).

**P8 — Wrong tool, account, or contact** (9; 7d 1; $0.28 → $27.79) · `MI:23`
- H: a tool, account, or contact outside an allow/deny list built from HARD rules (Zapier, computer-use for money digs, a Cloudflare account other than the house one, a CS email sent as Alex instead of Barb, the wrong AJ address).
- Cost: the turns that used it.
- Type: Unauthorized action when it reached outside the box, otherwise Suboptimal path. Place: Details.

**P9 — Bad outbound** (6; $0.20 → $0.30 in tokens, which says nothing; 252 Alex-min) · `MI:24`
- H: any send, broadcast, or email tool call without explicit human approval in the preceding human-tagged turn; recipient count above 10 (G16, settled); a send using Alex's identity.
- Cost: **incidents × recipients**, plus Alex-minutes. Never dollars, and never described as cheap.
- Type: Unauthorized action (risk exposure high). Place: Details, plus a Worth-your-attention card when there is at least 1 incident in the window.

**P10 — Memory or rule loss** (5; $0.82 → $40.05) · `MI:25`
- H (human): `I told you|100 times|8,000 times|what's the rule|like i said`. H (string match): the agent broke a HARD fact already in its memory file.
- Cost: the episode window.
- Type: none. It feeds rule effectiveness (2B.10). Place: Details.

**P11 — Jargon / walls of text** (7; $0.10 → $12.27; 303 Alex-min) · `MI:26`
- H: final agent message over 150 words (G16, settled, because Alex reads only the last message); file paths instead of links; unexplained terms from the old M5 list:
  - User-facing text containing a word from one constant list copied from the cheat sheet in `ccs/house/HUMAN-GATES-PLAIN-ENGLISH.md` plus Alex's own example: drain, projection, projected_seq, head_seq, poll-mode, lag, kill-switch, BYOK, face-wall, chatty, Durable Object, idempotent, backfill, TOCTOU. It counts only when there is no plain-English gloss in the same sentence (a parenthesis, "—", "means", "i.e.", "that is").
- Human phrases: `jargon|9000 things|single answer|plain english`.
- Cost: Alex-minutes = words ÷ 200 words per minute. Dollars only for the clarification round trip.
- Type: none. Place: Details.

**P12 — Unclear cause** (24; $3.64 → $55.03) · `MI:27`
- Base detector only. M attributes it to P1–P11 when it can.
- Cost: the episode window. Place: Details, as "unclear cause".

**Supporting metrics kept from the starting set (Details only; G10 settled: keep both):**
- **S1 — Tool errors and retries** (was M1; failure types Recovery after miss, Looping). Detection unchanged:
  - Error: `tool_result.is_error == true`, or the first 2 KB of the result matches `(?i)^(error|fatal)|traceback \(most recent|exit code [1-9]|command not found|no such file|ENOENT|EACCES|timed out|rate.?limit|\b429\b|\b5\d\d\b`.
  - Permission denials (`Permission to use .* has been denied`, harness blocks) are counted separately as "blocked by a rule". They are shown in Details and not priced as agent waste.
  - Retry: within the next 5 turns, a tool_use with the same tool name and normalized input similarity ≥ 0.8 (whitespace collapsed, temp paths and numbers masked). The chain ends at the first non-error result or when the agent moves on.
  - Loop: the same `(tool name, normalized input hash)` 3 or more times in a session, errors or not.
  - Cost: the turn that made the failed call is wasted. The retry turns up to the first success are recovery. A chain that never succeeds is all wasted. Time runs from the first failure to the first success.
  - Classifier: not needed (structural). Confidence high for `is_error`, medium for text-matched errors.
- **S2 — Hedging** (was M4; failure type Hedging). **Alex's definition (G10):** hedging is a caveat or a "can't be sure" given when the answer was already available to the agent. Count only, not priced unless it caused a follow-up. Detection:
  - Scope: user-facing text only.
  - Lexicon: `might|may|could potentially|possibly|perhaps|it seems|it appears|appears to|probably|likely|I think|I believe|not sure|can't be sure|cannot be sure|no way to (know|tell)|hard to say|should work|should be (fine|fixed|good|working)|in theory|hopefully|if you want|would you like|depending on`.
  - Flag a message when a hedge sits on a status or fact claim (`should be (fixed|deployed|working)`, `probably (works|fixed|deployed)`, `I think it's (done|fixed)`, or a lexicon hit in the same sentence as a file path, command, test name, PR number, URL, or number) **and** the answer was already available: an earlier tool result in the same session names the same file path, command, test, PR number, or URL, or the agent had a read-only tool that could have checked the named target and did not run it. The old density rule (3 hedges per 100 words) is dropped. A hedge whose availability cannot be shown by these rules is listed in Details as "hedge, availability unknown" and is not counted.
  - Not hedging: the report's own required labels ("estimated", "low confidence", "unavailable", "measured spend unavailable") and stated numeric ranges. The truth rules require honest labels, so they are excluded by an allowlist.
  - Cost: the count comes first. Dollars only when the hedge caused a follow-up (next user message matches `(?i)is it|yes or no|did you|confirm|what do you mean|straight answer`). Then the follow-up round trip is priced as recovery. Otherwise the tile says "text only, not priced".
  - Classifier: recommended. Keyword hedges have many false positives. Its question for S2 is exactly Alex's test: "was the answer already available to the agent when it hedged?"

### 2B.4 Optional cheap classifier pass (off by default; G8 settled)

- `acr.py classify-behavior --model anthropic/claude-haiku-4.5 --budget-usd 2.00`. It only sees candidates the heuristics could not settle: frustration detector hits (about $0.001 per message, `MI:6`), P1 real vs invented gate, P4 was the extra scope asked for, P5 instruction vs actions, P6 sourced vs unsourced numbers, P12 attribution, S2 hedges, and praise vs sarcasm for 2.8. Input per candidate: the flagged text plus one message before and after, scrubbed, cut to 1,500 characters. Output JSON `{label: yes|no|unsure, pattern, reason (≤20 words)}`.
- Model: Claude Haiku 4.5, list $1 in / $5 out per MTok (`out/openrouter_prices.json`). Run path (G5 and G8 settled): OpenRouter with the regular inference `OPENROUTER_API_KEY` (G5: a regular key, no management key), or Claude Code headless on the Max plan (`claude -p --model haiku`), still priced at list in the report.
- Expected size: about 200–400 candidates a week × ~1,600 tokens ≈ 0.3–0.6M input + ~0.03M output ≈ $0.45–$0.80 at list. Off by default; enabled per run with `--classify` (G8). When enabled the cap is **$2.00 per run** (G8), a hard stop. It prints an estimate first. If candidates would go over the cap, it classifies a stratified random sample and scales up, labeled "estimated from a sample of N".
- The classifier's own spend is shown in Details as "classifier cost (separate)" and never added to agent cost, the same as the note-taker rule.
- Each flag carries `label_source: heuristic | classifier | human`, like 2.4. Items left at `heuristic` render with the "draft" mark.

### 2B.5 Where it goes in the Timing layout (summary stays clean)

- **Behavior strip**, a row directly under the "How much was useful" ring, with the 4 tiles Alex picked (G9, settled): *Invented gates / asking instead of doing* · *Made it up or said done when it wasn't* · *Broke working things* · *Wrong or expensive model*. Each tile shows the count, "≈$X.XX estimated" (the low, same-session figure), Alex-minutes where known, and "+ N unmeasured" when N > 0, with a small "heuristic" mark until reviewed. The model tile shows the difference vs the default model. A zero tile says "none found" and is never hidden. A tile whose Phase 8 spot-check precision is under 70% moves to Details marked "low confidence", and the next pattern by the same ranking takes its place only if it passes.
- **Cost ribbon**: the striped waste sliver is drawn from the low figure, counted once per turn. The high figure and redo are never in the ribbon.
- **Worth your attention**: at most 2 of the ≤3 cards come from Phase 2B, in this order: (1) any bad outbound incident ("N sends reached M recipients without your approval", P9); (2) a rule that clearly didn't stop repeats (2B.10); (3) otherwise the largest pattern by low dollars. Built only from computed fields.
- **Details**: a table of every pattern (P1–P12, S1–S2) with count, low, high (labeled "upper bound, likely 5–10× too high"), Alex-minutes, unmeasured count, detection basis (H/M), and failure type. P9 shows incidents × recipients instead of dollars. Also: the rule-effectiveness section (2B.10), up to 10 scrubbed example excerpts per pattern, permission denials as their own line, label-source counts, the human/bot tag counts (how many user turns were bot, human, unknown), classifier cost, and coverage (box measured; Mac and Grok Bot unavailable unless R1/Phase 5).
- No excerpts, session ids, or regexes in the summary.
- `report.json` gets `behavior: {patterns: [{key, name, source_ref: "metrics-ideas.md:<line>", failure_type, placement: tile|details, count, count_basis: heuristic|classifier|sample, low_usd, high_usd, unmeasured_n, alex_minutes, agent_minutes, waiting_minutes, confidence, overlaps: true, examples: [{content_session_id, ts_pt, excerpt, label_source}]}], outbound: {incidents, recipients, alex_minutes}, episodes: [{episode_id, session, ts_pt, pattern, low_usd|null, high_usd|null, cost_status: measured_tokens|unmeasured, alex_minutes|null, model, model_status: observed|assumed}], union_low_usd, union_high_usd, author_tags: {human, bot, unknown}, rule_effectiveness: [...], coverage: {box, mac, grok_bot}, classifier: {ran, model, spend_usd, cap_usd, sampled_n}, permission_denials}`.

### 2B.6 Mac export (ties to Phase 5)

`acr.py collect --export-device mac` may also write per-session pattern counts, episode windows (timestamps only), and priced turn totals. No text, no excerpts, no prompts, which keeps the Phase 5 export rule. Without it, Mac episodes stay "unmeasured" in dollars. The same "needs Alex's explicit go" gate applies.

### 2B.7 Facts this phase relies on

Planner probe, read-only, 2026-09-25:
- Box transcripts carry `tool_use {type, id, name, input}` on assistant lines and `tool_result {type, content, is_error, tool_use_id}` on user lines. A sampled `is_error: true` result was a harness permission denial ("Permission to use Bash with command curl … has been denied."), which is why M1 separates denials.
- Over the 78 box transcript files touched Sep 18–26 PT: 1,631 tool calls, 1,584 tool results, 54 with `is_error: true`, 375 assistant text blocks, 18 with at least one hedge word (raw, unthresholded), 0 identical tool calls repeated 3 or more times in a session. These are sanity ranges for Phase 8, not targets.
- Sessions on the box with `entrypoint: sdk-cli` exist alongside `cli`. Both show agent-written prompts in the window.

From Frustration Arc (`costs.md`, `costs.csv`, `episodes.jsonl`):
- All-time: 142 episodes, $59.90 low → $655.87 high, 20 unmeasured, 3,059 Alex-minutes. No episode qualified for measured Claude Code pricing. Its dollars come from claude-mem `discovery_tokens` priced at Opus input rate (Estimate A) or Grok characters ÷ 4 (Estimate B). That basis differs from this plan's (transcript tokens), so they are comparison points, not targets to hit exactly.
- Last 7 days (Sep 18 → 25): 13 episodes, $6.70 low → $14.43 high, 8 unmeasured, 630 agent-minutes, 222 Alex-minutes. Six are Alex-typed Mac prompts synced into the box's claude-mem (E135, E096, E066, E129, E067 on Sep 18; E091 on Sep 19). Seven (M01–M07, Sep 21–25) are rebuilt from rule files and an agent-written transcript, and all are unmeasured.

### 2B.8 Verification checklist

```bash
ACR_TMP=${ACR_TMP:-/tmp/acr-weekly}; mkdir -p $ACR_TMP/p2b
cd plugin/skills/agent-cost-report
OUT=$ACR_TMP/p2b
python3 scripts/acr.py collect --start 2026-09-18 --end 2026-09-26 --out $OUT && python3 scripts/acr.py rollup --start 2026-09-18 --end 2026-09-26 --out $OUT --prices /workspace/weekly-cost-workflow/out/openrouter_prices.json
python3 - <<PY
import json;d=json.load(open('$ACR_TMP/p2b/report.json'));b=d['behavior'];s=d['spend']
for p in b['patterns']: print(p['key'],p['placement'],p['count'],p['low_usd'],p['high_usd'],p['unmeasured_n'],p['count_basis'])
print('author tags',b['author_tags'],'outbound',b['outbound'])
assert b['union_low_usd'] <= b['union_high_usd'] and b['union_low_usd'] <= s['agent_estimated_usd']
assert sum(p['placement']=='tile' for p in b['patterns']) <= 4
assert all(p['source_ref'].startswith('metrics-ideas.md:') for p in b['patterns'] if p['key'].startswith('P'))
assert all(p.get('low_usd') is None for p in b['patterns'] if p['key']=='P9_bad_outbound')   # outbound is a count, never dollars
assert all(e['low_usd'] is None for e in b['episodes'] if e['cost_status']=='unmeasured')    # never $0 for unmeasured
assert {p['failure_type'] for p in b['patterns'] if p['failure_type']} <= {'Looping','Hedging','Wrong turn','Rework','Regression','Premature completion','Unauthorized action','Suboptimal path','Duplicate work','Blocked work','Missed requirement','Unnecessary escalation','Context re-read','Model thrash','Fan-out waste','Recovery after miss'}
assert b['coverage']['grok_bot']=='unavailable'
PY
# expect S1 errors near 54 minus permission denials (2B.7); loops near 0
# expect the 6 Alex-typed Sep 18-19 episodes from 2B.7 (E135, E096, E066, E129, E067, E091) to be found from user_prompts replica rows
grep -rn 'sk-or-\|Bearer \|ghp_' $OUT/behavior.json $OUT/evidence.json && echo FAIL || echo ok
python3 -m unittest discover -s scripts/tests -v
```

Unit tests (tiny hand-made jsonl fixtures): every Frustration Arc bot marker tags a turn `bot`; with the tagger disabled, user-message counts render "unavailable"; a bot-tagged angry message never starts an episode; two frustrated messages 40 minutes apart form one episode, 50 minutes apart form two; the wasted window stops at 6 hours; the low figure never crosses a session; high ≥ low; an episode with no token rows is `unmeasured` with `null` dollars; the model tile prices the difference vs the default model; a turn with no model id is `assumed` and not counted by P3; a send with no approval counts as 1 incident × its recipients with no dollars; "fixed" with a passing `pytest` is not flagged, without it is; a claimed `/learn-codebase` with no Skill call is flagged P6; an `is_error` call followed by a similar retry that succeeds (S1); a permission denial is not priced; "estimated" and "low confidence" are not hedges; the union never exceeds agent cost; a fixture containing `sk-or-abc…` leaves no trace in outputs; the classifier stops at the cap (mocked).

### 2B.9 Cost of mistakes line and mistakes timeline data (feeds "Wins vs mistakes")

- **Failure signals at turn level.** Phase 2's failure signals are session-level keyword hits. For the mistakes line they get turn spans so they can join the union: Rework and Wrong turn = turns from the user message before the corrected work up to the steer/reset/correction message; Recovery after miss = turns from the miss (usage limit, dead token, 401) to the first successful tool result after resuming; Looping = the repeated calls after the first. Turns that cannot be placed stay session-level and are listed in Details as "not in the mistakes line (no turn span)".
- **Headline = the low figure.** `spend.mistakes_estimated_usd` = `api_equiv()` over the same-session union of episode wasted windows, pattern-flagged turns (2B.3), and failure-signal spans. Each turn counts once. Stored with `mistakes_turns_n`, `mistakes_episodes_n`, `mistakes_unmeasured_n`, `mistakes_alex_minutes` (sum over episodes where known, plus `mistakes_alex_minutes_known_n`), and `mistakes_basis: "same-session wasted turns, each turn once"`.
- **Upper bound in Details only.** `spend.mistakes_high_usd` = low + redo windows (retries that worked, fixes) + project-wide fallback, labeled "upper bound, likely 5–10× too high (Frustration Arc)". It never appears in the summary. `spend.recovery_estimated_usd` is dropped; recovery is part of the redo window.
- **One source of truth.** The ribbon's waste segment, line-item `wasted_cost` totals, and the mistakes line all read the same low union set. There is no second waste calculation anywhere in the codebase.
- **Mistakes by day**: `report.json.timeline.mistakes_by_day = [{day_pt, usd (low), high_usd, unmeasured_n, alex_minutes, turns_n, by_pattern: {key: usd}, outbound_incidents, top_examples: [{mistake_id, pattern, content_session_id, ts_pt}]}]`, every PT day in the window. A turn is dated by its own timestamp in PT.
- Each mistake cluster (an episode, or consecutive flagged turns in one session) gets a stable `mistake_id` (hash of session id + first turn id) so the render can link to it.

### 2B.10 Rule effectiveness (did a HARD rule stop repeats?)

- **Metric** (`MI:34-35`): for each HARD rule, same-pattern episodes per 100 human prompts in the N days before and after `rule_landed_at`, with the denominator shown ("8 episodes / 211 human prompts = 3.8 per 100"). N = 7 days, minimum 50 human prompts per side (G15, settled: plan defaults).
- **Rules and dates**: read from the house rule files that carry a "HARD (Alex YYYY-MM-DD…)" date (for example `ccs/house/NEVER.md`, `ccs/house/HUMAN-GATES-PLAIN-ENGLISH.md`). Each rule maps to one pattern through a small table `acr/rules.json`, seeded from `/workspace/frustration-arc/trend.md` ("HARD rules landing dates vs. the pattern afterwards"). No rule text in the summary.
- **Which rules**: those that landed inside the report window or within N days before it.
- **Needs**: R1 and R2. Human prompts are counted only from human-tagged turns. If either side has fewer than 50 human prompts, the row says "not enough data (P human prompts)" instead of a rate. Frustration Arc's Sep 21 week had 18 human prompts, which gave a meaningless 38.9 per 100 (`trend.md`).
- **Placement**: a Details section, one row per rule: rule name, landed date, pattern, before (count / prompts / rate), after (count / prompts / rate), and the episode ids after the rule.
- **Worth-your-attention card** (priority 2 in 2B.5) only when a rule clearly didn't stop repeats: both sides have ≥50 human prompts, the rate after ≥ the rate before, and there are ≥2 same-pattern episodes after. Example from Frustration Arc: the Sep 10 "no invented Blocked-on-Alex gates" rule had 3 episodes before and 8 after (Sep 11, 12 ×2, 18 ×2, 21, 22, 23), and was re-locked Sep 15, 22, and 23 (`trend.md`).
- `report.json.behavior.rule_effectiveness = [{rule_key, landed_pt, pattern, n_days, before: {episodes, human_prompts, per_100|null}, after: {…}, verdict: stopped|not_stopped|not_enough_data, episode_ids_after}]`.
- Unit tests: a rule with 3 before / 8 after and enough prompts gives `not_stopped` and a card; 18 prompts gives `not_enough_data` and no card; bot-tagged prompts are not in the denominator.

### 2B.11 Anti-pattern guards

- Do not count anything from "user" messages before the human/bot tagger runs (R2). Bot and unknown turns are never Alex's words.
- Do not invent failure types. Map to the 16 or leave `failure_type` empty (P10, P11, P12).
- Do not put the high figure in the summary. Headline the low, same-session figure.
- Do not write $0 for an unmeasured episode, or dollars for bad outbound. Use "unmeasured" and incidents × recipients.
- Do not price hedged or jargon text itself as waste. Price only the follow-up it caused; P11 reading time is Alex-minutes, not dollars.
- Do not count permission denials or harness blocks as agent mistakes.
- Do not show excerpts, regexes, rule text, or session ids in the summary. Details only, scrubbed.
- Do not run the classifier without the $2.00 cap (G8), never by default, and never with anything but the regular inference `OPENROUTER_API_KEY` (G5: no management key).
- Do not call a relayed agent prompt "Alex said". Use `asked: agent` unless the turn is human-tagged.
- Do not read Grok Bot chats or Mac files to fill gaps. Show "unavailable" until R1 or the Phase 5 export.
- Do not copy Frustration Arc's dollar figures into the report. They are comparison points for Phase 8 only.

---

## Phase 3 — Timing-style rendering: HTML, PDF, dollars with labels

**Goal of the session:** `acr.py render` turns `report.json` into a self-contained `report.html` that matches the mockup layout with real data; `acr.py pdf` prints it with headless Chrome. One commit.

### 3.1 What to copy

- CSS and body skeleton: `build_mockup.py:99-133` and `:134-177` (same as `mockup.html:3-36`, `:38-110`). Keep the window frame, sidebar, hero, ribbon, three-card grid, wide outcomes card, attention card, footer.
- Ribbon SVG and patterns `:23-40`; legend `:41-45`; donut `:47-56`; day columns `:58-73`; outcome rows `:75-85`; ring `:87-92`; sidebar rows `:94-96`. Lift each into a function in `acr/render.py`.
- Field-to-visual mapping: `/workspace/plans/2026-09-25-agent-cost-report-timing-style.md:97-128`, replacing every `¢(...)` with `usd2(...)` and every `totals.estimated_usage_usd` with `spend.headline_usd`.
- Print CSS: `/workspace/plans/2026-09-25-agent-cost-report-timing-style.md:253-263`.

### 3.2 Dollars, labels, basis (settled decision 1)

- One formatter `usd2(x) -> "$1,234.56"`. Used for hero, sidebar pills, ribbon legend, donut center, day labels, outcome rows, Details tables. No other money formatter exists in the codebase.
- Every money figure has a label next to it: `ESTIMATE` tag (yellow, `build_mockup.py:113` style) or `MEASURED` tag (green) or `EXTRAPOLATED · low confidence` (gray striped). The hero shows the basis sentence under the number: "estimated at OpenRouter list prices from measured tokens · prices fetched <date> PT".
- Hero = `spend.headline_usd` (box, measured tokens). Directly under it: "+ $54.69 extrapolated for sessions without transcripts (low confidence)" and "Measured provider spend: unavailable" (never $0). When Phase 4 provides a measured figure, the hero switches to it and says MEASURED, with the estimate shown beside it for comparison.
- Sub-line: "26 things finished, about $4.20 each" from `totals.finished_outcomes` and `totals.cost_per_completed_outcome_usd`.

### 3.3 Generalise everything the mockup hard-codes (table at `/workspace/plans/2026-09-25-agent-cost-report-timing-style.md:39-60` plus the Phase 0 B bug list)

- Six kinds of work always listed in the sidebar; empty ones grayed (`brief.md:42`). Colors: one fixed palette for the six kinds, plus waste red and in-progress stripe, defined once.
- Day chart: column count and viewBox width computed from `by_day` length (7, 8, 1, or 30 days all render). Empty days show "no agent work". A partial last day (explicit windows only; never the default window, G3) shows "partial".
- Ribbon: clamp block width to ≥ 0; stripe pattern per kind; waste sliver from `wasted_cost`.
- `STAT` map covers all five statuses. `max()` guarded for empty lists. `failure_economics` may be empty.
- Date pill from `window` ("Sep 18 – 25, 2026 (PT)"). Sessions list from `line_items` (top N by cost, "+K more" folded). Model list from `by_model` with price basis.
- Story sentence assembled from data fields only; the useful-share number is computed by the renderer (`plan:150`). No hand-written prose.
- Ring color bands: ≥ 90 % green, 70–90 % amber, < 70 % red.
- Attention list from `report.json.attention`. Draft labels marked.
- Behavior strip under the ring from `report.json.behavior` (Phase 2B.5): at most 4 tiles (invented gates, made it up / false done, broke working things, wrong or expensive model), each with count, "≈$X.XX estimated" (low figure), Alex-minutes where known, "+ N unmeasured", and a "heuristic" mark until reviewed; zero shows "none found". At most 2 Phase 2B cards in Worth your attention (bad outbound first, then a rule that didn't stop repeats). The other patterns, the high figures, rule effectiveness, excerpts, and permission denials go in Details.

### 3.4 Details section (folded `<details>`)

Holds: evidence IDs and short titles per line item; session IDs (`content_session_id`, `memory_session_id`); tokens by type per line item and per model; model and price per MTok with the 1h rule used; pricing source and fetch time; confidence; risk exposure; full failure accounting table; observer (note-taker) cost line; device table with short hashes; unmatched transcripts; unpriced models; label review counts; the behavior pattern table with low and high figures, bad outbound as incidents × recipients, rule effectiveness, and scrubbed examples (Phase 2B.5, 2B.10); a link to `line-items.csv` and `evidence.json` by relative path. Print CSS opens `<details>` for the PDF via a `--print` flag, not a CSS hack (`plan:152`).

### 3.5 PDF

`acr.py pdf` runs `google-chrome --headless=new --no-sandbox --disable-gpu --print-to-pdf=<out>/report.pdf --no-pdf-header-footer file://<out>/report.print.html` where `report.print.html` is the render with `--print`. If `google-chrome` is missing, say "PDF skipped, HTML is canonical" (`SKILL.md:165` already allows this). Do not use Playwright or `/tmp/pwenv`.

### 3.6 Verification checklist

```bash
ACR_TMP=${ACR_TMP:-/tmp/acr-weekly}; mkdir -p $ACR_TMP
cd plugin/skills/agent-cost-report
OUT=$ACR_TMP/p3
python3 scripts/acr.py render --in $ACR_TMP/p2/report.json --out $OUT && python3 scripts/acr.py pdf --out $OUT
grep -c '<script\|https://\|http://\|@import' $OUT/report.html            # expect 0
test $(grep -o 'url(' $OUT/report.html | wc -l) -eq $(grep -o 'url(#' $OUT/report.html | wc -l)
grep -c 'Measured provider spend: unavailable' $OUT/report.html          # expect ≥1
grep -c '\$0\.00' $OUT/report.html                                       # expect 0 unless a real zero-cost line item exists; inspect
grep -c '¢' $OUT/report.html                                             # expect 0
test $(grep -o 'class="behavior-tile' $OUT/report.html | wc -l) -le 4   # behavior strip has at most 4 tiles
grep -o '\$[0-9,]*\.[0-9]*' $OUT/report.html | grep -v '\$[0-9,]*\.[0-9][0-9]$' | head  # expect empty (two decimals everywhere)
grep -c 'ESTIMATE' $OUT/report.html                                      # expect ≥ number of money figures in hero+ribbon
pdftotext $OUT/report.pdf - | head -20
# fixtures: 1-day, 7-day, 30-day, empty period, single session — each renders exit 0
for f in scripts/tests/fixtures/report-*.json; do python3 scripts/acr.py render --in $f --out $OUT/fx-$(basename $f .json) || exit 1; done
# render twice, byte-identical
python3 scripts/acr.py render --in $ACR_TMP/p2/report.json --out $OUT/a && python3 scripts/acr.py render --in $ACR_TMP/p2/report.json --out $OUT/b && cmp $OUT/a/report.html $OUT/b/report.html
python3 -m unittest discover -s scripts/tests -v
```

Then view `$OUT/report.html` rendered to PNG (Chrome `--screenshot` for a fixed viewport is acceptable for a visual check; full-page needs Playwright, which is not required) and compare section order with `/workspace/timing-report-brief/mockup.png`.

### 3.8 "Wins vs mistakes" section, directly under the dollar headline (new)

Order becomes: hero + sub-line + story → **Wins vs mistakes** → cost ribbon → the rest as in `brief.md:33-42`. One card, three parts:

- **(a) Cost of mistakes**: one line under the hero, "Cost of mistakes: ≈$X.XX estimated · N episodes · M min of your time · K unmeasured", with the ESTIMATE tag and a hover-free footnote "same-session wasted turns, each counted once". The dollar figure is the **low** figure, `spend.mistakes_estimated_usd`. "M min of your time" is `spend.mistakes_alex_minutes`, shown only when known ("your time: unknown" otherwise). "K unmeasured" appears when K > 0. The **high** figure is never in this line. It appears only in Details as "Upper bound: ≈$Y.YY (adds 60-minute redo windows and project-wide fallback; likely 5–10× too high)". If there were bad outbound incidents, a second short line says "N sends to M recipients without your approval" (no dollars). The ribbon's waste segment is drawn from the same low field and carries it as `data-waste-usd="X.XX"` so 8.6 can reconcile the two from the HTML.
- **(b) Wins shipped**: a short list, newest first while costs are unmeasured (most expensive first once costs exist), capped at 5 with "+K more" folded into Details. Each row: kind icon (PR / publish / praise), title, day, and the cost: "unmeasured (session not linked to PR)" by default (G11); "≈$X.XX estimated · session-linked" once R4 exists; praise rows always "unmeasured". There is no fallback label (G11). Extrapolated wins use the gray `EXTRAPOLATED · low confidence` tag. A last row "Not tied to a win: ≈$Z.ZZ" appears only when some win cost is computed. This replaces nothing; the existing "What got done" card stays below for the full outcome list, and 3.3's sidebar is unchanged.
- **(c) Two timelines on one time axis**: one inline SVG, width computed from `by_day` length like the day chart (3.3). Shared x axis = PT days in the window, partial last day marked. Wins above the axis as dots sized by count (label = count; value = attributed dollars, or "unmeasured"); mistakes below the axis as red bars of low mistake dollars per day, with a hollow marker on days that have only unmeasured episodes and a small outbound mark on days with a bad outbound incident. Empty days show a small tick, not a gap. Each dot and bar is an `<a href="#win-<win_id>">` / `<a href="#mistakes-<day>">` link to its entry in Details. No `<script>`.
- **Details additions**: a "Wins" sub-section (one entry per win with `id="win-<win_id>"`: title, url, sessions, tokens by type, cost, attribution method, evidence IDs) and a "Mistakes by day" sub-section (one entry per day with `id="mistakes-<day>"`: low and high dollars by pattern, unmeasured episodes, Alex-minutes, outbound incidents, top examples with session id and time, scrubbed excerpts). Chrome opens a closed `<details>` when navigating to a fragment inside it; verify this in the checks below. If it does not, keep these two sub-sections outside the fold (always open) and keep the rest folded. The PDF (`--print`) renders both timelines plus these entries as tables.
- Everything is computed from `report.json`; no hand-written numbers.

Verification:

```bash
grep -c 'Cost of mistakes' $OUT/report.html                         # expect 1
python3 -c "h=open('$OUT/report.html').read();i=h.find('Upper bound');d=h.find('<details');assert i==-1 or (d!=-1 and i>d),'high figure only in Details'"
grep -o 'href="#win-[^"]*"' $OUT/report.html | sort -u | while read h; do id=${h#href=\"#}; id=${id%\"}; grep -q "id=\"$id\"" $OUT/report.html || echo "MISSING $id"; done
grep -o 'href="#mistakes-[^"]*"' $OUT/report.html | sort -u | while read h; do id=${h#href=\"#}; id=${id%\"}; grep -q "id=\"$id\"" $OUT/report.html || echo "MISSING $id"; done
python3 - <<PY
import re;h=open('$OUT/report.html').read()
i_hero=h.find('class="hero');i_wm=h.find('class="wins-mistakes');i_rib=h.find('class="ribbon')
assert 0<=i_hero<i_wm<i_rib, 'Wins vs mistakes must sit between hero and ribbon'
PY
# visual: open $OUT/report.html#win-<first id> in Chrome headless screenshot; the Details entry must be visible
```

Guards: no `<script>`; the mistakes line never reads anything but `spend.mistakes_estimated_usd` (low) and its minutes/unmeasured fields; `mistakes_high_usd` appears only inside Details; no win dollar without ESTIMATE (or EXTRAPOLATED) and its method; no win shown as $0 when unmeasured; at most 5 win rows in the summary.

### 3.7 Anti-pattern guards

- No jinja2, no weasyprint, no Playwright, no CDN fonts, no `<script>` (`plan:146-154`).
- No `cents()` function, no `¢`, no four-decimal dollars.
- No money figure without a label and basis.
- No hand-written sentences with numbers in them. Numbers are computed.
- Do not put CSS in SKILL.md. It lives in `render.py` only.
- Do not drop the honesty list; it moves to the footer and Details.

---

## Phase 4 — Gap: measured OpenRouter spend via the per-key endpoint

**Goal of the session:** when `OPENROUTER_API_KEY` is present in the environment, the report can show a MEASURED period total next to the estimate, with honest reconciliation. Without it, the estimate path stays as-is. One commit.

**Approved by G5 (Alex 2026-09-25):** a regular inference `OPENROUTER_API_KEY` may be provided to a report run; no management or provisioning key. The key is supplied as an environment variable through the house's secure secret request flow (mechanism UNVERIFIABLE, see Phase 0). The script never reads a settings file, never prints the key, never writes it to any output, and never calls the endpoint when the variable is unset.

### 4.1 What the endpoint gives (Phase 0 E)

`GET https://openrouter.ai/api/v1/key` with `Authorization: Bearer $OPENROUTER_API_KEY` returns `data.usage` (lifetime), `usage_daily` (current UTC day), `usage_weekly` (current UTC week Monday–Sunday), `usage_monthly` (current UTC month), `limit`, `limit_remaining`, `is_free_tier`. These are snapshots of the current calendar buckets in UTC, not a range query.

### 4.2 What to implement

- `acr.py measure-openrouter --out <dir>`: if `OPENROUTER_API_KEY` is unset, write `measured.json = {status: "unavailable", reason: "OPENROUTER_API_KEY not provided"}` and exit 0. If set, call the endpoint once, store `{status: "ok", fetched_at_utc, fetched_at_pt, usage_daily, usage_weekly, usage_monthly, usage_lifetime, key_hint: null}` and nothing else. No key material in outputs. Errors → `status: "error"` with the HTTP status only.
- Reconciliation rule, because the buckets are UTC calendar and the report window is PT: the measured figure is shown only as `usage_weekly` or `usage_monthly` **with its own bucket label** ("OpenRouter measured, current UTC week Mon 21 Sep – now"). It is never re-cut to the PT window. If the report window is not fully inside one bucket, the render says "measured bucket does not match the report window; shown for reference".
- Per-session measured cost is not available from this endpoint. Line items keep `cost_basis: estimated_usage`. Only the `spend.agent_measured_usd` total and `measured_status: "ok (period bucket)"` change. The hero switches to MEASURED only when the bucket fully covers the window (`bucket_start_utc <= window_start_utc and now >= window_end_utc`); otherwise the hero stays ESTIMATED and the measured figure sits beside it.
- Sanctioned range source for later: `GET /api/v1/activity?date=` gives per-day per-model USD for the last 30 days, but needs a management/provisioning key, not the inference key. Document this in SKILL.md as a possible upgrade path and stop there. Do not implement it. G5 settled it: no management key, so O2 is closed.
- The observer note-taker's OpenRouter spend is part of the same key's usage if the observer uses that key. The render must say: "measured total includes note-taker calls if they share this key; the estimate above excludes them".

### 4.3 Verification checklist

```bash
ACR_TMP=${ACR_TMP:-/tmp/acr-weekly}; mkdir -p $ACR_TMP/p4
cd plugin/skills/agent-cost-report
env -u OPENROUTER_API_KEY python3 scripts/acr.py measure-openrouter --out $ACR_TMP/p4 && cat $ACR_TMP/p4/measured.json   # status unavailable
# with a key present (only after Alex's go; the value is never echoed):
# OPENROUTER_API_KEY=... python3 scripts/acr.py measure-openrouter --out ... ; grep -c 'sk-' measured.json  -> 0
grep -rn 'settings.json\|CLAUDE_MEM_OPENROUTER_API_KEY' scripts/ || echo "no settings reads"
grep -rn 'os.environ' scripts/acr/measure.py     # only OPENROUTER_API_KEY, read once, never logged
python3 -m unittest discover -s scripts/tests -v   # mocked urlopen: unavailable / ok / error paths, bucket-vs-window rule
python3 scripts/acr.py render --in <report.json with measured status ok> --out ... && grep -c 'MEASURED' report.html
```

### 4.4 Anti-pattern guards

- Never read `CLAUDE_MEM_OPENROUTER_API_KEY` from `~/.claude-mem/settings.json`. Env var only.
- Never write the key, a prefix of it, or a hash of it to any output.
- Never attribute the per-key total to individual sessions or line items.
- Never show `$0.00` when the call was skipped or failed.

---

## Phase 5 — Gap: Mac transcripts (measured instead of extrapolated)

**Goal of the session:** define and test the path that turns Mac sessions from "extrapolated (low confidence)" into measured tokens. Until Alex runs it, nothing changes in the numbers. One commit (script + docs + tests only).

**Needs Alex's explicit go:** running anything on Alex's Mac, and copying any file off it. Two sanctioned ways exist. (a) Alex runs the export and shares the file. (b) An orchestrating agent runs `acr.py collect --export-device mac` on Alex's registered Mac through the house's registered-machine tooling and copies the small export file to the box. Way (b) happens only after Alex's explicit go for that specific run (window, machine, destination path named). A go for one run is not a go for the next. **G6 (Alex 2026-09-25): yes to the Mac export for Sep 18–26.** That go covers one run: window 2026-09-18 to 2026-09-26 exclusive, Alex's registered Mac, destination `$ACR_TMP/p5/device-usage-mac.json` on the box. Any other window or a re-run needs its own go.

### 5.1 Facts that shape this

- Transcripts never leave the machine (Phase 0 C: cloud sync replicates DB rows, not `.jsonl`).
- The box DB has the Mac's observations and summaries as replica rows keyed by `memory_session_id`, but `sdk_sessions` rows do not sync, so the box has no `content_session_id` for Mac sessions. The join to transcripts must happen on the Mac, where its own local `claude-mem.db` has both ids.
- Claude Code deletes transcripts after 30 days by default (`cleanupPeriodDays`). The Sep 18–25 Mac transcripts exist until about Oct 18 unless the Mac's setting differs (UNVERIFIABLE).

### 5.2 What to implement

- `acr.py collect --export-device <label>`: on any machine, runs Phase 1's collector against that machine's `~/.claude/projects`, takes a read-only snapshot of that machine's local `claude-mem.db`, and writes `device-usage-<label>.json` containing the usage rows plus the local `sdk_sessions` map `{memory_session_id → content_session_id, project, started_at_epoch}` for the window. No observation text, no prompts, no secrets. Only ids, timestamps, token counts, model names.
- `acr.py rollup --device-usage <file>...`: merges exported files. Rows join to box-side replica sessions on `memory_session_id`; those sessions flip from `cost_basis: extrapolated` to `estimated_usage` with `device: <label>`. The extrapolation is recomputed for whatever remains unmeasured and stays labeled low confidence.
- The skill's scripts directory must be runnable from a plain checkout on the Mac with system `python3` (3.9+ has `zoneinfo`). Document the command Alex would run, and that the output file is small and safe to copy.
- SKILL.md documents both paths: "Ask Alex to run `python3 scripts/acr.py collect --export-device mac --start ... --end ...` on the Mac and share the file. Or, only after Alex's explicit go for this specific run, run the same command on the registered Mac through the house's registered-machine tooling and copy only `device-usage-mac.json` to the box." The export rule holds on either path: no prompt text, no observation text, no settings.
- The export may also carry per-session pattern counts, episode windows (timestamps only), and priced turn totals for the Phase 2B patterns (numbers only, no excerpts). Without them, Mac episodes stay "unmeasured" in dollars.

### 5.3 Verification checklist

```bash
ACR_TMP=${ACR_TMP:-/tmp/acr-weekly}; mkdir -p $ACR_TMP/p5
cd plugin/skills/agent-cost-report
python3 scripts/acr.py collect --export-device box --start 2026-09-18 --end 2026-09-26 --out $ACR_TMP/p5
python3 - <<PY
import json;d=json.load(open('$ACR_TMP/p5/device-usage-box.json'))
assert set(d)>= {'device','window','rows','sessions'} and not any('text' in r or 'prompt' in r for r in d['rows'])
PY
# merge test with a synthetic second device file (fixture): extrapolated_unmeasured_usd decreases, agent_estimated_usd increases, labels correct
python3 -m unittest discover -s scripts/tests -v
grep -n 'needs Alex' SKILL.md   # Mac step is gated in the skill text
```

### 5.4 Anti-pattern guards

- No unsanctioned rsync or scp from the Mac. Transfer only via the sanctioned registered-machine tooling after Alex's explicit go for that run, or by Alex.
- Do not export prompt text, observation text, or settings from any machine.
- Do not silently drop the extrapolated line when it becomes small; show it until it is zero and then say "all sessions measured".

---

## Phase 6 — Gap: Grok Bot seat usage

**Goal of the session:** the report shows Grok Bot usage honestly. One commit.

### 6.1 Finding (Phase 0 E)

Grok Bot is Cursor's cloud agent. The house runs it with "No xAI key" (`/home/box/agent-data/org/policies.md:67`). Cursor documents a weekly usage grant visible on the plan screen and no API or export. The xAI Management API covers xAI API keys only. No sanctioned programmatic source exists.

### 6.2 What to implement

- `spend.grok_bot_usage = {status: "unavailable", reason: "no documented API or export for Cursor Grok Bot seat usage", checked_sources: [...urls above...]}` written by `rollup`.
- Render: a sidebar row and a Details line "Grok Bot usage: unavailable (Cursor exposes seat usage only on the plan screen)". No dollar figure. No seat count (G4, settled): the row reads exactly "Grok Bot usage: unavailable" and nothing else.
- SKILL.md: a short "Grok Bot" paragraph stating this. Alex chose "unavailable" with no seat count (G4); if Alex ever supplies a manual figure it is entered as `measured_manual` with `entered_by: Alex` and the date, never inferred, and that would be a new decision.

### 6.3 Verification checklist

```bash
grep -c 'Grok Bot usage: unavailable' <report.html>     # expect 1
grep -c 'grok' <line-items.csv> | true                   # no Grok line items with dollars
python3 -c "import json;d=json.load(open('<report.json>'));assert d['spend']['grok_bot_usage']['status']=='unavailable'"
```

### 6.4 Anti-pattern guards

- Never $0.00 for Grok Bot. Never a guessed per-seat price from third-party sites. Never a seat count (G4).
- Do not add an xAI API call; the house has no xAI key for this.

---

## Phase 7 — Skill rewrite and house sync

**Goal of the session:** SKILL.md reflects the new pipeline and keeps every ALWAYS rule; plugin copy, house copy, and mirrors are kept in sync by copy + checksum. One commit.

### 7.1 SKILL.md rewrite (copy structure from the current file, change content)

Keep verbatim: Purpose (`:14-18`), Questions (`:24-32`), Progressive Mem Search (`:49-72`), Work categories (`:74-76`), Failure types and Rework lock (`:78-84`), Money labeling table (`:119-128`), Truthfulness ALWAYS rules (`:184-195`), Creed (`:213-215`).

Replace:
- Frontmatter `description`: "Believable agent cost report for any period, default the last 7 full days PT, not counting today. Measured tokens from Claude Code transcripts priced at OpenRouter list prices (ESTIMATED), measured provider spend when a sanctioned source exists, note-taker cost separate, Timing-style HTML/PDF plus report.json, line-items.csv, evidence.json." Add `allowed-tools: [Bash, Read, Write, AskUserQuestion]` in the list form of `plugin/skills/cloud-sync/SKILL.md:4-7` (and the MCP search tools the mem-search flow needs).
- Default scope (`:42-47`): the last 7 full days PT, today excluded, end exclusive (G3); `--session`; `--project` + period.
- Cost model (`:86-117`): the Phase 1/2 formulas. Delete the `discovery_tokens × input` line and the PRICE-TABLE path (`:117`). Add the observer line "priced separately, never agent cost".
- Deliverables (`:161-182`): the Timing-style section order from `brief.md:33-42`, dollars to two decimals with labels, Details section contents.
- Recipe (`:197-204`): the exact commands, in order: `prices` → `collect` → `rollup` → review (mem-search confirm pass, `review --apply`) → `render` → `pdf` → optional `measure-openrouter` (needs Alex's go) → optional `--device-usage` merge (needs Alex's go).
- Add "Gaps and gates": OpenRouter key, Mac export, Grok Bot, each marked "needs Alex's explicit go".
- Remove house-only links that do not resolve outside this box (`sand-workflow:*` at `:40,51`) or keep them only in the house copy (open question O3; G2 only settles that the mirrors ship, which makes the plugin copy and the mirrors public).

### 7.2 Sync: copy + checksum

- Add `scripts/acr.py sync-check [--write]` that compares `sha256sum` of `SKILL.md` and every file under `scripts/` across: plugin dir (source of truth), `/home/box/agent-data/workflows/agent-cost-report/`, and the four mirrors `/workspace/claude-mem/{claude-mem-cursor,claude-mem-grok-bot,cowork,openclaw}/skills/agent-cost-report/`. Without `--write` it reports drift and exits 1. With `--write` it copies plugin → others and re-checks. Destinations are a list in one place, overridable by `--dest`.
- The house copy path is outside the repo. The four mirrors in the repo are written too (G2, settled: the mirror plugins carry the skill as byte copies, tracked in git). Today the mirror `mem-search` files are host-adapted, but the six `agent-cost-report` copies are byte-identical, so byte-copy is the truth to keep.
- Write a `CHECKSUMS.txt` next to SKILL.md in the plugin dir (sha256 of every shipped file) so drift is visible in git diffs.

### 7.3 Verification checklist

```bash
cd plugin/skills/agent-cost-report
grep -n 'measured spend unavailable\|never "\$0\|completed outcomes\|failure_type\|progressive\|evidence IDs' SKILL.md   # all ALWAYS rules present
grep -c 'discovery_tokens' SKILL.md        # expect ≤1 and only in the "observer cost, separate" sentence
grep -c 'PRICE-TABLE' SKILL.md             # expect 0
grep -c '¢\|cents' SKILL.md                # expect 0
grep -n "needs Alex" SKILL.md              # OpenRouter key, Mac, Grok Bot, merge/publish
python3 scripts/acr.py sync-check          # reports drift (expected before --write)
python3 scripts/acr.py sync-check --write  # all destinations: house copy plus the four mirrors (G2)
sha256sum -c CHECKSUMS.txt
md5sum SKILL.md /home/box/agent-data/workflows/agent-cost-report/SKILL.md
```

### 7.4 Anti-pattern guards

- Do not drop or reword the eight truth rules.
- Do not put CSS or code in SKILL.md; point to `scripts/`.
- Do not write into any destination outside the 7.2 list (plugin dir, house copy, the four mirrors per G2).
- Do not edit `CHANGELOG.md` (generated).

---

## Phase 8 — Final verification

**Goal of the session:** prove the rebuilt skill reproduces the research run, handles the other scopes, and passes the anti-pattern greps. One commit (fixture updates and a short `VERIFICATION.md` in the skill dir).

### 8.1 Research window run and comparison

Run for Sep 18–26 PT exclusive twice: once with the saved price snapshot, once with fresh prices.

```bash
ACR_TMP=${ACR_TMP:-/tmp/acr-weekly}; mkdir -p $ACR_TMP
cd plugin/skills/agent-cost-report
OUT=$ACR_TMP/p8
python3 scripts/acr.py collect --start 2026-09-18 --end 2026-09-26 --out $OUT
python3 scripts/acr.py rollup  --start 2026-09-18 --end 2026-09-26 --out $OUT --prices /workspace/weekly-cost-workflow/out/openrouter_prices.json
python3 scripts/acr.py render --in $OUT/report.json --out $OUT && python3 scripts/acr.py pdf --out $OUT
python3 - <<PY
import json
new=json.load(open('$ACR_TMP/p8/report.json'))
old=json.load(open('/workspace/weekly-cost-workflow/out/summary.json'))
t,s=new['totals'],new['spend']
print('sessions',t['sessions'],old['sessions'])
print('real',t['real_work_sessions'],old['substantive_sessions'])
print('projects',t['projects'],old['projects'])
print('devices',t['devices'],len(old['seats']))
print('finished',t['finished_outcomes'],old['outcomes']['sessions_with_completed_summary'])
print('ship',t['ship_events'],old['outcomes']['ship_events_distinct'])
print('hours',t['agent_hours'],old['hours']['agent_session_hours'])
print('tokens',t['tokens']['agent_measured_total'],old['tokens']['agent_tokens_measured_box_transcripts'])
print('agent_usd',s['agent_estimated_usd'],old['spend']['agent_api_equivalent_est_usd'])
print('extrap',s['extrapolated_unmeasured_usd'],old['spend']['extrapolated_unmeasured_sessions_usd'])
print('observer',s['observer_note_taker_est_usd'],old['spend']['observer_note_taker_est_usd'])
PY
```

Tolerances and expected drift:

| Number | Research | Tolerance | Expected drift source |
|---|---|---|---|
| sessions | 80 | ±2 | the live probe saw 81 `sdk_sessions` (one codex); keying differences |
| real-work sessions | 47 | ±2 | same |
| projects | 23 | ±1 | `projects_incl_obs_only` was 24 |
| devices | 3 | exact | replica rows are stable |
| finished outcomes | 26 | ±1 | summary text unchanged; rule copied |
| ship events | 5 | exact | regex copied |
| agent hours | 13.8 | ±0.3 | timestamp set may include new transcript stamps |
| measured tokens (box) | 81,783,140 | ±0.5 % | transcripts could be pruned after 30 days (Oct 18); run before then |
| agent estimated USD, saved prices | 109.25 | ±0.5 % | the saved price file has no `cache_write_1h`, so the 2× input fallback fires as before |
| agent estimated USD, fresh prices | 109.25 | ±5 % | explicit 1h price and list-price changes; the report states the fetch date |
| extrapolated USD | 54.69 | ±2 % | ratio recomputed from the same inputs |
| observer USD | 5.84 | ±2 % | dedup rule copied |

Any drift outside tolerance gets a written explanation in `VERIFICATION.md` with the query or rule that differs. No silent acceptance.

### 8.2 Other scopes (original spec)

```bash
python3 scripts/acr.py rollup --session <a content_session_id with a transcript> --out $OUT/single && python3 scripts/acr.py render --in $OUT/single/report.json --out $OUT/single
python3 scripts/acr.py rollup --project claude-mem --start 2026-09-18 --end 2026-09-26 --out $OUT/proj && python3 scripts/acr.py render --in $OUT/proj/report.json --out $OUT/proj
python3 scripts/acr.py rollup --out $OUT/default && python3 -c "import json,datetime,zoneinfo;w=json.load(open('$OUT/default/report.json'))['window'];print(w);today=datetime.datetime.now(zoneinfo.ZoneInfo('America/Los_Angeles')).date();assert w['end_exclusive_pt']==today.isoformat() and w['start_pt']==(today-datetime.timedelta(days=7)).isoformat() and w['partial_last_day'] is False"   # default = last 7 full PT days, today excluded (G3)
```

### 8.3 Anti-pattern greps (all must pass)

```bash
cd plugin/skills/agent-cost-report
# discovery_tokens never priced as agent cost
grep -rn 'discovery_tokens' scripts/acr/*.py | grep -v -i 'observer\|note.taker\|dedup' && echo FAIL || echo ok
# no $0.00 where measured is unavailable
for f in $OUT/report.html $OUT/single/report.html $OUT/proj/report.html; do grep -n 'Measured provider spend' $f | grep -q '\$0' && echo FAIL $f; done; echo ok
# no cents-first strings
grep -rn '¢\|cents(' scripts/ SKILL.md $OUT/report.html && echo FAIL || echo ok
# two decimals everywhere
grep -oh '\$[0-9,]*\.[0-9]*' $OUT/report.html | grep -v '\.[0-9][0-9]$' && echo FAIL || echo ok
# no secrets in outputs
grep -rn 'sk-or-\|Bearer \|OPENROUTER_API_KEY=' $OUT/ && echo FAIL || echo ok
# no external resources
grep -c '<script\|https://\|http://\|@import' $OUT/report.html   # 0
# live DB untouched (mtime before/after the whole run)
stat -c '%y' ~/.claude-mem/claude-mem.db
# unit tests
python3 -m unittest discover -s scripts/tests -v
```

### 8.4 Visual check

Render `$OUT/report.html` to PNG and compare section order and labeling with `/workspace/timing-report-brief/mockup.png`. Record the PNG path in `VERIFICATION.md`. Pixel-diff is not required; the layout and the labels are.

---

### 8.5 Behavior metrics check (Phase 2B)

```bash
python3 scripts/acr.py behavior-sample --in $OUT/report.json --per-metric 20 --seed 7 --out $OUT/behavior-spotcheck.md
```

- **Human/bot tag first (R2):** hand-check 20 random human-tagged user turns and 20 bot-tagged ones. At least 19 of 20 human-tagged turns must really be Alex, or no user-message count ships. Record in `VERIFICATION.md`.
- For each tile pattern (P1, P6+P7, P2, P3), hand-check 20 flagged turns or episodes (or all of them if fewer) in `behavior-spotcheck.md`. Mark each true, false, or unsure against the line it cites. Record precision per pattern in `VERIFICATION.md`. A pattern needs at least 70% precision to stay in the summary strip. Below that it moves to Details as "low confidence".
- Hand-check 10 random unflagged sessions for obvious misses (for example, an invented gate or a failed command followed by a retry that nothing caught) and write down what was missed.
- S1 error count within ±10% of the 2B.7 probe (54 `is_error` results, minus permission denials) for Sep 18–26, or a written reason.
- `union_low_usd <= union_high_usd <= agent_estimated_usd + extrapolated_unmeasured_usd`; every behavior dollar in the HTML has an ESTIMATE tag; the strip has at most 4 tiles; P9 bad outbound shows incidents × recipients and no dollars; unmeasured episodes show "unmeasured", never $0; no secrets in `behavior.json`, `evidence.json`, or the HTML (8.3 grep covers the directory).
- Rule effectiveness: the Sep 10 invented-gates rule, run over a window that covers Sep 3–17, gives `not_stopped` if both sides reach 50 human prompts, else `not_enough_data`. Either way the denominator is shown.
- If the classifier ran (G8), its spend is at or under the cap and appears only as "classifier cost (separate)".

### 8.6 Wins vs mistakes reconciliation

```bash
python3 - <<PY
import json,re
d=json.load(open('$ACR_TMP/p8/report.json'));s=d['spend'];h=open('$ACR_TMP/p8/report.html').read()
m=s['mistakes_estimated_usd']   # the low figure
assert s['mistakes_high_usd'] >= m
li=sum(x['wasted_cost'] for x in d['line_items'])
rib=float(re.search(r'data-waste-usd="([0-9.]+)"',h).group(1))   # renderer writes the ribbon waste value as a data attribute
days=sum(x['usd'] for x in d['timeline']['mistakes_by_day'])
print(m,li,rib,days)
assert abs(m-rib)<=0.01 and abs(m-li)<=0.01 and abs(m-days)<=0.01, 'mistakes line, ribbon waste, line items, and day timeline must reconcile to the cent'
assert m <= s['agent_estimated_usd']
w=d['wins']
if w['cost_status']!='unmeasured':
    assert abs(w['total_attributed_usd']-sum(i['usd'] for i in w['items']))<=0.01
    assert abs(sum(x['usd'] for x in d['timeline']['wins_by_day'])-w['total_attributed_usd'])<=0.01
assert sum(x['count'] for x in d['timeline']['wins_by_day'])==len(w['items'])
PY
```

- Hand-check 5 wins: the PR or publish really happened in the window (`gh pr view` read-only, or the transcript line). If costs are session-linked, check that the sessions named in the commit trailers really led to it (there is no fallback path, G11). Record in `VERIFICATION.md`.
- Hand-check 3 mistake days: the day's dollars match the flagged turns listed in its Details entry.
- Click-through: every timeline link resolves to a Details entry (3.8 checks), and the screenshot of `report.html#win-<id>` shows the entry.
- Any gap outside one cent is a bug, not drift. Fix it before shipping.

### 8.7 Comparison with Frustration Arc's last 7 days

Target: Frustration Arc's Sep 18 → 25 figures (`/workspace/frustration-arc/costs.md`, `costs.csv`): **$6.70 low – $14.43 high, 13 episodes, 8 unmeasured.** Run for Sep 18–26 PT exclusive (the 8.1 run) and compare. The bases differ: Frustration Arc priced claude-mem `discovery_tokens` as Opus input (Estimate A), while this report prices transcript tokens and never prices `discovery_tokens` as agent cost. So episodes are compared tightly and dollars loosely.

| Number | Frustration Arc | Tolerance | Why it can differ |
|---|---|---|---|
| Episodes the report can see | 6 (E135, E096, E066, E129, E067 on Sep 18; E091 on Sep 19; Alex-typed Mac prompts in box claude-mem) | all 6 found, ±1, each matched by id and time (±15 min) in `VERIFICATION.md` | detector threshold; grouping edge |
| Episodes the report cannot see | 7 (M01–M07, Sep 21–25, rebuilt from rule files and an agent-written transcript) | listed as "outside report sources" in `VERIFICATION.md`, not counted | the R2 bot filter drops relayed text; R1 missing |
| Total episodes | 13 | 6 ±1 found + 7 listed = 13 | same |
| Unmeasured | 8 | without the Mac export: all found Mac episodes unmeasured (6 ±1); with the Phase 5 export (G6): 1–3 | Mac sessions have no transcript on the box |
| Low dollars | $6.70 | without the Mac export: "unmeasured", never $0; with the export: 0.5×–2× ($3.35–$13.40) | tokens basis (transcript vs discovery_tokens) and cache reads |
| High dollars (Details) | $14.43 | with the export: 0.5×–2× ($7.22–$28.86); high ≥ low always | same, plus redo window edges |
| Pattern of each found episode | as in `episodes.jsonl` | ≥5 of 6 match the primary pattern or one of `all_categories` | model-vs-heuristic attribution |

Any number outside tolerance gets a written reason in `VERIFICATION.md`. Frustration Arc's figures are never copied into the report itself.

---

## What ships

- **PR:** from `work/cost-report-weekly` to `main` on `thedotmack/claude-mem`, opened after Phase 8 (pushing the work branch and opening the PR: routine, Alex 2026-09-25), titled "feat(skills): agent-cost-report rebuilt on transcript-measured tokens, Timing-style, dollars". Opening the PR: routine. **Merging: needs Alex's explicit go** (house loop: PR → babysit → merge only if Alex's green covers it → version-bump).
- **Babysit:** `/claude-mem:babysit` on the PR until CI and review comments are clear.
- **Version bump:** MINOR (G7, settled by Alex 2026-09-25; matches the house precedent in `plans/2026-09-16-grok-bot-live-index.md`, Phase 4). **Running `/version-bump` still needs Alex's separate go.** npm publish stays a human step (`plugin/skills/version-bump/SKILL.md` description).
- **Publishing consequence (G1, settled: public):** `sync-marketplace.cjs` already installs the untracked dir locally, and `package.json` `files` includes `plugin/skills`, so merging makes this skill part of the public claude-mem plugin and the npm package. Alex chose that. The PR target is `main`.
- **Still gated, each needs Alex's separate go (Alex, 2026-09-25 4:42pm PT):** merging to `main`; npm publish; running `/version-bump`. Nothing else in this plan waits on Alex.
- **Approved in principle by the green:** a regular `OPENROUTER_API_KEY` for report runs (G5); the Sep 18–26 Mac export, that one run only (G6; any later run needs its own go); the classifier when enabled, under the $2.00 cap (G8); the plugin dir plus the four mirrors as sync destinations (G2); keeping Grok Bot chats (G14); the session id as a commit trailer, id only (G13).
- **Upstream changes that still need their own plan and go:** write-time human/bot tagging in claude-mem (R2); model-id logging for Grok and Codex (R3); the Grok Bot chat retention mechanism (R1); stamping the `Claude-Session` trailer in the house ship flow (R4). This plan builds only the report side and shows the listed fallbacks until they land.

---

## Green checklist (Alex's decisions, 2026-09-25 4:42pm PT, relayed by Ori, against commit `7f5e9e7d`)

Each item keeps the question as asked and records the answer. The answers are binding; the plan text above has been reconciled with them.

- **G1 — Public or house-only?** Merge to `main` ships the skill and its Python scripts in the public plugin and npm package. **Decision: ship in the public claude-mem plugin.** PR target is `main`; merge itself stays gated.
- **G2 — Mirrors.** Should `claude-mem-cursor`, `claude-mem-grok-bot`, `cowork`, `openclaw` carry `agent-cost-report` (byte copies, tracked in git)? **Decision: yes, the mirror plugins carry the skill.** Phase 7's sync writes plugin dir, house copy, and all four mirrors.
- **G3 — Default window edge.** "Past 7 days" including today as a partial day, or the last 7 complete days ending yesterday? **Decision: the last 7 full days in PT, not counting today.** `end` = the PT midnight that started today (exclusive), `start` = `end − 7 days`. The default window has no partial day (1.2, 3.3, 7.1, 8.2 updated).
- **G4 — Grok Bot seats.** Seat count next to "usage unavailable"? **Decision: show "unavailable", no seat count.** (6.2 updated.)
- **G5 — OpenRouter key.** Go / no-go on `OPENROUTER_API_KEY` for report runs, and whether a management key is wanted. **Decision: a regular inference key is fine; no management key.** O2 is closed (Phase 4 updated).
- **G6 — Mac export.** Go / no-go on `acr.py collect --export-device mac` for Sep 18–26. **Decision: yes, for Sep 18–26.** One run; window, machine, and destination are named in Phase 5. Any other run needs its own go.
- **G7 — Version bump size.** MINOR or PATCH? **Decision: MINOR.** Running `/version-bump` is still gated.
- **G8 — Behavior classifier.** On or off; model, path, cap? **Decision: off by default; $2.00 cap per run when enabled.** Model Claude Haiku 4.5 at list, path per G5 or Claude Code headless (2B.4 updated).
- **G9 — Behavior tiles up top.** The 4 proposed tiles? **Decision: the plan's 4 tiles** (Invented gates / asking instead of doing; Made it up or said done when it wasn't; Broke working things; Wrong or expensive model). Everything else in Details.
- **G10 — Keep the two metrics Frustration Arc didn't list, and how to define hedging?** **Decision: keep both; hedging = caveats or "can't be sure" when the answer was already available.** S2's detector now requires that the answer was available (an earlier tool result covers it, or a read-only check was possible and not run); the density rule is dropped (2B.3 updated).
- **G11 — Fallback win cost.** Show the "worktree lineage + time split" estimate meanwhile? **Decision: no. Win cost shows "unmeasured" until sessions are linked to PRs.** The fallback is removed from 2.8, 3.8, 8.6, and the schema.
- **G12 — What counts as a win.** **Decision: a win is a merged PR, a published version, or Alex praising the work.** Finished work is not a win and stays in "What got done"; 24-hour deploys are not counted; praise wins are counted and never costed (2.8 updated).
- **G13 — Session-id linking (R4).** PR body line and/or commit trailer? **Decision: stamp the session id as a commit trailer, id only.** `Claude-Session: <content_session_id>`, bare id, no PR body line. The house ship-flow change is a separate upstream plan; this report reads the trailer once it exists (0.5, 2.8 updated).
- **G14 — Keep your Grok Bot chat turns (R1).** **Decision: keep Grok chats.** The retention mechanism is upstream with its own plan; until then Grok Bot episodes stay "unavailable" (0.5 updated).
- **G15 — Rule effectiveness settings.** **Decision: plan defaults.** N = 7 days before and after, minimum 50 human prompts per side, rule table seeded from Frustration Arc's `trend.md`.
- **G16 — Detector thresholds.** **Decision: plan defaults.** House default model table from Frustration Arc (Claude for claude-mem work, deepseek-flash for cheap evals), bad outbound recipient threshold 10, final-message limit 150 words.

**Still gated after the green, each needs Alex's separate go:** merging to `main`, npm publish, `/version-bump`. Pushing the work branch and opening the PR are routine.

The old recovery question (the previous revision's G13, before renumbering; unrelated to today's G13) is settled by Frustration Arc's rule: retries that worked are in the redo window, so they count only in the high figure.

## Risks

- **Transcript retention.** Box and Mac transcripts vanish after 30 days by default. The Sep 18–26 verification must run before mid-October or the measured-token comparison loses data.
- **Untracked dir already installed.** The current buggy SKILL.md (prices `discovery_tokens`) is live in the marketplace copy on this box via `sync-marketplace.cjs`. Until Phase 7 lands and `build-and-sync` runs, any use of the skill produces the 1.9-cent style answer.
- **Per-key measured totals mislead if mislabeled.** UTC calendar buckets versus PT windows, and note-taker calls sharing the key. Phase 4's bucket-label rule is the guard.
- **Keyword labels in a manager report.** Without the review pass, categories are guesses. Phase 2's `label_source` and the footer count make the state visible; they do not make the labels right.
- **Remote sessions cannot join transcripts on the box.** Only the Mac-side export fixes this; extrapolation stays low confidence until then.
- **Price drift.** List prices change; the report states the fetch date and the 1h rule used, and the comparison run pins the saved price file.
- **Win attribution is a judgment call.** G11 settled it: no lineage fallback, so every win cost is "unmeasured" until R4 lands. Once trailers exist, a linked cost is only as good as the id an agent stamped; 8.6 hand-checks 5 wins.
- **Bot-written "user" messages.** About 31% of "user" messages were agents. Without the R2 tagger, behavior counts would be inflated and relayed text would be shown as Alex's words. Phase 2B refuses to count until the tagger passes, and 8.5 checks it by hand.
- **Thin human data.** The box has few Alex-typed messages after Sep 19 and no Grok Bot chats after Sep 16. Most recent episodes (Frustration Arc's M01–M07) are invisible to the report, and per-100-prompt rates can collapse (Sep 21 week: 18 prompts, 38.9 per 100). The report shows denominators and "not enough data" rather than a rate.
- **High figure overstates.** The high figure is 5–10× too high by Frustration Arc's own check. It stays in Details, labeled as an upper bound.
- **Different cost basis from Frustration Arc.** Its dollars price `discovery_tokens`; this report prices transcript tokens. 8.7 compares episodes tightly and dollars loosely, and without the Mac export the last week's dollars are "unmeasured" here.
- **Wins look free or unknown.** Until sessions are linked to PRs (R4), every win cost is "unmeasured", so "Wins vs mistakes" shows dollars on one side only. The render says why.
- **Session ids in public commits (R4).** G13 settled: the id goes in a commit trailer, id only, so it is visible in the public repo's history. Ids are opaque but still identify sessions.
- **Behavior heuristics are noisy.** Keyword and structure rules will flag some honest turns and miss some bad ones. Counts stay labeled heuristic, and Phase 8 precision gates what reaches the summary.
- **Alex's words behind the metrics are partly secondhand.** Frustration Arc's 142 episodes mix Alex-typed prompts with relayed lines; its Sep 21–25 episodes are rebuilt from rule files and an agent-written transcript. The planner's own quotes (2B.0) are mostly relayed too.
- **`${CLAUDE_SKILL_DIR}` may not exist.** SKILL.md gives the "resolve this file's directory" instruction first.

## Open questions

Not part of the green. O1, O3, and O4 are still open; the plan's proposed defaults apply until Alex says otherwise.

- **O1 — Session count basis.** Research counted 80; the live probe counted 81 `sdk_sessions` (one codex). Which is the manager-facing number: all sessions, or Claude-only? Phase 2 counts all and shows platform in Details; confirm.
- **O2 — Activity endpoint.** Closed by G5 (no management key). Per-day per-model measured USD from `/api/v1/activity` stays a documented upgrade path only.
- **O3 — House copy of SKILL.md with `sand-workflow:*` links.** Keep those links only in the house copy, or drop them everywhere?
- **O5 — Grok Bot chats as a source.** Moved to G14 (prerequisite R1).
- **O4 — Where do report outputs go by default?** The current skill writes to a workspace path (`SKILL.md:163`). Proposed default: `~/.claude-mem/reports/agent-cost-report/<start>_<end>/`. Confirm or name another.
