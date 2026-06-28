# Spec: persist generation cost (the second telemetry gap)

## Problem

The growth/value story has two data layers with very different histories:

| Layer | Event | Span | Recoverable historically? |
|---|---|---|---|
| Observation growth | `historical_activity` | Oct 2025 → now | n/a (already backfilled) |
| **Injection value** (read-cost avoided) | `context_injected` | live, Jun 9+ | **Yes** — done in this PR via `backfill.ts` (read_tokens from `observations.text`, savings = discovery − read) |
| **Generation cost** (what it cost to *produce* observations) | `session_compressed` | live, Jun 7+ | **No** — see below |

`session_compressed` carries `tokens_input`, `tokens_output`, `cost_usd`, computed in
`ResponseProcessor` from the SDK `result` message (Claude path) or
`usage.cost` (OpenRouter). **These values are emitted to PostHog and then discarded —
they are never written to SQLite.** `observations` has no token/cost column;
`sdk_sessions` has none; `session_summaries` only has `discovery_tokens` (read cost,
not generation cost).

Consequence: there is no way to backfill generation cost for the ~8 months before
`session_compressed` started firing. The data simply does not exist on disk. The
cost/economics panel can therefore only ever be a *live, forward-looking* metric
unless we start persisting it now.

## Goal

Persist per-compression generation cost so that:
1. future backfills/audits can roll it up per day (same shape as the other rollups), and
2. a "what it cost to produce vs what it saved" panel can be built from local data.

This does **not** recover the past. It stops the bleed going forward.

## Design

A compression turn is not 1:1 with an observation row (one turn → N observations + 1
summary), so generation cost belongs on a **per-turn** record, not smeared across
observation rows (that was the `discovery_tokens` multi-count trap — see backfill.ts
comments). Two viable homes:

- **Option A (preferred): new `compression_events` table.** One row per
  `session_compressed`, keyed by `memory_session_id` + turn. Columns:
  `tokens_input INTEGER, tokens_output INTEGER, cost_usd REAL, model TEXT,
  provider TEXT, outcome TEXT, created_at_epoch INTEGER`. Clean, append-only,
  trivially rolled up. Mirrors the event we already emit.
- **Option B: columns on `session_summaries`.** Cheaper migration, but summaries are
  per-session-summary not per-turn, and `outcome='invalid_output'` turns have no
  summary row — those costs would be lost. Rejected for that reason.

Go with Option A.

### Steps

1. **Schema migration (SessionStore.ts, next version after 32):**
   `ensureCompressionEventsTable()` — `CREATE TABLE IF NOT EXISTS compression_events (...)`
   with index on `created_at_epoch DESC`. Best-effort, same pattern as the other
   `ensure*` migrations.

2. **Write path (ResponseProcessor.ts):** at every existing
   `captureEvent('session_compressed', …)` site, also `INSERT INTO compression_events`
   the same `tokens_input/tokens_output/cost_usd/model/provider/outcome`. The Claude
   path stashes the event on `session.pendingCompressionEvent` and fires it from
   `ClaudeProvider` once the `result` message lands — write to SQLite at that same
   point so the token/cost fields are populated, not the early-stream placeholders.
   Guard on a real cost (the abort/kill path ships without token fields — write the
   row with NULLs rather than dropping it, to keep turn counts honest).

3. **Backfill rollup (backfill.ts → collectDailyRollups):** add a block summing
   `tokens_input`, `tokens_output`, `cost_usd` from `compression_events` per day into
   counters `gen_tokens_input`, `gen_tokens_output`, `gen_cost_usd`. Wrapped in the
   same try/catch (older installs without the table skip the block). This only
   produces data for days on/after this ships — that is expected and correct.

4. **Whitelist (scrub.ts):** add `gen_tokens_input`, `gen_tokens_output`,
   `gen_cost_usd` to the backfill section. `cost_usd`/`tokens_input`/`tokens_output`
   are already whitelisted for the live event; the `gen_*` names disambiguate the
   per-day rollup from the per-event live values to avoid semantic collisions in
   PostHog (same reasoning as keeping `read_tokens` distinct).

5. **Docs (docs/public/telemetry.mdx):** document the new table and the three rollup
   keys. Counts/sums only, no content — consistent with the existing privacy contract.

6. **Tests (tests/telemetry/backfill.test.ts):** fixture row in `compression_events`,
   assert per-day `gen_cost_usd` / `gen_tokens_*` sums; assert the block no-ops when
   the table is absent.

## Privacy

`compression_events` stores integers, a float cost, and two closed-enum strings
(`model`, `provider`) already shipped on the live event. No project names, no text,
no prompts. Rollups remain counts/sums per UTC day. No new PII surface.

## Out of scope

Recovering pre-instrumentation cost. It was never written down; there is nothing to
recover. The honest framing for any dashboard is: generation cost is measured from
the date this ships forward; the observation-growth arc and (as of the sibling PR)
the read-cost-savings series extend back to Oct 2025.
