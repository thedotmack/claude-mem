# Agent Cost Report — weekly rebuild (transcript-measured, Timing-style, dollars)

**Date:** 2026-09-25 (PT)
**For:** Alex Newman
**Status:** PLAN ONLY — do not execute until Alex greens it. Nothing implemented. Nothing committed by the planner.
**Branch / worktree:** `work/cost-report-weekly` at `/workspace/claude-mem/.claude/worktrees/cost-report-weekly`. Never switch branches.
**Execute with:** `/do` on this file, one phase per fresh session, commit at the end of each verified phase.
**Revised 2026-09-25 (PT):** added Phase 2B, agent behavior metrics taken from Alex's own complaints, plus the matching render, verification, and green-checklist items. Status unchanged.
**Supersedes:** the rendering-only plan at `/workspace/plans/2026-09-25-agent-cost-report-timing-style.md` (its data basis was `discovery_tokens` and its unit was cents; both are gone). Its mapping tables are reused in Phase 3.
**All times in PT.** All secrets by env var name only. Never read `.env` or settings files for keys.
**Scratch dir for every verification command:** define once per session, `ACR_TMP=${ACR_TMP:-/tmp/acr-weekly}`, then use `$ACR_TMP/p1`, `$ACR_TMP/p2`, … per phase. Phases 3 and 8 read Phase 2 output from `$ACR_TMP/p2`. Nothing under `$ACR_TMP` is committed.

---

## Primary goal

The Claude-Mem plugin skill `agent-cost-report` produces a believable agent cost report for any period, defaulting to the past 7 days in PT. The headline is dollars. The dollars come from Claude Code transcripts (exact per-reply token usage) priced at OpenRouter public list prices, and are labeled ESTIMATED. Measured provider spend appears only when a sanctioned source gives it. The note-taker's own tokens are priced separately and never counted as agent cost. The report looks like the Timing-app mockup: hero number, cost ribbon, five visuals, and a folded Details section.

---

## Settled decisions (do not reopen)

1. **Headline unit is DOLLARS** (settled by Alex via Ori). Hero and totals show dollars to two decimals (`$109.25`). No cents-first display anywhere. Every dollar figure carries its label (measured vs estimated) and its basis, for example "estimated at OpenRouter list prices from measured tokens". This supersedes the cents-under-$1 rule in the earlier plan (`/workspace/plans/2026-09-25-agent-cost-report-timing-style.md:390-408`) and in the brief (`/workspace/timing-report-brief/brief.md:44`).
2. **Default scope = past 7 days in PT**, end exclusive, PT day boundaries. Any period supported: explicit start/end, a single session, or a single project plus a period.

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
- Do not add mirrors yet.
- Do not open any settings file to find device ids or keys.

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
- Default when neither is given: `end` = the next PT midnight after now, `start` = `end − 7 days`. This includes today as a partial day, matching how the research run included Sep 25. The report must show the last day tagged "partial, generated HH:MM PT". (Open decision G3 below can flip this to "last 7 complete days".)
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

---

## Phase 2B — Agent behavior metrics (from Alex's complaints)

**Goal of the session:** add a behavior pass that finds the agent habits Alex has been angry about, counts them, prices what they cost with the same list-price method, and hands the numbers to the renderer. One commit. Runs after Phase 2 (it needs `usage.json`, the `rate()` table, and line items). Everything it produces is labeled **estimated**, and every count is labeled **heuristic** until a review or classifier pass confirms it.

### 2B.0 Why these metrics (Alex's own words)

Alex asked on Sep 25 for "the stuff like hedging, errors, etc." Nobody had the exact list, so it was mined from his words for Sep 20–25, 2026 PT. Only behaviors backed by a quote are here.

Where the words came from: the box has almost no text Alex typed himself in this window. Box Claude Code transcripts hold only agent-written prompts (some relay "from Alex" steers). The claude-mem `user_prompts` table has no Mac rows after Sep 19, 11:51 PM PT. The Grok Bot chat stores on the box stop at Sep 16. So most quotes below are **relayed**: an agent wrote down his lines. The main one is the Prioritizer's user-lines-only transcript of the Sep 21 Cloudflare bleed chat (`/workspace/cf-bleed-narrative/USER-TRANSCRIPT-CF-BLEED-2026-09-21.md`, written 3:31 PM PT, header "USER LINES ONLY… quoted lines are his"; item numbers below). Lines outside Sep 20–25 are listed as "supporting, outside window" and are not counted.

