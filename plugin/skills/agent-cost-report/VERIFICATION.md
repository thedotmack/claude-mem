# Verification — agent-cost-report rebuild (Phase 8, 2026-09-26 PT)

Plan: `plans/2026-09-25-agent-cost-report-weekly.md`. Branch `work/cost-report-weekly`. All runs on the box with the read-only DB snapshot; the live DB mtime was unchanged by every run (`2026-09-26 04:56:43 -0700` before and after). 117 unit tests passed at Phase 8; 133 after the review round (§8.8).

## 8.1 Research window (Sep 18 → 26 PT exclusive, saved price snapshot)

The research figures in the plan were measured on 2026-09-25 around 4 PM PT, before Sep 25 finished. The transcripts and the database have grown since (802 → 1,409 assistant replies). To compare like for like, the reference script (`/workspace/weekly-cost-workflow/weekly_report.py`) was re-run on 2026-09-26 in a scratch copy against today's data; that column is the real target.

| Number | Rebuilt (today) | Reference script, re-run today | Research (Sep 25 4 PM) | Tolerance | Verdict |
|---|---|---|---|---|---|
| sessions (claude-mem) | 98 | 98 | 80 | ±2 | exact vs reference |
| real-work sessions | 65 | 65 | 47 | ±2 | exact |
| projects | 31 | 31 | 23 | ±1 | exact |
| devices | 3 | 3 | 3 | exact | exact |
| finished outcomes | 40 | 40 | 26 | ±1 | exact |
| ship events | 10 | 10 | 5 | exact | exact |
| agent hours | 20.0 | 20.0 | 13.8 | ±0.3 | exact |
| measured tokens (box) | 147,412,369 | 147,412,369 | 81,783,140 | ±0.5 % | exact |
| agent estimated USD (saved prices) | $216.68 | $216.68 | $109.25 | ±0.5 % | exact |
| extrapolated USD | $67.35 | $67.34 | $54.69 | ±2 % | rounding |
| observer (note-taker) USD | $9.30 | $9.30 | $5.84 | ±2 % | exact |
| total estimate | $284.03 | $284.02 | $163.94 | — | rounding |

