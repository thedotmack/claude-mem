---
name: Agent Cost Report
description: >-
  Believable agent cost report for any period, default the last 7 full days PT, not counting today.
  Measured tokens from Claude Code transcripts priced at OpenRouter list prices (ESTIMATED), measured
  provider spend when a sanctioned source exists, note-taker cost separate, Timing-style HTML/PDF plus
  report.json, line-items.csv, evidence.json.
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
  - mcp__plugin_claude-mem_mcp-search__search
  - mcp__plugin_claude-mem_mcp-search__timeline
  - mcp__plugin_claude-mem_mcp-search__get_observations
---

# Agent Cost Report

**Claude-Mem / Claude Code skill.** Runtime is the `scripts/` pipeline (transcripts → tokens → dollars → Timing-style report) plus a progressive Mem Search review pass that confirms the drafted labels. The Notion draft is SPEC history only — never the product, never the runtime, never the ship vehicle.

Resolve the absolute directory containing this `SKILL.md`; all helper paths are relative to that directory. `${CLAUDE_SKILL_DIR}` is the shortcut: `python3 "${CLAUDE_SKILL_DIR}/scripts/acr.py" …`. Python 3.9+ standard library only; no pip installs. The look lives in `scripts/acr/render.py`, never here.

## Purpose

Turn Claude-Mem activity into a **manager-readable cost and failure report**.

Product idea: a reusable skill that searches Claude-Mem via Mem Search, reconstructs real units of work, assigns cost and failure categories, and renders a printable report.

## Insight north star

The headline is dollars, to two decimals, labeled. The dollars come from Claude Code transcripts (exact per-reply token usage) priced at OpenRouter public list prices, so they are **ESTIMATED**. Measured provider spend appears only when a sanctioned source gives it. Directly under the dollars: what the mistakes cost, what shipped, and both on one time axis.

## Questions the report must answer

1. What work was completed?
2. What did each outcome cost?
3. What was wasted through looping, hedging, wrong turns, rework, or poor routing?
4. Were any unauthorized actions attempted?
5. What should the manager change next?

**Primary unit = cost per completed outcome** (not cost per observation).

## When to use

- "Agent cost report" / "cost per outcome" / "failure economics" / "was this session worth it" / "what did the agents cost this week"
- After a real Mem session dig when leadership needs outcome economics
- Sample / ship packs that need self-contained HTML + JSON + CSV + evidence

Memory dig mechanics: the claude-mem `mem-search` skill (progressive recall).

## Default scope (ALWAYS)

- Unless the user names a **specific session / range / project**, the window is the **last 7 full days in PT, not counting today**: `end` = the PT midnight that started today (exclusive), `start` = `end − 7 days`. The default window never contains a partial day (G3, Alex 2026-09-25).
- Explicit windows: `--start YYYY-MM-DD --end YYYY-MM-DD` (PT calendar days, end exclusive). An explicit `--end` later than today marks the last day "partial, generated HH:MM PT".
- One session: `--session <content_session_id>`. One project plus a period: `--project <name> --start … --end …` (worktrees of the project are included).
- The report **Scope** strip shows the PT range, and Details list every session id in scope.

## Progressive Mem Search (ALWAYS)

Follow the claude-mem `mem-search` three layers. Keep spend light.

1. **Search** — get an index of IDs (titles, types, token hints).
2. **Timeline** — only around anchors you care about.
3. **Observations** — `get_observations` for the filtered IDs you will cite as evidence.

Recipe:

1. Resolve scope (default: the last 7 full PT days).
2. Search → collect IDs.
3. Timeline for thin context only.
4. Observations for intended / actual / outcome / waste / rework / blocked / unauthorized / status.
5. Group into named work items + failure events.
6. Calculate line-item costs.
7. Render HTML + optional PDF (+ json/csv/evidence).
8. Keep evidence IDs in the appendix — do not dump entire timelines into the main report.