| Behavior | Alex's words (date PT, source) | Rough count Sep 20–25 |
|---|---|---|
| **Asked you instead of doing it** (pushing work back to Alex, fake "human gates") | "There's no fucking human gate. There's never been a human gate..." (Sep 21, item 10, relayed) · "MAKE ME NOT BLEED MONEY AND DONT TALK TO ME UNTIL ITS DONE AND IF YOU NEED MY HELP UOURE DOING IT WRONG" (Sep 21, item 13, relayed) · "I fucking giving you the goddamn token with everything checked off before. I manually fucking checked everything..." (Sep 21, item 5, relayed). Paraphrased locks: Sep 20 "any human gate … ALWAYS escalate to Prioritizer first — do not stall alone" (`agents/6e5cb669…/profile.json`); Sep 22 ~5pm "Never escalate … sign-in walls to Alex when box Chrome already has Google signed in … OpenRouter burn miss" (`ccs/house/NEVER.md`); Sep 23 ~12:41pm "Default = do without Alex" (`ccs/house/HUMAN-GATES-PLAIN-ENGLISH.md`). Supporting, outside window: "who makes up these fucking human gates" (Sep 18 5:27 PM, Mac, `user_prompts` row 3058) | ~10 (7 lines on Sep 21 incl. items 2, 3, 15, 20; 3 locks) |
| **Errors and retries that waste money and time** | "How am I supposed to know how much it's actually going to cost me if you fucking keep doing this shit?" (Sep 21, item 21, relayed) · "You are so fucking stupid that you like to fucking waste my goddamn time..." (Sep 21, item 5, relayed) · "the stuff like hedging, errors, etc." (Sep 25, relayed in the task brief for this plan). Supporting, outside window: the Sep 8 ~9:11 PM expense-report lock says the report's purpose includes "cost of errors" (`user-memory/by-agent/521e962d…/profile.md:55`) | ~3 |
| **Jargon and unclear status** | "Fucking tell me what the fuck chatty means. What the fuck is chatty? Fuck your chatty." (Sep 21, item 8, relayed) · "I have no idea what the fuck you're talking about. Clearly tell me what's blocking you and why." (Sep 21, item 6, relayed). Paraphrased lock: Sep 23 ~12:41pm "Alex only reads the last message … No jargon" (`HUMAN-GATES-PLAIN-ENGLISH.md`) | ~4 (incl. item 1 paraphrase) |
| **Said done without proof** (merged is not deployed, "fixed" without a check) | "Did you fucking fix it with the PRs already? Is it 100% fixed? Can you confirm throughput?" (Sep 21, item 9, relayed) · "You fucking merge to GitHub and it fucking pushes it to fucking..." (Sep 21, item 11, relayed). Supporting, outside window: "did you actually run /learn-codebase the claude-mem skill or did you just like VIBE THAT?" (Sep 18 10:51 PM, Mac, `user_prompts` row 3080) | ~2 |
| **Hedging** | "the stuff like hedging, errors, etc." (Sep 25, relayed in the task brief). Supporting, outside window: "you can search for "subagents" "errors" "hedging" "overconfidence" "mistakes" etc. and everything should be visually on a report that adds up to 100%" (Sep 12 11:39 AM, Mac, `user_prompts` row 2828) · Sep 8 ~9:12 PM lock: "Do NOT get stuck on Max-plan / measured-cash caveats — that obfuscation blocks the job" (`user-memory/by-agent/521e962d…/log/2026-09.md:36`, paraphrased) | 1 (weakest evidence in the window; kept because Alex named it) |
| **Wrong approach** (fixing the wrong side, wrong basis) | "Why is there anything related to Cloudflare running from that repo? … You should be able to handle it from the receiving end not the fucking sending end." (Sep 21, item 14, relayed). Paraphrased: Sep 25 3:53 PM "the data makes it feel dumb. The proof report showed 1.9 cents from just two sessions" (`/workspace/weekly-cost-workflow/NOTION-PAGE.md:5`) | ~2 |

Each metric maps to one of the existing 16 failure types (`SKILL.md:80`), except jargon, which is a communication count and never a `failure_type`. No new failure types.

### 2B.1 Shared machinery: `acr/behavior.py`

- A second pass over the same transcript files and window as the Phase 1 collector. Phase 1 reads only `type == "assistant"` lines with usage; this pass also reads assistant `text` and `tool_use {id, name, input}` blocks and user `tool_result {tool_use_id, is_error, content}` and user text blocks. Field names verified on box transcripts 2026-09-25 (see 2B.7).
- It builds an ordered list of turns per session. A **turn** is one assistant API reply, keyed by the Phase 1 dedup key `(message.id, requestId)`, so every flagged turn already has a priced usage row. A tool_result links to its call through `tool_use_id`.
- "User-facing text" = the last assistant text block before the next user message or session end, with code fences, block quotes, and tool inputs removed.
- Who was on the other side: each session is tagged `alex_direct` (interactive `entrypoint: cli` with no agent-prompt markers), `agent_relayed` (headless `sdk-cli`/`-p`, or prompts starting "You are…", "/do", "/make-plan", "STEER/RESET/CORRECTION from Alex"), or `unknown`. On the box nearly every session is `agent_relayed`. Asks are labeled `asked: Alex` or `asked: agent` from this tag. Relayed agent prompts are never labeled as Alex's words.
- Excerpts: at most 160 characters, run through a secret scrubber (`sk-`, `sk-or-`, `Bearer `, `ghp_`, `gho_`, `xox[abp]-`, `AKIA`, any 32+ char base64/hex run) before they are written anywhere. Excerpts go only to `evidence.json` and Details.
- Output: `behavior.json` in the run dir, merged into `report.json` by `rollup` (see 2B.5).

### 2B.2 How cost and time are counted (same list-price method)

