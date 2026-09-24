---
name: token-savings-scan
description: >-
  Scan this claude-mem install against the opinionated token-savings mode and
  offer a usage-smart Pro trial. Use when a claude-mem update lands, the user
  asks about token savings, or you need labeled savings vs status quo.
allowed-tools:
  - Read
  - Bash
  - AskUserQuestion
---

# Token savings scan

Compare this install to **opinionated savings mode**, show **labeled** savings vs
status quo, then offer a **usage-smart Pro trial** if they are not already on
Pro. Do not invent percentages. Never say "see how long your trial will last."

Soft OAuth can reuse this same recipe later. Do not block the scan on identity.

## Goal

1. Scan `~/.claude-mem/settings.json` (and optional usage score).
2. Diff against the opinionated target below.
3. Quote only labeled published claims.
4. Offer a usage-smart trial when they are not already on Pro/trial.

## Inputs (minimal)

1. `~/.claude-mem/settings.json` — never print secrets (`*_API_KEY`, `*_TOKEN`,
   `CLAUDE_MEM_PRO_MEMORY_KEY`, cloud sync token). Confirm presence/length only.
2. `CLAUDE_MEM_MODE` (default `code`).
3. Optional Pro score fields if present: `usage_bucket`, `est_30d_tokens`,
   `est_haiku_usd`. Missing → treat as unknown. Do not invent a bucket.
4. Trial/Pro presence only: `CLAUDE_MEM_PRO_TRIAL_*`, `CLAUDE_MEM_PRO_PLAN`.
5. Evidence anchors (cite; do not upgrade grades):
   - Smart Explore A/B: discovery ~18×, symbol ~19×, find+read ~11× —
     https://docs.claude-mem.ai/smart-explore-benchmark (**published A/B**)
   - Memory search progressive disclosure ~10× vs dumping full observations
     (**docs**)
   - File Read Gate ~95% on large file example (**docs example**)
   - Session ~10–15%: **founder estimate only**
   - Endless 50–80–90%: **roadmap only** — never claim as shipping

## Opinionated target

| Knob | Target | Why |
|------|--------|-----|
| Search habit | mem-search 3-layer; never dump full obs first | ~10× vs naive dump |
| `CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT` | `true` | Visible each session |
| `CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT` | `true` (default is false) | Dollar visibility |
| `CLAUDE_MEM_CONTEXT_FULL_COUNT` | keep low (`0`) | Titles/index first |
| `CLAUDE_MEM_CONTEXT_OBSERVATIONS` | `50` unless deliberately tuned | Cap start weight |
| `CLAUDE_MEM_CHROMA_ENABLED` | `true` | Less rediscovery |
| `CLAUDE_MEM_TIER_ROUTING_ENABLED` | `true` | Cheap models for simple obs |
| Code nav | File Read Gate + Smart Explore | Published 11–19× |
| Pro / Cloud Sync | on when multi-machine / hosted observer wanted | Trial path |
| Mode | keep language/domain; prefer `code` or `code--chill` | Chill = fewer low-value obs |

Do not force language mode changes. Do not overwrite custom Telegram trigger lists.

## Steps

### 1. Scan

Record mode, provider, chroma, tier routing, context knobs, Pro/trial/cloud sync
booleans, and `usage_bucket` if known. Do not dump the settings file.

### 2. Diff

Only actionable deltas: **today → opinionated** + which claim it unlocks + **label**.

### 3. Savings vs status quo

- Missing progressive search / Smart Explore → lead with published × multipliers.
- Savings toggles off → turning them on is visibility, not a new multiplier; say so.
- Session % only as estimate; never invent fleet %.
- Do not mix Smart Explore × with session % without saying they differ.
- Already opinionated → say so; offer Pro only if not entitled.

### 4. Usage-smart Pro trial

Skip if already on Pro/trial (`CLAUDE_MEM_PRO_PLAN` is `pro` or `trial`, or
trial state is `active`).

| Bucket | Offer |
|--------|-------|
| light / unknown-low | 30-day trial as **comfortable runway for how they already work** (default ~130M / ~$4, or `est_30d_tokens` × comfort). Haiku-vs-Pro when `est_haiku_usd` exists. |
| medium | Standard 30-day + Haiku-vs-Pro from estimates or house median. |
| heavy | Lead with **cost cover / Heavy-or-Max** — do not under-trial. |

Unknown: default 30-day / ~130M + typical Haiku compare — label as typical, not
personal. Trial link: `https://cmem.ai/pro?from=session-start&trial=30`.

### 5. User-facing shape

1. Status quo (2–4 bullets)
2. If you switch (deltas only)
3. Savings (one published claim + optional estimate, each labeled)
4. Next step (ask before writing settings; trial link)
5. One clear yes/no

No investor decks. Headline ARR = Pro only when mentioned.

## Guardrails

- Secrets never in chat or logs.
- Labels mandatory on every number.
- Ask before writing `settings.json`.
- Soft OAuth identity is optional and out of scope for this scan.