Drift against the Sep 25 research numbers is entirely data growth after the research snapshot (Sep 25 continued for another eight hours, plus this rebuild's own sessions); the rule set reproduces the reference script to the cent on the same data. Fresh prices (fetched 2026-09-26): OpenRouter now lists an explicit 1-hour cache-write price for `anthropic/claude-fable-5.1` equal to the old 2× input rule, so the fresh-price run gives the same headline.

In addition to the 98 claude-mem sessions, 12 transcripts on the box match no claude-mem session (Codex rollouts and scratch sessions). They are counted in the totals (as before) and, new in this rebuild, appear as their own line items (`transcript_only_sessions`, status `in_progress`, outcome unknown), so line items, ribbon, sidebar and hero reconcile: Σ line items = $284.03 = $216.68 + $67.35.

## 8.2 Other scopes

- `--session <one session with a transcript>`: 1 line item, $27.55, renders.
- `--project claude-mem --start 2026-09-18 --end 2026-09-26`: 28 sessions (worktrees included), $92.07 estimated, 2 wins, renders.
- default window on 2026-09-26: `start_pt=2026-09-19`, `end_exclusive_pt=2026-09-26`, `partial_last_day=false` (G3: last 7 full PT days, today excluded).

## 8.3 Anti-pattern greps

All pass: `discovery_tokens` only on observer (note-taker) lines; "Measured provider spend" never followed by a dollar figure in any of the three reports; no cent sign or cents formatter in `scripts/`, `SKILL.md` or the HTML; two decimals on every dollar figure outside quoted excerpts; no `sk-or-`, `Bearer ` or key material in any output; no `<script>`, `<link>`, `@import`, or external `url(`/`src=`; live DB mtime unchanged.

## 8.4 Visual check

`/tmp/acr-weekly/p8/report.png` (Chrome headless, 1440×1400) against `/workspace/timing-report-brief/mockup.png`: window frame, sidebar (six kinds of work, sessions, models, "Grok Bot usage: unavailable"), date pill, hero with ESTIMATE tag and basis, Wins vs mistakes card with the two timelines, cost ribbon with legend, the three cards (donut, day by day, useful ring with the behavior strip), What got done, Worth your attention, footer, folded Details. Section order matches the brief. PDF: `report.pdf` (1.8 MB, text extractable).

## 8.5 Behavior metrics spot-check (seed 7, `behavior-spotcheck.md`, reviewer: the orchestrating Claude session; excerpts stay in the run directory, not in git)

- **Human/bot tag (R2):** 20 human-tagged turns: 19 are Alex's own words, 1 is a relayed job prompt ("Resume the hub-email lane …"). 19/20 meets the bar. 20 bot-tagged turns: 18 clearly agent or harness, 2 unsure (a pasted note and a "fyi correction" inside a relayed session). Two more relay shapes found in the sample (third-person "Alex asked …", long briefs addressed "You are …") were added to the marker list; human-tagged turns went from 91 to 89.
- **Precision per tile** (`verification/precision-2026-09-26.json`):

| Pattern | Checked | True | False | Unsure | Precision | Placement |
|---|---|---|---|---|---|---|
| P1 invented gates | 1 of 1 episode (E129/E066 session) | 1 | 0 | 0 | 100 % | tile |
| P6+P7 made it up / false done | 20 of 33 flagged turns | 0 | 12 | 8 | 0 % confirmed (≤40 % counting unsure) | **moved to Details, low confidence** |
| P2 broke working things | 1 of 1 episode (E135) | 1 | 0 | 0 | 100 % | tile |
| P3 wrong or expensive model | 1 episode (E096), no box turns | — | — | — | none found on the box | tile ("unmeasured" for the Mac episode) |

  The false-done detector fires on "done / verified / confirmed" in final messages of research and planning sessions where no test or deploy proof is expected; every checked hit was either a true statement verified by ordinary commands (md5sum, git log) or a plan/research wrap-up. It stays in Details until the proof rule accepts read-only verification commands or a classifier confirms it. The first alternate (P4 over-engineering) had no flagged turns, so the summary strip has three tiles.
- **Unflagged sessions:** 10 checked; no obvious misses (the only notable last message was a harness login-refresh error, which is not an agent mistake).
- **S1 tool errors:** 73 `is_error` results minus 3 permission denials = 70 on 110 transcript files, against the 2B.7 probe of 54 on 78 files taken on Sep 25 before the day ended. Same rate per file (0.64 vs 0.69). Text-matched errors add up to 155 chains; text matches are marked medium confidence.
- **Invariants:** `union_low ($30.75) ≤ union_high ($32.30) ≤ agent_estimated + extrapolated ($284.03)`; every behavior dollar in the HTML carries an ESTIMATE tag; the strip has ≤4 tiles; P9 bad outbound: 0 incidents, no dollars; unmeasured episodes render "unmeasured"; no secrets in `behavior.json`, `evidence.json` or the HTML.
- **Rule effectiveness:** rules landing inside or within 7 days before the window are listed with their denominators; every row is `not_enough_data` because the before side has fewer than 50 human prompts on the box (the window starts Sep 18). The Sep 10 invented-gates rule is outside this window; a Sep 3–17 run would need Alex's Mac prompts, which only cover Sep 18–19 here.
- **Classifier:** not run (off by default, G8).

## 8.6 Wins vs mistakes reconciliation

`mistakes_estimated_usd = $30.75` = Σ line-item `wasted_cost` = ribbon `data-waste-usd` = Σ `timeline.mistakes_by_day.usd` (to the cent, after largest-remainder rounding across line items). High figure $32.30 ≥ low. Wins: 3 merged PRs, cost status `unmeasured`, timeline dot counts sum to 3. Every `#win-` and `#mistakes-` link resolves to a Details entry.

**Wins gap (plan 2.8 expected ±3 of 20):** GitHub lists 14 merged `thedotmack/claude-mem` PRs for Sep 18–25 (`gh pr list --state merged`, read-only). Box transcripts contain merge commands for only three PRs in other repos; the 14 claude-mem merges were done off-box (Alex's Mac or auto-merge), and only #4125 and #4128 have ship observations. So the plan's two sources see 3 wins. Adding a read-only `gh pr list --state merged` source would close the gap; that is a scope decision for Alex, not made here.

## 8.7 Comparison with Frustration Arc's last 7 days

Frustration Arc (`/workspace/frustration-arc/costs.md`): 13 episodes, 8 unmeasured, $6.70 low – $14.43 high (its dollars price `discovery_tokens` at Opus input; this report never prices `discovery_tokens` as agent cost, so dollars compare loosely).

| Frustration Arc episode | Found here (time ±15 min) | Pattern here | Match |
|---|---|---|---|
| E135 2026-09-18 11:34 broke_things | 11:34 | P2 broke things | yes |
| E096 2026-09-18 12:28 wrong_model_or_spend | 12:28 | P3 wrong model | yes |
| E066 2026-09-18 17:07 invented_gates_asking | 17:07 | P1 invented gates | yes |
| E129 2026-09-18 17:11 invented_gates_asking | 17:11 | P1 invented gates | yes |
| E067 2026-09-18 22:51 fake_or_invented (also jargon, ignored) | 22:51 | P7 false done | pattern differs (tie between P6 and P7 phrases resolved to P7) |
| E091 2026-09-19 23:50 overengineering (also fake) | 23:48 episode start | P4 over-engineering | yes |

6 of 6 found; 5 of 6 match a Frustration Arc category (≥5 required). All 6 are Alex-typed Mac prompts synced into the box's claude-mem, so they are `unmeasured` without the Phase 5 Mac export (Frustration Arc: 8 of 13 unmeasured). Three extra episodes were found that Frustration Arc did not list: two on Sep 18 (11:35 and 23:13, both long relayed briefs the tagger still treats as human) and two short "stop" messages on Sep 19 23:21–23:25 (P12 unclear). M01–M07 (Sep 21–25) are outside the report's sources (rebuilt from rule files and an agent-written transcript; the R2 filter drops relayed text and R1 retention is missing) and are not counted, as the plan specifies. Low dollars: all found episodes are unmeasured, so the Mac share of the mistakes line is "unmeasured", never $0; the $30.75 low figure comes from box-side detector hits (tool errors, jargon follow-ups, false-done candidates) that Frustration Arc's study did not cover.

## 8.8 Re-verification after the PR #4238 review fixes (2026-09-26 06:05 PT, head 5d173e6 + `--help` fix)

The Bugbot and Greptile fixes touched three inputs to the headline (usage rows clipped to the PT window, Codex token counts taken as per-event growth instead of the last cumulative total, device-export rows outside the window skipped). The Sep 18 → 26 run was repeated on the current head with the same saved prices, the same precision file and the Phase 8 DB snapshot (`/tmp/acr-weekly/p8/snapshot.db`, backup-copied to `p8b/`); transcripts were re-collected because the Codex reader changed. Live DB mtime unchanged before and after (`2026-09-26 06:02:18`).

| Number | Phase 8 (05:03) | After fixes (p8b) | Research target |
|---|---|---|---|
| box estimated USD | $216.68 | $216.68 | $109.25 |
| Mac extrapolated USD | $67.35 | $67.35 | $54.69 |
| note-taker USD | $9.30 | $9.30 | $5.84 |
| total estimate | $284.03 | $284.03 | $163.94 |
| sessions / finished / ships | 98 / 40 / 10 | 98 / 40 / 10 | 80 / 26 / 5 |
| measured tokens | 147,412,369 | 147,412,369 | 81,783,140 |
| mistakes low / high | $30.75 / $32.30 | $30.75 / $32.30 | Frustration Arc $6.70 / $14.43 |
| behavior episodes / unmeasured | 9 / 9 | 9 / 9 | Frustration Arc 13 / 8 |

Every dollar, token and count figure is unchanged, so the drift against the research targets is still data growth (§8.1) and the Frustration Arc comparison in §8.7 stands (6 of 6 listed episodes found, M01–M07 outside the sources). What did move, none of it in the headline:

- `usage.json` rows 1,409 → 1,444: the four Codex sessions now contribute 39 per-event rows instead of 4 last-cumulative rows, same 2,803,076 tokens and $4.64. All four started inside the window, so nothing was subtracted; Sep 24 shows 538 API calls instead of 503 (Sep 25 unchanged). `window.usage_rows_outside_window = 0`, as expected for a collect run with the same window.
- Human/bot tags 89 / 234 → 94 / 229: five prompts in interactive sessions that carried a lone agent marker later in the session (slash-command output, a pasted notice) are now tagged human; none of them starts an episode, so the mistakes line and the union are unchanged.
- Line items carry `cost_status` (52 estimated, 58 extrapolated, 0 unmeasured: the box has a ratio); per-day `finished_outcomes` sum to the headline 40 and are recomputed by `aggregate()` after review.
- `report.html` re-rendered from p8b: no "Measured provider spend" followed by a dollar, no cent sign, two decimals on every dollar outside excerpts, no script/link/external URL, no key material, no `$0.00 EXTRAPOLATED`.

## Gated steps not run

Merge to `main`, npm publish, `/version-bump`, the OpenRouter key path (key not present on the box; exercised only through mocked tests), the Mac export (nothing ran on the Mac), and the classifier.
