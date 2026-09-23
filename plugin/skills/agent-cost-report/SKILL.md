---
name: Agent Cost Report
description: >-
  Use when building a manager-readable agent spend report from Claude-Mem via
  progressive Mem Search — cost per completed outcome, failure economics,
  self-contained HTML/PDF plus json/csv/evidence. Default scope: most recent
  sessions. Not a Notion skill; not a token invoice ledger.
---

# Agent Cost Report

**This is a Claude-Mem / Claude Code skill.** Runtime is progressive Mem Search + local report artifacts. Notion (if linked anywhere) is optional pasting/spec history only — never the product, never the runtime, never the ship vehicle.

Build a **manager-readable agent spend report** from Claude-Mem via progressive Mem Search. Primary unit: **cost per completed outcome**. Audience: eng manager / Prioritizer / Alex glance.

Sibling for raw list-$ burn: [expense-daily-kpi](sand-workflow:expense-daily-kpi) / TER / mem-invoice. This skill answers *what the agent did, why it cost that, what the numbers mean, what to watch* — with **unique agentic waste signals**.

## North star (ALWAYS)

1. Say **what the agent did** (manager work items), not observation titles as the primary row.
2. Say **why it costs** (tokens × PRICE-TABLE estimate, or measured provider usage when present).
3. Say **what the numbers mean** (productive vs wasted vs recovery).
4. Say **what to watch** (failure economics + variance / recommendations).
5. Surface **UNIQUE agentic waste**: Looping, Hedging, Wrong turn, Rework, Model thrash, Fan-out waste, Context re-read, Premature completion — not just "tokens went up."

## Default scope (ALWAYS)

- Unless the user names a **specific session / range / project**, default to the **most recent** Claude-Mem sessions.
- Prefer **last 24–72 hours**; else the newest meaningful sessions.
- **Never** cherry-pick old historical sessions for demos / samples.
- The report **Scope** section MUST list session IDs, time range (PT), and one sentence on why those sessions are "most recent."

## When to use

- "Agent cost report" / "cost per outcome" / "failure economics" / "was this session worth it"
- After a real Mem session dig when leadership needs outcome economics (not a token ledger)
- Sample / ship packs that need self-contained HTML + JSON + CSV + evidence

**Not this skill:** daily KPI burn strip → [expense-daily-kpi](sand-workflow:expense-daily-kpi). Raw token invoice / mem-invoice ledger → TER / mem-invoice. Plain document polish → [document](sand-workflow:document). Memory dig mechanics → [mem-search](sand-workflow:mem-search). Do **not** implement or frame this as a Notion skill / Notion database / Notion page product.

## Progressive Mem Search (ALWAYS)

Follow [mem-search](sand-workflow:mem-search) three layers. Keep spend light.

1. **Search** — get an index of IDs (titles, types, token hints).
2. **Timeline** — only around anchors you care about; never dump a whole session timeline into the main report.
3. **Observations** — `get_observations` for the filtered IDs you will cite as evidence.

ADHD process bullets:

- Search first → pick IDs → timeline only if context is thin → fetch only needed obs.
- Work-item titles are invented for managers ("Restore search after Chroma crash-loop"), never paste observation titles as the primary label.
- Evidence appendix can list obs IDs + short titles; main sections stay outcome-first.

## Money labeling (ALWAYS)

| Label | Meaning |
|-------|---------|
| **Measured** | Provider-reported `usage.cost` (or equivalent) present on the observation / run |
| **Estimated** | `discovery_tokens × input_usd_per_mtok / 1e6` from PRICE-TABLE |
| **Unavailable** | No measured value — write `unavailable`, never `$0` |
| **risk_exposure** | Non-dollar unless real cash is at stake (seats, refunds, SLA) |

Rules:

- Never present an estimate as provider-measured.
- Never print `$0` when the true state is unknown / unavailable.
- Always stamp `cost_basis` on each line item (`estimated_usage_list_price` or `measured_provider_usage`).
- Default PRICE-TABLE: `/workspace/reports/mem-invoice/PRICE-TABLE.json`
- Formula: `estimate = discovery_tokens × input_usd_per_mtok / 1e6`

## Taxonomy (ALWAYS)

### Work categories (what kind of work)

`Feature` · `Bug fix` · `Incident` · `Maintenance` · `Investigation` · `Experiment`

### Failure types (where waste / rework lives)

**Rework lives ONLY under `failure_type` — never as a work category.**

`Looping` · `Hedging` · `Wrong turn` · `Rework` · `Regression` · `Premature completion` · `Unauthorized action` · `Suboptimal path` · `Duplicate work` · `Blocked work` · `Missed requirement` · `Unnecessary escalation` · `Context re-read` · `Model thrash` · `Fan-out waste` · `Recovery after miss`

A line item can have a work category **and** a failure_type (e.g. Maintenance + Looping on a false-positive redeploy).

## Cost model formulas