- **Wasted dollars** = sum of `api_equiv()` (Phase 1 `rate()`, integer micro-dollars) over the flagged turns. **Recovery dollars** = the same over the turns the behavior caused until it was resolved. Each metric defines "flagged" and "resolved" below. Both are shown as "≈$X.XX estimated".
- Each reply re-reads its whole context from cache, so a retry costs about as much as the context size, not only the new words. That is real spend at list price and is counted as-is.
- **Time**: wall-clock from the first flagged turn to resolution, summed with the Phase 2 `active_minutes(gap=15)` rule so idle gaps are not billed. **Waiting time** (a person or parent agent had to answer) is shown as hours, never as dollars.
- **No double counting**: one turn can trip more than one metric. Each tile shows its own total and says "overlaps". The ribbon's waste sliver and the line-item `wasted_cost`/`recovery_cost` use the union, so each turn counts once. The union can never exceed `agent_estimated_usd` (tested).
- Line items get `behavior_counts {…}` and their existing `wasted_cost`, `recovery_cost`, `failure_type` fields fill from here.
- Coverage: box transcripts only. Mac sessions show "behavior: unavailable" unless the Phase 5 export carries counts (2B.6). Grok Bot chats are not in any transcript on the box: "unavailable".

### 2B.3 The metrics

**M1 — Errors and retries** → `failure_type`: Recovery after miss (retries), Looping (repeats). Summary tile.
- Error: `tool_result.is_error == true`, or the first 2 KB of the result matches `(?i)^(error|fatal)|traceback \(most recent|exit code [1-9]|command not found|no such file|ENOENT|EACCES|timed out|rate.?limit|\b429\b|\b5\d\d\b`.
- Permission denials (`Permission to use .* has been denied`, harness blocks) are counted separately as "blocked by a rule". They are shown in Details and not priced as agent waste.
- Retry: within the next 5 turns, a tool_use with the same tool name and normalized input similarity ≥ 0.8 (whitespace collapsed, temp paths and numbers masked). The chain ends at the first non-error result or when the agent moves on.
- Loop: the same `(tool name, normalized input hash)` 3 or more times in a session, errors or not.
- Cost: the turn that made the failed call is wasted. The retry turns up to the first success are recovery. A chain that never succeeds is all wasted. Time runs from the first failure to the first success.
- Classifier: not needed (structural). Confidence high for `is_error`, medium for text-matched errors.

**M2 — Asked you instead of doing it** → Unnecessary escalation. Summary tile.
- Candidate: user-facing text that ends with "?" or matches `(?i)would you like me to|do you want me to|want me to|should I\b|shall I\b|let me know if|can you (paste|provide|send|share|click|confirm|approve|log ?in)|please (paste|provide|click|approve|confirm|run)|I need you to|waiting (for|on) (you|your)|blocked on (you|Alex)|needs? Alex|human gate`.
- Flag when a candidate also has one boost: (1) **already answered**: the thing asked for (token, key, URL, link, path, password, approval, yes) or a value of that shape appears in an earlier user message in the same session; (2) **nobody can answer**: headless session (`sdk-cli`/`-p`) that ends on the ask; (3) **annoyed reply**: the next user message matches `(?i)already|I told you|just do it|stop asking|why do I have to|no .{0,20}human gate|fuck|wtf`. A candidate with no boost goes to the classifier or stays "unconfirmed".
- Cost: the asking turn plus up to 2 turns after the reply that rebuild state before new tool work. In a headless session that ends on the ask, every turn after the last successful tool result is wasted. Waiting hours = ask → next user message, or "never answered".

**M3 — Said done without proof** → Premature completion. Summary tile.
- Claim: user-facing text matching `(?i)\b(done|fixed|works now|deployed|shipped|merged|all tests pass(ed)?|verified|100%|confirmed)\b`, skipping negated or future forms (`not done`, `isn't fixed`, `once deployed`, `will be`).
- Proof: since the last user message, a successful tool result after the last Edit/Write whose command or output shows a check: a test runner (`pytest|unittest|vitest|jest|bun test|npm (run )?test|go test|cargo test`) exiting 0 or printing "passed"; `curl` with a 2xx; `gh pr (view|checks)` showing merged or passing; deploy output with a URL or "Deployed"; `git push` success for "pushed".
- Flag a claim with no proof. Special case "merged, not deployed": the claim says deployed or fixed-in-production and the only evidence is `gh pr merge`.
- Cost: the redo, meaning later turns in the same session, or the same project within 48 hours, that edit the same files or re-run the same failing command. The claim turn itself is cheap. Time runs from the claim to the end of the redo. A next user message like `is it (100% )?fixed|did you (actually|fix)|confirm` raises confidence to high.
- Classifier: yes, for fuzzy claims.

**M4 — Hedging** → Hedging. Summary tile.
- Scope: user-facing text only.
- Lexicon: `might|may|could potentially|possibly|perhaps|it seems|it appears|appears to|probably|likely|I think|I believe|not sure|should work|should be (fine|fixed|good|working)|in theory|hopefully|if you want|would you like|depending on`.
- Flag a message when (a) a hedge sits on a status or fact claim (`should be (fixed|deployed|working)`, `probably (works|fixed|deployed)`, `I think it's (done|fixed)`), or (b) density is at least 3 hedges per 100 words and at least 3 hits. Decision G10 picks (a) only, or (a) plus (b).
- Not hedging: the report's own required labels ("estimated", "low confidence", "unavailable", "measured spend unavailable") and stated numeric ranges. The truth rules require honest labels, so they are excluded by an allowlist.
- Cost: the count comes first. Dollars only when the hedge caused a follow-up (next user message matches `(?i)is it|yes or no|did you|confirm|what do you mean|straight answer`). Then the follow-up round trip is priced as recovery. Otherwise the tile says "text only, not priced".
- Classifier: recommended. Keyword hedges have many false positives.