ADHD process bullets:

- Search first → pick IDs → timeline only if context is thin → fetch only needed obs.
- Work-item titles are invented for managers ("Restore search after Chroma crash-loop"); observation titles stay evidence-only.
- Evidence appendix lists obs IDs + short titles; main sections stay outcome-first.

In this skill the search pass is the **review step** (see Recipe step 4): the pipeline drafts categories and failure types from keywords (`label_source: keyword`); the orchestrator confirms or changes each line item's `category` and `failure_type` from its cited evidence IDs and applies the result with `review --apply`. Items left unreviewed keep the "draft label" mark and the footer counts them.

## Work categories (ALWAYS)

`Feature` · `Bug fix` · `Incident` · `Maintenance` · `Investigation` · `Experiment`

## Failure / waste types (ALWAYS)

`Looping` · `Hedging` · `Wrong turn` · `Rework` · `Regression` · `Premature completion` · `Unauthorized action` · `Suboptimal path` · `Duplicate work` · `Blocked work` · `Missed requirement` · `Unnecessary escalation` · `Context re-read` · `Model thrash` · `Fan-out waste` · `Recovery after miss`

**Rework lock (ALWAYS):** Rework lives **only** under `failure_type` — never as a work category. Keep category as the intended job type; set `failure_type: Rework` when rework occurred.

A line item can have a work category **and** a failure_type (e.g. Maintenance + Looping).

## Cost model

Measured tokens come from Claude Code transcripts (`~/.claude/projects/**/*.jsonl`, assistant replies deduped on `(message.id, requestId)`); Codex transcripts are read the same way. Prices are OpenRouter public list prices per million tokens, fetched at run time and saved with the report.

```
agent_cost_i (per reply, micro-dollars) =
      input × price.input + output × price.output
    + cache_write_5m × price.cache_write + cache_write_1h × price.cache_write_1h
    + cache_read × price.cache_read                    # cache_write_1h = listed rate, else 2 × input

agent_estimated_usd        = Σ agent_cost_i over every reply in the window (matched or not)   # ESTIMATED, the headline
extrapolated_unmeasured    = observer tokens of sessions with no transcript here × (measured $ per observer token)
                           # EXTRAPOLATED (low confidence); "all sessions measured" when nothing remains
observer_note_taker_est    = note-taker (observer) tokens, deduped per reply, × its input list price
                           # priced separately, never agent cost, never in the headline
mistakes_estimated_usd     = Σ agent_cost_i over the same-session union of wasted turns, each turn once   # low figure
cost_per_completed_outcome = Σ attributed $ for status ∈ {shipped, completed} / count(those work items)
waste_rate                 = Σ wasted_cost / Σ attributed $     recovery_share = Σ recovery_cost / Σ attributed $
```

Line items are sessions: `attributed_usd` = estimated (transcript on this box) or extrapolated (no transcript). `wasted_cost` and `recovery_cost` come from the behavior pass (below), one union set for the ribbon, the line items and the mistakes line. The upper bound (redo windows plus project-wide fallback) stays in Details.

**Unauthorized blocked:** `direct_cost` $0, `risk_exposure` high, `action_status` blocked. Always keep risk_exposure non-dollar unless real cash/remediation is at stake — never invent risk dollars.

`confidence` — `high` when tokens + model + outcome are clear; `medium` when allocation across obs is judgmental; `low` when evidence is thin.

Unpriced models (not in the price list, or a negative "variable" price) are listed by name with their tokens and add nothing; they are never priced at zero silently.

## Behavior metrics (heuristic until reviewed)