```
estimated_usage_cost_i = discovery_tokens_i × input_usd_per_mtok / 1_000_000

outcome_cost_j         = Σ cost_i for evidence obs on work item j
                         (prefer measured_cost when present; else estimated_usage_cost)

productive_cost_j      = outcome_cost_j − wasted_cost_j
                       # recovery_cost is tracked separately; do not double-subtract

cost_per_completed_outcome =
    Σ outcome_cost_j for status ∈ {shipped, completed, done}
  / count(those work items)

waste_rate             = Σ wasted_cost_j  / Σ outcome_cost_j
recovery_share         = Σ recovery_cost_j / Σ outcome_cost_j
```

Allocation guidance:

- **wasted_cost** — agentic failure burn (false-positive loops, hedging forks that died, wrong turns, thrash).
- **recovery_cost** — spend to get back on the productive path (FTS bridge, safe revert, redeploy after miss). Recovery can be *necessary* without being waste.
- **confidence** — `high` when tokens + model + outcome are clear; `medium` when allocation across obs is judgmental; `low` when evidence is thin.

## Line-item schema

Each row in `line-items.csv` / `report.json.line_items`:

| Field | Notes |
|-------|-------|
| `work_item_id` | Stable id (`WI-1` …) |
| `title` | Manager-readable work-item title |
| `work_category` | One of the six work categories |
| `failure_type` | Empty or one failure type (Rework lives here) |
| `status` | `shipped` / `completed` / `in_progress` / `abandoned` |
| `evidence_obs_ids` | Semicolon- or JSON-list of observation IDs |
| `discovery_tokens` | Sum of evidence tokens |
| `model` | e.g. `deepseek/deepseek-v4-flash-0731` |
| `input_usd_per_mtok` | From PRICE-TABLE |
| `estimated_usage_cost` | List-price estimate USD |
| `measured_cost` | Number or `unavailable` |
| `cost_basis` | `estimated_usage_list_price` or `measured_provider_usage` |
| `wasted_cost` | USD (0 if none) |
| `recovery_cost` | USD (0 if none) |
| `productive_cost` | USD |
| `confidence` | `high` / `medium` / `low` |
| `session_id` | Mem session id |
| `project` | Primary project |
| `date_pt` | America/Los_Angeles calendar day |
| `notes` | One plain-English sentence |

## Deliverables (ALWAYS)

Write a directory (e.g. `/workspace/agent-cost-report-recent/`) containing:

1. **`report.html`** — self-contained (inline CSS), print CSS, plain English
2. **`report.pdf`** — from HTML when a converter exists (`wkhtmltopdf`, `weasyprint`, or Chromium headless); else document print-to-PDF in README and ship HTML as canonical
3. **`report.json`** — machine summary + line items + totals
4. **`line-items.csv`** — one row per work item
5. **`evidence.json`** — observation IDs cited, short titles, tokens, model, session
6. **`README.md`** — scope (session IDs + PT range + why most-recent), paths, methodology

### HTML sections (required)

1. **Scope** — session IDs, time range PT, why these are most recent
2. **Executive summary** — what shipped, total estimated $, cost per completed outcome, waste rate, one insight
3. **Cost by outcome** — table of work items with category, status, estimated $, confidence
4. **Failure economics** — wasted / recovery / productive; failure_type callouts
5. **Variance & recommendations** — what to watch next; model / process levers
6. **Evidence appendix** — obs IDs (not a timeline dump); optional adjacent sessions noted separately and **omitted from cost totals**

Print CSS: `@media print` with page breaks between major sections; dark-ink friendly.

## Forbidden hang

Do **not** chase OpenRouter **management / admin keys** or Activity stamp scavenger hunts. List-price PRICE-TABLE estimates are the default path. Measured provider usage only when already present on the observation — never block the report waiting on OR admin.

Do **not** build Notion databases, Notion pages, or Notion skills as the deliverable. Optional historical notes live only as comments / scratch and must not appear in report titles or skill identity.

## Recipe (orchestrator)

1. Confirm scope defaults to most recent sessions; note PRICE-TABLE path.
2. Progressive Mem Search → filtered evidence IDs only.
3. Invent manager work items; map evidence; assign work_category + optional failure_type.
4. Compute estimates; mark measured unavailable when absent; allocate wasted/recovery thoughtfully.
5. Emit HTML + JSON + CSV + evidence (+ PDF if tool present) with explicit Scope.
6. Return absolute paths, skill slug `agent-cost-report`, totals, PDF yes/no, blockers.

## Related

- [mem-search](sand-workflow:mem-search) — progressive recall (Claude-Mem)
- [expense-daily-kpi](sand-workflow:expense-daily-kpi) — daily list-$ KPI scorecard
- TER / mem-invoice — token expense / PRICE-TABLE ledger
- [document](sand-workflow:document) — plain English lock

## Creed

**Claude-Mem skill · outcomes first · estimates labeled · most recent by default · rework under failure_type · progressive recall · HTML is canonical.**