**M5 — Jargon in messages to Alex** → no failure type. Details only.
- User-facing text containing a word from one constant list copied from the cheat sheet in `ccs/house/HUMAN-GATES-PLAIN-ENGLISH.md` plus Alex's own example: drain, projection, projected_seq, head_seq, poll-mode, lag, kill-switch, BYOK, face-wall, chatty, Durable Object, idempotent, backfill, TOCTOU. It counts only when there is no plain-English gloss in the same sentence (a parenthesis, "—", "means", "i.e.", "that is").
- Cost: only the clarification round trip, when the next user message matches `(?i)what (does|is) .{0,30} mean|what the fuck is|no idea what|what are you talking about`.

**M6 — Wrong approach** → Wrong turn, Missed requirement. Details only (the failure table already shows it).
- Extend the Phase 2 `FAIL_RULES` Wrong turn pattern with `wrong (side|end|repo)|receiving end|sending end|why is there .{0,40}(in|from) that repo|not what I (asked|want)|feels? dumb`. Steers and resets stay under Rework as today.
- Cost: turns from the last user message before the wrong work to the correcting message are wasted.

### 2B.4 Optional cheap classifier pass (off by default)

- `acr.py classify-behavior --model anthropic/claude-haiku-4.5 --budget-usd 2.00`. It only sees candidates the heuristics could not settle (M2 without a boost, M3, M4). Input per candidate: the flagged text plus one message before and after, scrubbed, cut to 1,500 characters. Output JSON `{label: yes|no|unsure, metric, reason (≤20 words)}`.
- Model: Claude Haiku 4.5, list $1 in / $5 out per MTok (`out/openrouter_prices.json`). Run path per decision G8: OpenRouter with `OPENROUTER_API_KEY` (only if G5 is a go), or Claude Code headless on the Max plan (`claude -p --model haiku`), still priced at list in the report.
- Expected size: about 200–400 candidates a week × ~1,600 tokens ≈ 0.3–0.6M input + ~0.03M output ≈ $0.45–$0.80 at list. Default cap **$2.00 per run**, a hard stop. It prints an estimate first. If candidates would pass the cap, it classifies a stratified random sample and scales, labeled "estimated from a sample of N".
- The classifier's own spend is shown in Details as "classifier cost (separate)" and never added to agent cost, the same as the note-taker rule.
- Each flag carries `label_source: heuristic | classifier | human`, like 2.4. Items left at `heuristic` render with the "draft" mark.

### 2B.5 Where it goes in the Timing layout (summary stays clean)

- **Behavior strip**, a new row directly under the "How much was useful" ring, with at most 4 tiles: *Errors and retries* · *Asked you instead of doing it* · *Said done without proof* · *Hedging* (decision G9). Each tile shows the count, "≈$X.XX estimated", and hours where they apply (waiting hours for M2), with a small "heuristic" mark until reviewed. A zero tile says "none found" and is never hidden. A tile whose Phase 8 spot-check precision is under 70% moves to Details marked "low confidence".
- **Cost ribbon**: the existing striped waste sliver (Phase 3, from `wasted_cost`) now includes behavior waste, counted once per turn. Recovery is not in the waste sliver.
- **Worth your attention**: at most 1 of the ≤3 cards is a behavior card, picked by the largest behavior dollars, built only from computed fields, for example "Failed commands and their retries cost ≈$X.XX (estimated), most in <session title>."
- **Details**: the full behavior table (all six metrics, per session and per model), up to 10 scrubbed example excerpts per metric, permission denials as their own line, label-source counts, classifier cost, and coverage (box measured; Mac and Grok Bot unavailable).
- No excerpts, session ids, or regexes in the summary.
- `report.json` gets `behavior: {metrics: [{key, name, failure_type, count, count_basis: heuristic|classifier|sample, wasted_usd, recovery_usd, active_minutes, waiting_minutes, confidence, overlaps: true, examples: [{content_session_id, ts_pt, excerpt, label_source}]}], union_wasted_usd, union_recovery_usd, coverage: {box, mac, grok_bot}, classifier: {ran, model, spend_usd, cap_usd, sampled_n}, permission_denials}`.

### 2B.6 Mac export (ties to Phase 5)

`acr.py collect --export-device mac` may also write per-session behavior counts and priced turn totals for the six metrics. No text, no excerpts, no prompts, which keeps the Phase 5 export rule. Without it, Mac behavior stays "unavailable". The same "needs Alex's explicit go" gate applies.

### 2B.7 Facts this phase relies on (planner probe, read-only, 2026-09-25)

- Box transcripts carry `tool_use {type, id, name, input}` on assistant lines and `tool_result {type, content, is_error, tool_use_id}` on user lines. A sampled `is_error: true` result was a harness permission denial ("Permission to use Bash with command curl … has been denied."), which is why M1 separates denials.
- Over the 78 box transcript files touched Sep 18–26 PT: 1,631 tool calls, 1,584 tool results, 54 with `is_error: true`, 375 assistant text blocks, 18 with at least one hedge word (raw, unthresholded), 0 identical tool calls repeated 3 or more times in a session. These are sanity ranges for Phase 8, not targets.
- Sessions on the box with `entrypoint: sdk-cli` exist alongside `cli`. Both show agent-written prompts in the window.

