---
name: Agent Cost Report
description: >-
  Turn Claude-Mem activity into a manager-readable cost and failure report via
  progressive Mem Search — cost per completed outcome, failure economics,
  self-contained HTML/PDF plus json/csv/evidence. Default scope: most recent
  sessions. Claude-Mem plugin skill (Notion draft is SPEC only, not the product).
---

# Agent Cost Report

**Claude-Mem / Claude Code skill.** Runtime is progressive Mem Search → work items → cost model → manager HTML/PDF. The Notion draft is SPEC history only — never the product, never the runtime, never the ship vehicle.

## Purpose

Turn Claude-Mem activity into a **manager-readable cost and failure report**.

Product idea: a reusable skill that searches Claude-Mem via Mem Search, reconstructs real units of work, assigns cost and failure categories, and renders a printable report.

## Insight north star

Unique insights into the costs of **agentic** work. Written for humans who need to understand **what an agent is doing** and **why it costs money**. Seeing the report should intuitively reveal **what the numbers mean** and **where / what to pay attention to**.

## Questions the report must answer

1. What work was completed?
2. What did each outcome cost?
3. What was wasted through looping, hedging, wrong turns, rework, or poor routing?
4. Were any unauthorized actions attempted?
5. What should the manager change next?

**Primary unit = cost per completed outcome** (not cost per observation).

## When to use

- "Agent cost report" / "cost per outcome" / "failure economics" / "was this session worth it"
- After a real Mem session dig when leadership needs outcome economics
- Sample / ship packs that need self-contained HTML + JSON + CSV + evidence

Sibling for raw list-$ burn: [expense-daily-kpi](sand-workflow:expense-daily-kpi) / TER / mem-invoice. Memory dig mechanics: [mem-search](sand-workflow:mem-search). Plain document polish: [document](sand-workflow:document).

## Default scope (ALWAYS)

- Unless the user names a **specific session / range / project**, default to the **most recent** Claude-Mem sessions.
- Prefer **last 24–72 hours**; else the newest meaningful sessions.
- Supported scopes: one session, group of sessions, date range, project, worktree, agent/platform, model, task/issue/PR/incident, and combinations.
- The report **Scope** section lists session IDs, time range (PT), and one sentence on why those sessions are in scope.

## Progressive Mem Search (ALWAYS)

Follow [mem-search](sand-workflow:mem-search) three layers. Keep spend light.

1. **Search** — get an index of IDs (titles, types, token hints).
2. **Timeline** — only around anchors you care about.
3. **Observations** — `get_observations` for the filtered IDs you will cite as evidence.

Recipe:

1. Resolve scope (default: most recent sessions).
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

## Work categories (ALWAYS)

`Feature` · `Bug fix` · `Incident` · `Maintenance` · `Investigation` · `Experiment`

## Failure / waste types (ALWAYS)

`Looping` · `Hedging` · `Wrong turn` · `Rework` · `Regression` · `Premature completion` · `Unauthorized action` · `Suboptimal path` · `Duplicate work` · `Blocked work` · `Missed requirement` · `Unnecessary escalation` · `Context re-read` · `Model thrash` · `Fan-out waste` · `Recovery after miss`

**Rework lock (ALWAYS):** Rework lives **only** under `failure_type` — never as a work category. Keep category as the intended job type; set `failure_type: Rework` when rework occurred.

A line item can have a work category **and** a failure_type (e.g. Maintenance + Looping).

## Cost model

```
estimated_usage_cost_i = discovery_tokens_i × input_usd_per_mtok / 1_000_000

outcome_cost_j         = Σ cost_i for evidence obs on work item j
                         (prefer measured_cost when present; else estimated_usage_cost)

net_task_cost_j        = successful delivery + failure/rework + correction
                       # = productive + wasted + recovery for that item

wasted_cost            = all attributable cost without a completed outcome
                       # (false-positive loops, hedging forks that died, wrong turns, thrash)

recovery_cost          = spend to get back on the productive path
                       # necessary without always being waste — track separately

cost_per_completed_outcome =
    Σ outcome_cost_j for status ∈ {shipped, completed, done}
  / count(those work items)

waste_rate             = Σ wasted_cost_j  / Σ outcome_cost_j
recovery_share         = Σ recovery_cost_j / Σ outcome_cost_j
```

Track separately on each line: `measured_cost`, `estimated_usage_cost`, `wasted_cost`, `recovery_cost`, `risk_exposure`.

**Unauthorized blocked:** `direct_cost` $0, `risk_exposure` high, `action_status` blocked. Always keep risk_exposure non-dollar unless real cash/remediation is at stake — never invent risk dollars.

`confidence` — `high` when tokens + model + outcome are clear; `medium` when allocation across obs is judgmental; `low` when evidence is thin.

Default PRICE-TABLE: `/workspace/reports/mem-invoice/PRICE-TABLE.json`

## Money labeling (ALWAYS)

| Label | Meaning |
|-------|---------|
| **Measured** | Provider-reported `usage.cost` (or equivalent) present on the observation / run |
| **Estimated** | `discovery_tokens × input_usd_per_mtok / 1e6` from PRICE-TABLE |
| **Unavailable** | No measured value — write `measured spend unavailable`, never `$0 spent` for unknown |
| **risk_exposure** | Severity / qualitative unless real cash is at stake (seats, refunds, SLA) |

`cost_basis` on each line item: `estimated_usage` or `measured_provider`.

## Line-item schema

Each row in `line-items.csv` / `report.json.line_items`:

| Field | Notes |
|-------|-------|
| `work_item` / `work_item_id` | Stable id (`WI-1` …) + manager-readable title |
| `title` | Human work-item title (ALWAYS invent; obs titles evidence-only) |
| `scope` | Session / range / project label |
| `project` | Primary project |
| `worktree` | When relevant |
| `session_ids` | Mem session id(s) |
| `status` | `shipped` / `completed` / `in_progress` / `abandoned` / `blocked` |
| `category` / `work_category` | One of the six work categories |
| `failure_type` | Empty or one failure type (Rework lives here) |
| `cost_measured` / `measured_cost` | Number or `unavailable` |
| `cost_estimated` / `estimated_usage_cost` | List-price estimate USD |
| `wasted_cost` | USD (0 if none) |
| `recovery_cost` | USD (0 if none) |
| `productive_cost` | USD |
| `risk_exposure` | `none` / `low` / `medium` / `high` (non-dollar unless real cash) |
| `evidence_ids` / `evidence_obs_ids` | Observation IDs |
| `discovery_tokens` | Sum of evidence tokens |
| `model` | e.g. `deepseek/deepseek-v4-flash-0731` |
| `input_usd_per_mtok` | From PRICE-TABLE |
| `cost_basis` | `estimated_usage` or `measured_provider` |
| `recommended_action` | One concrete manager/process lever |
| `confidence` | `high` / `medium` / `low` |
| `date_pt` | America/Los_Angeles calendar day |
| `notes` | One plain-English sentence |

## Deliverables (ALWAYS)

Write a directory (e.g. `/workspace/agent-cost-report-v2/`) containing:

1. **`report.html`** — self-contained (inline CSS), print CSS, plain English, no external deps
2. **`report.pdf`** — from HTML when a converter exists (`google-chrome` headless, `wkhtmltopdf`, `weasyprint`); else document print-to-PDF in README and ship HTML as canonical
3. **`report.json`** — machine summary + line items + totals
4. **`line-items.csv`** — one row per work item
5. **`evidence.json`** — observation IDs cited, short titles, tokens, model, session
6. **`README.md`** — scope (session IDs + PT range + why), paths, methodology

### Manager-facing HTML sections (required order)

1. **Executive summary** — completed outcomes, total measured, total estimated usage, cost per completed outcome, failure/rework cost, waste rate, blocked work, unauthorized attempts, largest cost/risk driver, recommended management action
2. **Cost by outcome** — table: Work item | Result | Cost | Rework? | Manager takeaway
3. **Failure economics** — table: Failure line | Type | Cost | Status | Action — most important events only
4. **Variance and recommendations** — what the numbers mean; what to change next
5. **Evidence appendix** — obs IDs (not a timeline dump); optional adjacent sessions noted separately and omitted from cost totals when appropriate

Also include a short **Scope** strip (session IDs, PT range, why most-recent / in-scope) near the top so the reader knows the window.

Print CSS: `@media print` with page breaks between major sections; dark-ink friendly.

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

## Recipe (orchestrator)

1. Confirm scope defaults to most recent sessions; note PRICE-TABLE path.
2. Progressive Mem Search → filtered evidence IDs only.
3. Invent manager work items; map evidence; assign work_category + optional failure_type.
4. Compute estimates; mark measured unavailable when absent; allocate wasted/recovery thoughtfully.
5. Emit HTML + JSON + CSV + evidence (+ PDF if tool present) with Scope + the five manager sections.
6. Return absolute paths, skill slug `agent-cost-report`, totals, PDF yes/no, and how the report answers the five product questions.

## Mac transcripts (needs Alex)

Sessions from Alex's Mac have no transcript on the box, so their cost is EXTRAPOLATED (low confidence) until a device export is merged. Two sanctioned paths, either one needs Alex:

1. Ask Alex to run, on the Mac, from a plain checkout of this skill (system `python3` 3.9+):
   `python3 scripts/acr.py collect --export-device mac --start YYYY-MM-DD --end YYYY-MM-DD --out ~/acr-export`
   and share `~/acr-export/device-usage-mac.json` (ids, timestamps, token counts, model names; no prompt or observation text, no settings).
2. Only after Alex's explicit go for that specific run (window, machine, destination named), run the same command on the registered Mac through the house's registered-machine tooling and copy only `device-usage-mac.json` to the box. A go for one run is not a go for the next.

Merge on the box with `python3 scripts/acr.py rollup ... --device-usage <file>`. Joined sessions flip to `estimated_usage` with `device: mac`; whatever stays unmeasured is extrapolated again and keeps its label.

## Grok Bot (ALWAYS unavailable, no seat count)

Grok Bot is Cursor's cloud agent. Cursor shows its weekly usage only on the plan screen; there is no API or export, and the house has no xAI key for it. The report says exactly "Grok Bot usage: unavailable" (G4, Alex 2026-09-25): no dollars, no guessed per-seat price, no seat count. If Alex ever supplies a figure by hand it is entered as `measured_manual` with `entered_by: Alex` and the date, never inferred; that would be a new decision.

## Related

- [mem-search](sand-workflow:mem-search) — progressive recall (Claude-Mem)
- [expense-daily-kpi](sand-workflow:expense-daily-kpi) — daily list-$ KPI scorecard
- TER / mem-invoice — token expense / PRICE-TABLE ledger
- [document](sand-workflow:document) — plain English lock

## Creed

**Claude-Mem skill · outcomes first · estimates labeled · most recent by default · rework under failure_type · progressive recall · HTML is canonical · humans see what the agent did and why it cost money.**
