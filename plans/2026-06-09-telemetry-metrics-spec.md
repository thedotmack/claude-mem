# Telemetry Metrics Spec — the story the data must tell

Audience: us, when building the PostHog dashboard and the fundraise narrative.
Premise: 82k GitHub stars, zero analytics history. The dataset starts the day
this ships, so every chart below is designed to be meaningful within 4–8 weeks
of data and to compound from there.

## The narrative arc (what a deck slide needs to say)

1. **Reach** — "X installs/week and growing N% w/w, across 12 IDEs."
2. **Habit** — "Installs come back: D30 retention X%, DAU/MAU X%."
3. **Value loop** — "Memory isn't shelfware: X% of installs reach the aha
   moment, and active installs read memory back X times/day."
4. **Reliability** — "Core pipeline succeeds X% of the time at scale."

Everything below maps an event to one of those four sentences. If a metric
doesn't feed a sentence, it doesn't go on the dashboard.

## Unit of measure — be precise with VCs

The `distinct_id` is an **install** (one machine + one `~/.claude-mem`), not a
human. Quote "active installs", never "users". This is the honest dev-tool
convention (Homebrew, VS Code extensions count the same way) and diligence
will check. Reinstalls keep the same ID (uninstall preserves the data dir), so
returning installs are not double-counted.

Always filter `is_ci = false` on every insight. CI noise inflates everything.

## Event → metric map

### Reach (growth accounting)
| Metric | Definition |
|---|---|
| New installs/week | unique `distinct_id` on `install_completed` where `is_update = false` |
| Upgrade adoption | `install_completed` where `is_update = true`, broken down by `version` |
| Active installs (WAU/MAU) | unique `distinct_id` on `worker_started` (start + daily heartbeat = presence signal) |
| Churn | `uninstall_completed` count; net growth = new − uninstalls |
| Surface mix | `install_completed` breakdown by `ide`, `provider`, `runtime_mode` |

### Habit (retention — the slide that raises the round)
| Metric | Definition |
|---|---|
| D1/D7/D30 retention | PostHog Retention insight: first `install_completed` → returning on `worker_started`. Requires person profiles — that's why lifecycle events set them. |
| Stickiness (DAU/MAU) | PostHog Stickiness insight on `worker_started` |
| Lifecycle | PostHog Lifecycle insight on `worker_started` (new / returning / resurrecting / dormant) |
| Retention by segment | same retention insight broken down by person property `ide` or `provider` — "Cursor installs retain 2×" is a fundable sentence |

### Value loop (activation + engagement)
| Metric | Definition |
|---|---|
| Activation funnel | Funnel: `install_completed` → first `session_compressed` → first `context_injected`. The third step is the aha moment: stored memory actually used. |
| Time-to-value | median time from `install_completed` to first `context_injected` |
| Engagement depth | `session_compressed` count per active install per day; `context_injected` per active install per day |
| Read/write ratio | `context_injected` ÷ `session_compressed` — memory being consumed, not hoarded |
| Feature adoption | `search_performed` breakdown by `endpoint` |

### Reliability (diligence armor)
| Metric | Definition |
|---|---|
| Compression success rate | `session_compressed` outcome ok ÷ all, by `version` and `provider` |
| Error rate | `error_occurred` per active install, by `error_category` and `version` |
| Latency health | p50/p95 `duration_ms` on `session_compressed`, `search_performed`, `context_injected` |
| Install success rate | `install_completed` ÷ (`install_completed` + `install_failed`), failures by `error_category` |

## Person-profile design (cost control)

Only lifecycle events (`install_*`, `uninstall_completed`, `worker_started`)
carry person profiles — ~1–2 events/day/install, so profile-priced ingestion
stays bounded even at 100k installs. High-volume operational events are
profile-less (cheaper tier). Person properties are the whitelisted enums only:
`version`, `os`, `arch`, `runtime`, `locale`, `ide`, `provider`, `runtime_mode`.

## Caveats to state proactively in diligence

- Telemetry is opt-out (`DO_NOT_TRACK` honored, one-command disable); numbers
  undercount by the opt-out rate. That's the credible direction to undercount.
- Data starts <date this ships>; star history is the pre-telemetry proxy.
- One human can be several installs (work + home). Quote installs.

## Dashboard build order (PostHog UI, ~30 min)

1. Trends: weekly unique `worker_started` (active installs) + weekly
   `install_completed` where `is_update=false` (new installs).
2. Retention: `install_completed` → `worker_started`, weekly, breakdown `ide`.
3. Funnel: `install_completed` → `session_compressed` → `context_injected`,
   14-day window.
4. Stickiness + Lifecycle on `worker_started`.
5. Trends: `session_compressed` outcome error ÷ total (reliability), p95
   `duration_ms` (latency).