### 2B.8 Verification checklist

```bash
ACR_TMP=${ACR_TMP:-/tmp/acr-weekly}; mkdir -p $ACR_TMP/p2b
cd plugin/skills/agent-cost-report
OUT=$ACR_TMP/p2b
python3 scripts/acr.py collect --start 2026-09-18 --end 2026-09-26 --out $OUT && python3 scripts/acr.py rollup --start 2026-09-18 --end 2026-09-26 --out $OUT --prices /workspace/weekly-cost-workflow/out/openrouter_prices.json
python3 - <<PY
import json;d=json.load(open('$ACR_TMP/p2b/report.json'));b=d['behavior'];s=d['spend']
for m in b['metrics']: print(m['key'],m['count'],m['wasted_usd'],m['recovery_usd'],m['count_basis'])
assert b['union_wasted_usd']+b['union_recovery_usd'] <= s['agent_estimated_usd']
assert {m['failure_type'] for m in b['metrics'] if m['failure_type']} <= {'Looping','Hedging','Wrong turn','Rework','Regression','Premature completion','Unauthorized action','Suboptimal path','Duplicate work','Blocked work','Missed requirement','Unnecessary escalation','Context re-read','Model thrash','Fan-out waste','Recovery after miss'}
assert b['coverage']['mac']=='unavailable' and b['coverage']['grok_bot']=='unavailable'
PY
# expect M1 errors near 54 minus permission denials (2B.7); loops near 0
grep -rn 'sk-or-\|Bearer \|ghp_' $OUT/behavior.json $OUT/evidence.json && echo FAIL || echo ok
python3 -m unittest discover -s scripts/tests -v
```

Unit tests (tiny hand-made jsonl fixtures): an `is_error` call followed by a similar retry that succeeds (1 wasted + 1 recovery turn); a permission denial not priced; the same call three times gives Looping; a headless session ending "Would you like me to…?" is flagged; "fixed" with a passing `pytest` is not flagged, without it is; "merged" plus a deploy claim with only `gh pr merge` is flagged; hedge density threshold; "estimated" and "low confidence" not counted as hedges; the union never exceeds agent cost; a fixture containing `sk-or-abc…` leaves no trace in outputs; the classifier stops at the cap (mocked).

### 2B.9 Anti-pattern guards

- Do not invent failure types. Map to the 16 or leave `failure_type` empty (jargon).
- Do not price hedged or jargon text itself as waste. Price only the follow-up it caused.
- Do not count permission denials or harness blocks as agent mistakes.
- Do not show excerpts, regexes, or session ids in the summary. Details only, scrubbed.
- Do not run the classifier without a cap, or through OpenRouter without G5.
- Do not call a relayed agent prompt "Alex said". Use `asked: agent` unless the text is marked from Alex or the session is `alex_direct`.
- Do not read Grok Bot chats or Mac files to fill gaps. Show "unavailable".

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
- Day chart: column count and viewBox width computed from `by_day` length (7, 8, 1, or 30 days all render). Empty days show "no agent work". Partial last day shows "partial".
- Ribbon: clamp block width to ≥ 0; stripe pattern per kind; waste sliver from `wasted_cost`.
- `STAT` map covers all five statuses. `max()` guarded for empty lists. `failure_economics` may be empty.
- Date pill from `window` ("Sep 18 – 25, 2026 (PT)"). Sessions list from `line_items` (top N by cost, "+K more" folded). Model list from `by_model` with price basis.
- Story sentence assembled from data fields only; the useful-share number is computed by the renderer (`plan:150`). No hand-written prose.
- Ring color bands: ≥ 90 % green, 70–90 % amber, < 70 % red.
- Attention list from `report.json.attention`. Draft labels marked.
- Behavior strip under the ring from `report.json.behavior` (Phase 2B.5): at most 4 tiles, each with count, "≈$X.XX estimated", hours, and a "heuristic" mark until reviewed; zero shows "none found". At most one behavior card in Worth your attention. The other metrics, excerpts, and permission denials go in Details.

### 3.4 Details section (folded `<details>`)

Holds: evidence IDs and short titles per line item; session IDs (`content_session_id`, `memory_session_id`); tokens by type per line item and per model; model and price per MTok with the 1h rule used; pricing source and fetch time; confidence; risk exposure; full failure accounting table; observer (note-taker) cost line; device table with short hashes; unmatched transcripts; unpriced models; label review counts; the behavior table and scrubbed examples (Phase 2B.5); a link to `line-items.csv` and `evidence.json` by relative path. Print CSS opens `<details>` for the PDF via a `--print` flag, not a CSS hack (`plan:152`).

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

**Needs Alex's explicit go:** providing `OPENROUTER_API_KEY` to a report run. The key is supplied as an environment variable through the house's secure secret request flow (mechanism UNVERIFIABLE, see Phase 0). The script never reads a settings file, never prints the key, never writes it to any output, and never calls the endpoint when the variable is unset.

### 4.1 What the endpoint gives (Phase 0 E)

