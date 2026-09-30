# PostHog Self-driving Setup Report

_Generated 2026-07-14 for project CMEM (ID 463218)_

## Summary

PostHog Self-driving was configured for the claude-mem project. Error tracking (three trigger types), session replay, GitHub Issues, and support ticket signal sources were enabled; the scout troop was tuned to three scouts matching this project's primary surfaces (AI/LLM usage and MCP tool calls). Findings will start appearing in the [Self-driving inbox](https://us.posthog.com/project/463218/inbox) within ~30 minutes.

---

## AI data processing

**Approved.** Organization-level AI data processing consent was granted before this run.

---

## GitHub

**Already connected** — GitHub App integration (`thedotmack`, integration ID 175967) was present at setup time, connected on 2026-06-10. One repository is synced: `thedotmack/claude-mem`.

---

## Products enabled

| Product | Status | Notes |
|---|---|---|
| Session Replay | **Already active** | Recordings flowing from cmem.ai; `products-enable` API not available in this deployment — server state confirmed by live recordings |
| Error Tracking | **Already active** | 1.1M+ events via `posthog-node` with `enableExceptionAutocapture`; `products-enable` API not available |
| Support (Conversations) | **Follow-up required** | Product could not be enabled via API (tool unavailable); see follow-ups for manual step |

This project uses `posthog-node` (backend), not `posthog-js`. No `posthog.init` override check was needed. Session replay for the web front-end (cmem.ai) appears to be instrumented from a separate repo or snippet.

---

## Signal sources

| source_product | source_type | Action |
|---|---|---|
| `error_tracking` | `issue_created` | **Enabled** (new, ID `019f6318-32fa-73a9-914f-55617f6800de`) |
| `error_tracking` | `issue_reopened` | **Enabled** (new, ID `019f6318-3775-7090-a2e5-d98f893734d0`) |
| `error_tracking` | `issue_spiking` | **Enabled** (new, ID `019f6318-39b6-7161-8bce-8e03a206d92b`) |
| `session_replay` | `session_analysis_cluster` | **Enabled** (new, ID `019f6318-3dd1-7dae-b4a0-36eba57cb746`; default 10% sample rate) |
| `conversations` | `ticket` | **Enabled** (new, ID `019f6318-4047-764c-94fc-ee62a511a9b2`; dormant until a channel is connected) |
| `signals_scout` | `cross_source_issue` | **On by default** — no config row needed; scout findings reach the inbox automatically |
| `llm_analytics` | `evaluation_report` | **Skipped** — internal-only responder, not user-facing |
| `logs` | — | **Skipped** — not a v1 responder |

---

## Connected tools

| Tool | Status |
|---|---|
| GitHub Issues | **Already connected** — `Github` warehouse source (ID `019eb017-8f11-0000-8ce2-d7bed20cb960`) was present; 1,766 issues synced as of 2026-07-14. Responder (`github` / `issue`, ID `019f6324-8a46-71ab-ad0b-8cea5b4fb795`) enabled. |
| Linear | **Not used** — not selected |
| Zendesk | **Not used** — not selected |
| pganalyze | **Not used** — not selected |

Note: the GitHub warehouse source has a token error on the `stargazers` table (`Access forbidden`). The `issues` table (the one the responder reads) is syncing cleanly. See follow-ups.

---

## Scout troop

**3 enabled, 23 disabled.**

### Enabled

| Scout | Reason |
|---|---|
| `signals-scout-general` | Always on — sweeps cross-product correlations and surfaces no specialist covers |
| `signals-scout-ai-observability` | This product wraps Claude/Anthropic APIs — LLM cost, latency, and error regressions are directly on-product |
| `signals-scout-mcp-tool-calls` | This product IS an MCP server — `$mcp_tool_call` telemetry covers tool failure rates and confusing schemas |

### Disabled