A second pass over the same transcripts tags every user turn human / bot / unknown (relayed agent prompts are never Alex's words), finds frustration episodes, and runs the pattern detectors from the Frustration Arc study: invented human gates, broke working things, wrong or expensive model, over-engineering, did something not asked, fake output, false "done", wrong tool or contact, bad outbound (incidents × recipients, never dollars), memory or rule loss, jargon, unclear cause, plus tool errors and hedging (Alex's definition: a caveat given when the answer was already available). Four summary tiles; everything else in Details. Every count is labeled `heuristic` until reviewed or classified. The optional classifier (`--classify`) is off by default, capped at $2.00 per run, uses only a regular inference `OPENROUTER_API_KEY`, and its spend is shown separately.

## Money labeling (ALWAYS)

| Label | Meaning |
|-------|---------|
| **Measured** | Provider-reported spend from a sanctioned source (today: the OpenRouter per-key snapshot, shown with its UTC bucket label) |
| **Estimated** | Measured transcript tokens × OpenRouter list price per MTok (the formula above) |
| **Extrapolated** | Sessions with no transcript on this machine, from the observer-token ratio; always "low confidence" |
| **Unavailable** | No measured value — write `measured spend unavailable`, never `$0 spent` for unknown |
| **risk_exposure** | Severity / qualitative unless real cash is at stake (seats, refunds, SLA) |

`cost_basis` on each line item: `estimated_usage`, `measured_provider`, or `extrapolated`. Dollars are shown to two decimals everywhere (`$109.25`); every figure carries its label and basis.

## Line-item schema

Each row in `line-items.csv` / `report.json.line_items`:

| Field | Notes |
|-------|-------|
| `work_item_id` | Stable id (`WI-1` …) |
| `title` | Human work-item title (ALWAYS invent at review; drafts use the session's first prompt) |
| `scope` / `project` / `worktree` | Period, session or project; primary project; worktree when relevant |
| `session_ids` / `content_session_id` | Mem session id(s) and the transcript join key |
| `status` | `shipped` / `completed` / `in_progress` / `abandoned` / `blocked` |
| `category` / `work_category` | One of the six work categories |
| `failure_type` / `failure_signals` | Empty or failure types (Rework lives here) |
| `cost_measured` | Number or `unavailable` |
| `cost_estimated` / `cost_extrapolated` / `attributed_usd` | List-price estimate; extrapolation for sessions with no transcript; the one used |
| `wasted_cost` / `recovery_cost` / `productive_cost` | USD from the behavior union (0 if none) |
| `risk_exposure` | `none` / `low` / `medium` / `high` (non-dollar unless real cash) |
| `evidence_ids` / `summary_ids` | Observation and summary IDs |
| `agent_tokens` | `{input, output, cache_write_5m, cache_write_1h, cache_read}` |
| `observer_tokens` | Note-taker tokens, Details only |
| `model` / `model_prices_usd_per_mtok` | Dominant model and the prices used |
| `cost_basis` | `estimated_usage` / `measured_provider` / `extrapolated` |
| `label_source` | `keyword` (draft) / `llm` / `human`, with `reviewed_by` and `reviewed_at_pt` |
| `device` | `local`, `remote-N`, or an export label such as `mac` |
| `behavior_counts` | Pattern hits in this session |
| `recommended_action` / `confidence` / `date_pt` / `notes` | One lever; high/medium/low; PT day; one plain sentence |

## Deliverables (ALWAYS)

`acr.py` writes one directory containing:

1. **`report.html`** — self-contained (inline CSS, no script, no external resources), Timing-style
2. **`report.pdf`** — from `report.print.html` with headless `google-chrome`; when Chrome is missing the run says "PDF skipped, HTML is canonical"
3. **`report.json`** — window, scope, spend, totals, by_day, by_model, by_device, line_items, wins, behavior, timeline
4. **`line-items.csv`** — one row per work item
5. **`evidence.json`** — observation IDs cited, short titles, observer tokens, model, session ids
6. **`labels.review.json`** — the drafted labels for the review pass

### Manager-facing HTML sections (required order)

1. **Hero** — dollars with its tag (ESTIMATE / MEASURED), the basis sentence, "N things finished, about $X each", the extrapolated line, "Measured provider spend: unavailable" when it is, and the story sentence (computed, never hand-written)
2. **Wins vs mistakes** — the cost-of-mistakes line (low figure), wins shipped (merged PRs, published versions, praise; cost "unmeasured" until sessions are linked to PRs), and two timelines on one PT-day axis
3. **Cost ribbon** — every piece of work as a block sized by cost, waste hatched, in-progress striped
4. **Where the money went** (donut by kind of work) · **Day by day** (stacked bars, empty days say "no agent work") · **How much was useful** (the ring, the behavior strip with at most four tiles)
5. **What got done** — one folded row per work item, most expensive first, draft labels marked
6. **Worth your attention** — at most three, computed
7. **Details & evidence** (folded; open in the PDF) — wins, mistakes by day, behavior pattern table with the upper bound, rule effectiveness, spend and pricing, models, failure accounting, line items, devices, unmatched transcripts, unpriced models, label counts, the honesty rules, links to the CSV and JSON

## Truthfulness ALWAYS rules

Positive truth rules only:

1. Always label estimate vs measured (`cost_basis` = `estimated_usage` or `measured_provider`).
2. Always say **measured spend unavailable** when unmatched — never "$0 spent" for unknown.
3. Always use **completed outcomes** as the unit (cost per completed outcome).
4. Always keep `risk_exposure` non-dollar unless real cash/remediation is at stake.
5. Always invent human work-item titles; observation titles are evidence-only.
6. Always progressive Mem Search; evidence IDs live in the appendix.
7. Always put Rework under `failure_type` only.
8. Always default scope to most recent sessions unless the user names another.

Added by the rebuild, same spirit: the note-taker's cost is separate and never in the headline; keyword labels are drafts until reviewed; Grok Bot and Mac figures are "unavailable" or "extrapolated (low confidence)", never $0 and never guessed; the live database is only ever opened read-only (every run works on a snapshot).

## Recipe (orchestrator)

All commands from the skill directory; `OUT` is one run directory (for example `/tmp/acr-weekly/run`). Every step is idempotent.

1. **Prices** — `python3 scripts/acr.py prices --out $OUT` (OpenRouter list prices; `--prices <saved prices.json>` to run offline; no key needed).
2. **Collect** — `python3 scripts/acr.py collect --out $OUT` (default window) or `… --start YYYY-MM-DD --end YYYY-MM-DD`, `… --session <id>`, `… --project <name> --start … --end …`.
3. **Rollup** — `python3 scripts/acr.py rollup --out $OUT` with the same period flags. Writes report.json, line-items.csv, evidence.json, labels.review.json. Options: `--no-gh` (skip the read-only `gh pr view` confirmation of merged PRs), `--classify` (see above), `--rules-dir <house rules>` (rule effectiveness).
4. **Review** — for each line item in `labels.review.json`, `get_observations` on its `evidence_ids` (not whole timelines), confirm or change `category`, `failure_type`, `status`, and the title; write the reviewed file with `reviewed_by` (model id or `Alex`); apply with `python3 scripts/acr.py review --apply <reviewed.json> --out $OUT`. Items left unreviewed stay marked "draft label".
5. **Render** — `python3 scripts/acr.py render --in $OUT/report.json --out $OUT --print`.
6. **PDF** — `python3 scripts/acr.py pdf --out $OUT` (skipped with a message when Chrome is missing).
7. **Optional, needs Alex's go — measured OpenRouter spend**: with a regular inference key in the environment, `OPENROUTER_API_KEY=… python3 scripts/acr.py measure-openrouter --out $OUT` before step 3. Without the key the file says `unavailable` and nothing else changes.
8. **Optional, needs Alex's go — Mac export merge**: `python3 scripts/acr.py rollup … --device-usage <device-usage-mac.json>` (see Gaps and gates).
9. Return absolute paths, the skill slug `agent-cost-report`, the headline dollars with their label, the mistakes line, the wins, PDF yes/no, and how the report answers the five product questions.

## Gaps and gates

Each of these needs Alex's explicit go; the report shows the honest fallback until then.

- **OpenRouter key (needs Alex)** — a regular inference `OPENROUTER_API_KEY` supplied as an environment variable through the house's secure secret flow; never a management or provisioning key, never read from a settings file, never printed or written to any output. The per-key endpoint gives UTC day/week/month snapshots, so the figure is shown with its bucket label and switches the hero to MEASURED only when the bucket fully covers the report window. A range-by-day source (`/api/v1/activity`) exists but needs a management key, so it is not implemented (G5).
- **Mac transcripts (needs Alex)** — sessions from Alex's Mac have no transcript on the box, so their cost is EXTRAPOLATED (low confidence) until a device export is merged. Either Alex runs, on the Mac, from a plain checkout of this skill (system `python3` 3.9+): `python3 scripts/acr.py collect --export-device mac --start YYYY-MM-DD --end YYYY-MM-DD --out ~/acr-export` and shares `~/acr-export/device-usage-mac.json` (ids, timestamps, token counts, model names; no prompt or observation text, no settings, no paths); or, only after Alex's explicit go for that specific run (window, machine, destination named), an orchestrating agent runs the same command on the registered Mac through the house's registered-machine tooling and copies only `device-usage-mac.json` to the box. A go for one run is not a go for the next (G6 covered Sep 18–26 only). Merge with `--device-usage`; joined sessions flip to `estimated_usage` with `device: mac`.
- **Grok Bot (ALWAYS unavailable, no seat count)** — Grok Bot is Cursor's cloud agent. Cursor shows its weekly usage only on the plan screen; there is no API or export, and the house has no xAI key for it. The report says exactly "Grok Bot usage: unavailable" (G4): no dollars, no guessed per-seat price, no seat count. A figure Alex supplies by hand would be entered as `measured_manual` with `entered_by: Alex` and the date, never inferred; that would be a new decision.
- **Wins from GitHub (read-only)** — besides box transcripts and ship observations, `rollup` lists merged PRs with `gh pr list --state merged` for the repos in `--wins-repo` (default `thedotmack/claude-mem`), filtered by merge time inside the PT window and deduplicated by repo and PR number. When `gh` is missing, unauthenticated or rate-limited, that source reads "unavailable" in Details and the report still completes; it is never a zero. `--no-gh` turns every gh call off.
- **Win cost (unmeasured until R4)** — sessions are not linked to PRs today, so every win reads "unmeasured (session not linked to PR)". Once commits carry a `Claude-Session: <content_session_id>` trailer (G13: trailer only, bare id), PR and publish wins get `ESTIMATED · session-linked` costs. There is no fallback estimate (G11).
- **Merge to main, npm publish, `/version-bump`** — each needs Alex's separate go. Pushing the work branch and opening the PR are routine.

## Keeping copies in sync

The plugin directory is the source of truth. `python3 scripts/acr.py sync-check` compares `SKILL.md`, `CHECKSUMS.txt` and `scripts/**` against the house copy (`~/agent-data/workflows/agent-cost-report/`) and the four mirror plugins (`claude-mem-cursor`, `claude-mem-grok-bot`, `cowork`, `openclaw`, each under `skills/agent-cost-report/`) and exits 1 on drift; `--write` copies plugin → destinations and re-checks (G2). `CHECKSUMS.txt` is `sha256sum -c` compatible.

## Related

- claude-mem `mem-search` skill — progressive recall
- `plans/2026-09-25-agent-cost-report-weekly.md` — the rebuild plan, decisions G1–G16, and the verification targets

## Creed

**Claude-Mem skill · outcomes first · estimates labeled · most recent by default · rework under failure_type · progressive recall · HTML is canonical · humans see what the agent did and why it cost money.**