`GET https://openrouter.ai/api/v1/key` with `Authorization: Bearer $OPENROUTER_API_KEY` returns `data.usage` (lifetime), `usage_daily` (current UTC day), `usage_weekly` (current UTC week Monday–Sunday), `usage_monthly` (current UTC month), `limit`, `limit_remaining`, `is_free_tier`. These are snapshots of the current calendar buckets in UTC, not a range query.

### 4.2 What to implement

- `acr.py measure-openrouter --out <dir>`: if `OPENROUTER_API_KEY` is unset, write `measured.json = {status: "unavailable", reason: "OPENROUTER_API_KEY not provided"}` and exit 0. If set, call the endpoint once, store `{status: "ok", fetched_at_utc, fetched_at_pt, usage_daily, usage_weekly, usage_monthly, usage_lifetime, key_hint: null}` and nothing else. No key material in outputs. Errors → `status: "error"` with the HTTP status only.
- Reconciliation rule, because the buckets are UTC calendar and the report window is PT: the measured figure is shown only as `usage_weekly` or `usage_monthly` **with its own bucket label** ("OpenRouter measured, current UTC week Mon 21 Sep – now"). It is never re-cut to the PT window. If the report window is not fully inside one bucket, the render says "measured bucket does not match the report window; shown for reference".
- Per-session measured cost is not available from this endpoint. Line items keep `cost_basis: estimated_usage`. Only the `spend.agent_measured_usd` total and `measured_status: "ok (period bucket)"` change. The hero switches to MEASURED only when the bucket fully covers the window (`bucket_start_utc <= window_start_utc and now >= window_end_utc`); otherwise the hero stays ESTIMATED and the measured figure sits beside it.
- Sanctioned range source for later: `GET /api/v1/activity?date=` gives per-day per-model USD for the last 30 days, but needs a management/provisioning key, not the inference key. Document this in SKILL.md as the upgrade path and stop there. Do not implement it in this phase. (Open question O2.)
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

**Needs Alex's explicit go:** running anything on Alex's Mac, and copying any file off it. Two sanctioned ways exist. (a) Alex runs the export and shares the file. (b) An orchestrating agent runs `acr.py collect --export-device mac` on Alex's registered Mac through the house's registered-machine tooling and copies the small export file to the box. Way (b) happens only after Alex's explicit go for that specific run (window, machine, destination path named). A go for one run is not a go for the next.

### 5.1 Facts that shape this

- Transcripts never leave the machine (Phase 0 C: cloud sync replicates DB rows, not `.jsonl`).
- The box DB has the Mac's observations and summaries as replica rows keyed by `memory_session_id`, but `sdk_sessions` rows do not sync, so the box has no `content_session_id` for Mac sessions. The join to transcripts must happen on the Mac, where its own local `claude-mem.db` has both ids.
- Claude Code deletes transcripts after 30 days by default (`cleanupPeriodDays`). The Sep 18–25 Mac transcripts exist until about Oct 18 unless the Mac's setting differs (UNVERIFIABLE).

### 5.2 What to implement

- `acr.py collect --export-device <label>`: on any machine, runs Phase 1's collector against that machine's `~/.claude/projects`, takes a read-only snapshot of that machine's local `claude-mem.db`, and writes `device-usage-<label>.json` containing the usage rows plus the local `sdk_sessions` map `{memory_session_id → content_session_id, project, started_at_epoch}` for the window. No observation text, no prompts, no secrets. Only ids, timestamps, token counts, model names.
- `acr.py rollup --device-usage <file>...`: merges exported files. Rows join to box-side replica sessions on `memory_session_id`; those sessions flip from `cost_basis: extrapolated` to `estimated_usage` with `device: <label>`. The extrapolation is recomputed for whatever remains unmeasured and stays labeled low confidence.
- The skill's scripts directory must be runnable from a plain checkout on the Mac with system `python3` (3.9+ has `zoneinfo`). Document the command Alex would run, and that the output file is small and safe to copy.
- SKILL.md documents both paths: "Ask Alex to run `python3 scripts/acr.py collect --export-device mac --start ... --end ...` on the Mac and share the file. Or, only after Alex's explicit go for this specific run, run the same command on the registered Mac through the house's registered-machine tooling and copy only `device-usage-mac.json` to the box." The export rule holds on either path: no prompt text, no observation text, no settings.
- The export may also carry per-session behavior counts and priced turn totals for the Phase 2B metrics (numbers only, no excerpts). Without them, Mac behavior shows "unavailable".

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
- Render: a sidebar row and a Details line "Grok Bot usage: unavailable (Cursor exposes seat usage only on the plan screen)". No dollar figure. No seat count unless Alex provides one (open decision G4), in which case it renders as "N seats · usage unavailable".
- SKILL.md: a short "Grok Bot" paragraph stating this, and that if Alex supplies a screenshot or manual figure it is entered as `measured_manual` with `entered_by: Alex` and the date, never inferred.

### 6.3 Verification checklist

```bash
grep -c 'Grok Bot usage: unavailable' <report.html>     # expect 1
grep -c 'grok' <line-items.csv> | true                   # no Grok line items with dollars
python3 -c "import json;d=json.load(open('<report.json>'));assert d['spend']['grok_bot_usage']['status']=='unavailable'"
```

### 6.4 Anti-pattern guards

- Never $0.00 for Grok Bot. Never a guessed per-seat price from third-party sites.
- Do not add an xAI API call; the house has no xAI key for this.