| Scout | Reason |
|---|---|
| `signals-scout-error-tracking` | Covered by the native `error_tracking` source (all three trigger types enabled above) |
| `signals-scout-session-replay` | Covered by the native `session_replay` source enabled above |
| `signals-scout-product-analytics` | No confirmed active funnels/retention insights — enable if you build out product analytics dashboards |
| `signals-scout-web-analytics` | No confirmed UTM/referrer tracking in this repo — enable if you add web analytics to cmem.ai |
| `signals-scout-feature-flags` | Feature flag usage not confirmed — enable if you adopt flags |
| `signals-scout-surveys` | 0 surveys in use |
| `signals-scout-revenue-analytics` | No payment SDK found |
| `signals-scout-logs` | PostHog logs product not confirmed in use |
| `signals-scout-csp-violations` | No CSP reporting configured |
| `signals-scout-experiments` | No active A/B experiments |
| `signals-scout-customer-analytics` | No group/accounts analytics confirmed |
| `signals-scout-data-pipelines` | No CDP destinations or hog flows found |
| `signals-scout-replay-vision` | Replay Vision scanners not configured |
| `signals-scout-apm` | No OpenTelemetry/APM tracing found |
| `signals-scout-anomaly-detection` | Covered adequately by `general` + specialists for this project size |
| `signals-scout-observability-gaps` | Can enable later if event coverage gaps become a concern |
| `signals-scout-health-checks` | Can enable if setup health becomes a concern |
| `signals-scout-inbox-validation` | Not useful on a fresh setup — no shipped fixes to validate yet |
| `signals-scout-ingestion-warnings` | Can enable if ingestion errors appear |
| `signals-scout-insight-alerts` | No configured insight alerts found |
| `signals-scout-skills-store` | Internal PostHog skill hygiene scout |
| `signals-scout-data-warehouse` | GitHub source token issue on `stargazers` — see follow-ups |
| `signals-scout-web-vitals` | No `$web_vitals` events confirmed from this repo |

---

## Custom scouts

Two surfaces were proposed and declined:

| Proposed scout | Surface | Why declined |
|---|---|---|
| Memory pipeline health | `observer_turn_rollup` → `context_injected_rollup` volume/ratio degradation | User dismissed the proposal |
| Install-to-first-memory funnel | `install_completed` → `worker_started` → first observation | User dismissed the proposal |

**Gap analysis ruled out:**
- Chroma dependency health — already covered by the `error_tracking` native source (`ChromaUnavailableError` is the dominant issue)

**Noise escape hatch:** to put any scout into dry-run (it runs and logs but emits nothing to the inbox), set `emit: false` on its config in PostHog > Self-driving settings.

---

## Follow-ups

- [ ] **Enable Support/Conversations product** — `products-enable` API was not available in this PostHog deployment. Enable Session Replay, Error Tracking, and Conversations manually in [Project settings > Products](https://us.posthog.com/project/463218/settings) if not already on.
- [ ] **Connect a Support inbound channel** — The `conversations/ticket` signal source is enabled and waiting. Connect an email, inbox, or Slack channel in PostHog so support tickets start reaching the inbox. ([Integrations settings](https://us.posthog.com/project/463218/settings/environment-integrations))
- [ ] **Fix GitHub token permissions** — The `stargazers` table is failing with "Access forbidden / rate limits". Check the GitHub App token scope at [Integrations settings](https://us.posthog.com/project/463218/settings/environment-integrations) — the `issues` table syncs cleanly so this doesn't block the Self-driving responder, but it may affect other warehouse queries.
- [ ] **Consider enabling `signals-scout-memory-pipeline`** — A custom scout watching `observer_turn_rollup` / `context_injected_rollup` volume and ratio degradation would catch silent pipeline failures before users notice worse memory quality. Create it via [Self-driving scouts](https://us.posthog.com/project/463218/inbox) if you want this coverage.
- [ ] **Consider enabling `signals-scout-install-funnel`** — A custom scout watching `install_completed` → `worker_started` → first observation would catch broken first-run flows and platform-specific regressions. Create it if install conversion becomes a priority metric.

---

## What happens next

The scout coordinator picks up fresh configs within ~30 minutes. Scouts run daily (1,440-minute interval) and emit findings as reports into the [Self-driving inbox](https://us.posthog.com/project/463218/inbox). Error tracking and session replay signals arrive sooner — they trigger on individual events as they land. Immediately-actionable reports can be turned into coding tasks directly from the inbox.