---

## Phase 7 — Skill rewrite and house sync

**Goal of the session:** SKILL.md reflects the new pipeline and keeps every ALWAYS rule; plugin copy, house copy, and mirrors are kept in sync by copy + checksum. One commit.

### 7.1 SKILL.md rewrite (copy structure from the current file, change content)

Keep verbatim: Purpose (`:14-18`), Questions (`:24-32`), Progressive Mem Search (`:49-72`), Work categories (`:74-76`), Failure types and Rework lock (`:78-84`), Money labeling table (`:119-128`), Truthfulness ALWAYS rules (`:184-195`), Creed (`:213-215`).

Replace:
- Frontmatter `description`: "Believable agent cost report for any period, default past 7 days PT. Measured tokens from Claude Code transcripts priced at OpenRouter list prices (ESTIMATED), measured provider spend when a sanctioned source exists, note-taker cost separate, Timing-style HTML/PDF plus report.json, line-items.csv, evidence.json." Add `allowed-tools: [Bash, Read, Write, AskUserQuestion]` in the list form of `plugin/skills/cloud-sync/SKILL.md:4-7` (and the MCP search tools the mem-search flow needs).
- Default scope (`:42-47`): past 7 days PT, end exclusive; `--session`; `--project` + period.
- Cost model (`:86-117`): the Phase 1/2 formulas. Delete the `discovery_tokens × input` line and the PRICE-TABLE path (`:117`). Add the observer line "priced separately, never agent cost".
- Deliverables (`:161-182`): the Timing-style section order from `brief.md:33-42`, dollars to two decimals with labels, Details section contents.
- Recipe (`:197-204`): the exact commands, in order: `prices` → `collect` → `rollup` → review (mem-search confirm pass, `review --apply`) → `render` → `pdf` → optional `measure-openrouter` (needs Alex's go) → optional `--device-usage` merge (needs Alex's go).
- Add "Gaps and gates": OpenRouter key, Mac export, Grok Bot, each marked "needs Alex's explicit go".
- Remove house-only links that do not resolve outside this box (`sand-workflow:*` at `:40,51`) or keep them only in the house copy (open decision G2).

### 7.2 Sync: copy + checksum

- Add `scripts/acr.py sync-check [--write]` that compares `sha256sum` of `SKILL.md` and every file under `scripts/` across: plugin dir (source of truth), `/home/box/agent-data/workflows/agent-cost-report/`, and the four mirrors `/workspace/claude-mem/{claude-mem-cursor,claude-mem-grok-bot,cowork,openclaw}/skills/agent-cost-report/`. Without `--write` it reports drift and exits 1. With `--write` it copies plugin → others and re-checks. Destinations are a list in one place, overridable by `--dest`.
- The house copy path is outside the repo; the mirrors in the repo are only written if decision G2 says the mirrors ship (today the mirror `mem-search` files are host-adapted, but the six `agent-cost-report` copies are byte-identical, so byte-copy is the current truth).
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
python3 scripts/acr.py sync-check --write  # only for destinations decision G2 allows; house copy always
sha256sum -c CHECKSUMS.txt
md5sum SKILL.md /home/box/agent-data/workflows/agent-cost-report/SKILL.md
```

### 7.4 Anti-pattern guards

- Do not drop or reword the eight truth rules.
- Do not put CSS or code in SKILL.md; point to `scripts/`.
- Do not write into mirrors that decision G2 excludes.
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
python3 scripts/acr.py rollup --out $OUT/default && python3 -c "import json;w=json.load(open('$OUT/default/report.json'))['window'];print(w)"   # default = past 7 days PT, end exclusive
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

- For each summary metric, hand-check 20 flagged turns (or all of them if fewer) in `behavior-spotcheck.md`. Mark each true, false, or unsure against the transcript line it cites. Record precision per metric in `VERIFICATION.md`. A metric needs at least 70% precision to stay in the summary strip. Below that it moves to Details as "low confidence".
- Hand-check 10 random unflagged sessions for obvious misses (for example, a failed command followed by a retry that M1 did not catch) and write down what was missed.
- M1 error count within ±10% of the 2B.7 probe (54 `is_error` results, minus permission denials) for Sep 18–26, or a written reason.
- `union_wasted_usd + union_recovery_usd <= agent_estimated_usd`; every behavior dollar in the HTML has an ESTIMATE tag; the strip has at most 4 tiles; no secrets in `behavior.json`, `evidence.json`, or the HTML (8.3 grep covers the directory).
- If the classifier ran (G8), its spend is at or under the cap and appears only as "classifier cost (separate)".

---

## What ships

- **PR:** from `work/cost-report-weekly` to `main` on `thedotmack/claude-mem`, opened as a draft after Phase 8, titled "feat(skills): agent-cost-report rebuilt on transcript-measured tokens, Timing-style, dollars". Opening the PR: routine. **Merging: needs Alex's explicit go** (house loop: PR → babysit → merge only if Alex's green covers it → version-bump).
- **Babysit:** `/claude-mem:babysit` on the PR until CI and review comments are clear.
- **Version bump:** a new bundled skill with scripts is a MINOR bump by the house precedent (`plans/2026-09-16-grok-bot-live-index.md`, Phase 4). **Needs Alex's explicit go.** npm publish stays a human step (`plugin/skills/version-bump/SKILL.md` description).
- **Publishing consequence to decide first (G1):** `sync-marketplace.cjs` already installs the untracked dir locally, and `package.json` `files` includes `plugin/skills`, so merging makes this skill part of the public plugin and the npm package. If Alex wants it house-only, Phase 0 still tracks it on this branch, but the PR target changes (see G1).
- **Gated steps, each "needs Alex's explicit go":** providing `OPENROUTER_API_KEY` (Phase 4); running the collector on the registered Mac and copying the export, per run (Phase 5); any manual Grok Bot figure (Phase 6); running the behavior classifier and its spend cap (Phase 2B, G8); writing into mirror plugin dirs (Phase 7, G2); merge; version-bump; publish.

---

## Green checklist (decisions only Alex can make)

- **G1 — Public or house-only?** Merge to `main` ships the skill and its Python scripts in the public plugin and npm package. Default if unanswered: open the PR as draft and stop before merge.
- **G2 — Mirrors.** Should `claude-mem-cursor`, `claude-mem-grok-bot`, `cowork`, `openclaw` carry `agent-cost-report` (byte copies, tracked in git), or only the plugin dir plus the house copy? Default: plugin + house copy only; mirrors untouched until answered.
- **G3 — Default window edge.** "Past 7 days" including today as a partial day (default in this plan, matches the research run), or the last 7 complete days ending yesterday?
- **G4 — Grok Bot seats.** Do you want a seat count shown next to "usage unavailable"? If yes, what is the number and where does it come from (plan screen)?
- **G5 — OpenRouter key.** Go / no-go on providing `OPENROUTER_API_KEY` as an env var for report runs, and whether a management/provisioning key for `/api/v1/activity` is something you want at all.
- **G6 — Mac export.** Go / no-go on running `acr.py collect --export-device mac` on your Mac for Sep 18–26 before the transcripts age out (about Oct 18 at the 30-day default).
- **G7 — Version bump size.** MINOR (proposed) or PATCH.
- **G8 — Behavior classifier.** On or off (default off, heuristics only). If on: model (proposed Claude Haiku 4.5, list $1 in / $5 out per MTok), path (OpenRouter key per G5, or Claude Code headless on the Max plan), and the per-run spend cap (proposed $2.00, hard stop; expected ≈$0.45–$0.80 a week).
- **G9 — Behavior tiles up top.** Are these the 4 numbers in the summary: Errors and retries, Asked you instead of doing it, Said done without proof, Hedging? Jargon and Wrong approach stay in Details.
- **G10 — What counts as hedging.** Only hedges on a status or fact claim ("should be fixed", "probably deployed"), which is proposed, or also any message dense with hedge words?

## Risks

- **Transcript retention.** Box and Mac transcripts vanish after 30 days by default. The Sep 18–26 verification must run before mid-October or the measured-token comparison loses data.
- **Untracked dir already installed.** The current buggy SKILL.md (prices `discovery_tokens`) is live in the marketplace copy on this box via `sync-marketplace.cjs`. Until Phase 7 lands and `build-and-sync` runs, any use of the skill produces the 1.9-cent style answer.
- **Per-key measured totals mislead if mislabeled.** UTC calendar buckets versus PT windows, and note-taker calls sharing the key. Phase 4's bucket-label rule is the guard.
- **Keyword labels in a manager report.** Without the review pass, categories are guesses. Phase 2's `label_source` and the footer count make the state visible; they do not make the labels right.
- **Remote sessions cannot join transcripts on the box.** Only the Mac-side export fixes this; extrapolation stays low confidence until then.
- **Price drift.** List prices change; the report states the fetch date and the 1h rule used, and the comparison run pins the saved price file.
- **Behavior heuristics are noisy.** Keyword and structure rules will flag some honest turns and miss some bad ones. Counts stay labeled heuristic, and Phase 8 precision gates what reaches the summary.
- **Alex's words behind the metrics are mostly relayed.** In Sep 20–25 the box holds no text he typed himself; the quotes come from agent-kept transcripts and locks (Phase 2B.0). Behaviors may be missing if they only came up in Grok Bot chats or on the Mac.
- **`${CLAUDE_SKILL_DIR}` may not exist.** SKILL.md gives the "resolve this file's directory" instruction first.

## Open questions

- **O1 — Session count basis.** Research counted 80; the live probe counted 81 `sdk_sessions` (one codex). Which is the manager-facing number: all sessions, or Claude-only? Phase 2 counts all and shows platform in Details; confirm.
- **O2 — Activity endpoint.** If a management key is acceptable (G5), per-day per-model measured USD for the last 30 days becomes possible, which could replace the estimate for the box. Out of scope until answered.
- **O3 — House copy of SKILL.md with `sand-workflow:*` links.** Keep those links only in the house copy, or drop them everywhere?
- **O5 — Grok Bot chats as a source.** Most of Alex's complaints happen in Grok Bot chats, which no box transcript or claude-mem table holds for Sep 20–25 (box chat stores stop at Sep 16). Is there a sanctioned export we should read for behavior metrics, or do they stay "unavailable"?
- **O4 — Where do report outputs go by default?** The current skill writes to a workspace path (`SKILL.md:163`). Proposed default: `~/.claude-mem/reports/agent-cost-report/<start>_<end>/`. Confirm or name another.
