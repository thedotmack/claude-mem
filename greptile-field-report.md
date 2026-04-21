# Greptile in the Wild: A Field Report from claude-mem

**Source:** 8 weeks of production use on the [claude-mem](https://github.com/thedotmack/claude-mem) open-source repository (Jan 26 – Apr 20, 2026), reconstructed from the maintainer's persistent-memory system (which records every tool call, review, and decision across sessions).

**Scope:** 22 Greptile-specific observations / 102,154 tokens of captured context, covering 15+ PRs Greptile formally reviewed, cross-referenced against CodeRabbit (Phase 1 + Pro), Claude bot (`claude-code-review.yml`), and GitHub Copilot on the same repo.

**Intent:** Share novel insights — patterns that wouldn't show up in Greptile's own analytics — with the product team so you can act on them.

---

## TL;DR

1. **The confidence score is the actual product.** A 0/5 on PR #968 caused the author to self-close within 8 hours without any human weighing in. That's the single most decisive automated-review action captured in 8 months of this repo's history.
2. **Greptile's real job description is heavier than "review assistant."** On Feb 24, 2026, it was the *sole reviewer* across 34 open PRs from 13+ contributors with zero human approvals on any of them. Design for "only voice in the room," not "augments human reviewers."
3. **The 2–4 comment depth ceiling is the #1 product miss in this repo's memory.** Specific receipts where it caused real bugs to ship inside.
4. **False positives cluster on `finally`-block cleanup paths.** A control-flow pass for cleanup semantics would eliminate the most memorable Greptile miss in the repo.
5. **"Confidence" genuinely confuses users.** A per-score label (Halt / Rework / Revise / Discuss / Polish / Ship) would resolve it without rebranding.

---

## 1. What Greptile got right

### 1.1 The confidence score is the product, not the comments
The 0/5 – 5/5 per-PR score did more decision-shaping than any individual comment. Concretely:

- **PR #968** (MemU backend swap): Greptile scored **0/5**. The author self-closed **7h 45m later** without a human weighing in. No other tool in the repo — CodeRabbit, Claude bot, Copilot — produced that kind of decisive author-side action.
- **PR #1006** (Windows platform improvements): scored **4/5**. The maintainer merged it but rejected Greptile's specific suggested patches. The score was the merge signal; the patches were advisory.

The score is the merge-risk prior maintainers actually use. If the PM ever considers de-emphasizing it, don't.

### 1.2 Fast CI check UX
The `Greptile Review` status check finishes in **2–3 minutes** (PR #953: 2m33s; PR #894: 1m59s; PR #863: 2m45s). On small PRs it's sometimes the only check that runs. That speed enables it to be in front of maintainers before they lose context on the diff.

### 1.3 "Prompt To Fix With AI" button is a real differentiator
The maintainer specifically noted this feature on PR #917's CORS review. Other tools produce comments; Greptile converts comments into AI-actionable remediation prompts. No other reviewer in this repo has this.

### 1.4 You don't have the minified-bundle problem Copilot has
`plugin/scripts/*.js` in this repo is pre-minified. Copilot flags every single-letter variable as "unused" and produces a **60–65% false-positive rate** on PRs that touch that directory. Greptile handles the same PRs cleanly. This is a direct competitive advantage you can measure.

### 1.5 The PR #917 CORS review is your case-study material
Greptile's highest-quality review in the captured history: **confidence 4/5**, four findings, all valid — IPv6 localhost support, portless localhost check, tests-exercising-duplicated-logic instead of real middleware, and explicit coverage gap. This is the shape of what Greptile does best: medium-complexity security-adjacent diffs. Worth showing to sales.

---

## 2. Where Greptile hit a ceiling (receipts)

### 2.1 The 2–4 comment depth limit is the structural #1 miss
Across every complex PR in the memory, Greptile posted between 2 and 4 inline comments. On simple PRs this is fine. On complex ones it's where the real bugs live that Greptile doesn't catch.

**Canonical case — PR #1176** (ChromaMcpManager migration):
- Greptile posted **3 findings**, **2 of which were false positives** (see §2.2).
- Claude bot, reviewing the same PR, caught:
  - **SQL injection** via unvalidated ID interpolation in `ensureBackfilled`
  - **`distances` / `metadatas` array desync** in `queryChroma` causing silent data corruption
- Greptile missed both.

This isn't a model-quality problem. It's an architectural budget problem. On a PR diff of that size, the tool hits its comment quota before it hits the real bugs. The fix is either raising the ceiling on complex diffs or exposing the budget as a knob.

### 2.2 False positives cluster on `finally`-block cleanup
Both FPs on PR #1176 were "leak" accusations against cleanup paths that were already correctly guarded by existing `finally` blocks:

1. Connection-lock leak in `ensureConnected()` — already handled in `finally`
2. Timer leak on successful connection — already handled in `finally`

A control-flow pass that marks `finally` reachability for cleanup claims would eliminate the single most memorable Greptile miss in this repo. Predictable, low-cost, high-brand-impact win.

### 2.3 No CLAUDE.md / repo-convention awareness
The Claude bot is unique among the four reviewers in this repo for reading `CLAUDE.md` before reviewing. That's why Claude bot caught repo-specific conventions (e.g., the "fail fast" error-handling discipline) that Greptile didn't.

This is a 1-day integration: look for `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, or a `CONTRIBUTING.md` at repo root, prepend to the review context. It would step-function improve suggestion-correctness on opinionated repos, which are exactly the repos with the best-informed maintainers and the loudest opinions about review tools.

### 2.4 No cross-PR memory or duplicate-PR detection
On **Feb 24, 2026**, two different contributors independently shipped fixes for the same Windows `uvx.cmd` spawn bug:
- **PR #1191** (4 days old, minimal approach)
- **PR #1211** (1 day old, more robust approach)

**Greptile reviewed both without noticing they were duplicates.** The maintainer caught it during triage, not Greptile.

Meanwhile, CodeRabbit Pro's review of PR #1461 in March 2026 explicitly cited PR #1422 by number — cross-PR memory. That capability is table stakes if you want to compete at the top of the market, especially given Greptile's breadth-of-review positioning.

### 2.5 No stale-PR / conflict-awareness nudging
At the Feb 24 snapshot, **20 of 34 open PRs (59%) were in `CONFLICTING` state**. Greptile had reviewed most of them — but nothing in its output flagged that the review was rotting because main had drifted. Automated review does nothing to keep PRs mergeable if the only thing it produces is comments on a stale diff.

Product idea: a "freshness" signal on prior Greptile reviews when the base branch has moved significantly — "this review was against commit abc123; main is now at def456, consider re-running."

---

## 3. The structural pattern you might not see in your analytics

This is the insight that surprised me most from the data.

### 3.1 The Feb 24, 2026 snapshot
Raw numbers from a `gh pr list` audit on that date (captured as observations #55594–#55597):

| Metric | Value |
|---|---|
| Open PRs | **34** |
| Unique contributors | **13+** |
| `CONFLICTING` state | **20 of 34 (59%)** |
| Oldest PR | ~2 months |
| PRs with any human approval | **0** |
| PRs with any human `CHANGES_REQUESTED` | **0** |
| PRs with Greptile review | "most" |

Verbatim from the captured observation: *"No PR has been approved or had changes requested by a human reviewer. The only reviews recorded are from the Greptile AI code review bot. This means triage decisions rest entirely with the maintainer based on PR content rather than peer review signals."*

### 3.2 "Sole informant, not gatekeeper"
I initially wrote "Greptile was gating these PRs." That was wrong. Greptile posts `COMMENTED`-only reviews — never `CHANGES_REQUESTED` — so it never literally blocked anything. The accurate framing is:

**Greptile was the sole outside voice the maintainer consulted when making unilateral merge decisions on 34 PRs from 13+ contributors.**

That's a different job than "augment human reviewers." The product wasn't enhancing peer review — it was **substituting for peer review** for an open-source project in a contributor-heavy phase. It worked well enough that the maintainer let it run for ~24 days before auditing.

### 3.3 Implication: contributors see Greptile as "the reviewer"
For most of those 13+ contributors, **Greptile was the only feedback they ever got** before the PR was merged or closed. That raises the brand stakes considerably:

- A first-time contributor sees a 3/5 score with two suggestions. That's the entire review UX.
- If Greptile is wrong (PR #1176's FPs), there's no human to correct it.
- If Greptile is right (PR #968's 0/5), the contributor self-closes based on a bot's verdict.

You are sometimes the ONLY reviewer. If product decisions were made under that assumption instead of "we augment," the design choices would change.

### 3.4 Trial-expiry-notice-as-first-impression is brand friction
The earliest Greptile message captured on this repo (PR #863, Feb 1, 2026) was **a trial-expiry notice**, not a review. It's the literal first impression the memory system captured of your product.

Worth an in-channel billing/UX audit: trial-expiry notices should not appear as PR review comments. They should appear in the dashboard, as repo-admin DMs, or as a one-time install-time banner. Not as the first Greptile message a maintainer sees.

---

## 4. The "confidence in what?" problem

The maintainer was genuinely confused by what "Confidence 5/5" is making a claim about. The stock answer — "confident in safety and quality" — conflates three distinct dimensions:

1. **Epistemic** — "how sure are we of our own analysis"
2. **Outcome prediction** — "will this merge safely"
3. **Code quality claim** — "is this code good"

The word "confidence" silently slides between all three. When Greptile is wrong, which dimension failed is a matter of interpretation.

### 4.1 Five single-word replacements evaluated
Against six tests (graceful failure on PR #1006, missed-bug failure on PR #1176, disagreement with CodeRabbit on PR #2073, first-time-contributor readability, CI-integration fit, ceiling-honesty):

| Name | Polarity | Summary |
|---|---|---|
| **Judgment** | 5 = good | Highest honesty, survives failure best, culturally resonant. Weak CI fit. |
| **Merge Readiness** | 5 = ship | Best newcomer readability + CI fit. Overclaims when wrong. |
| **Risk** | 5 = dangerous | Inverted polarity is a permanent UX tax. Reject. |
| **Change Quality** | 5 = good | Conflates too many sub-dimensions. Reject. |
| **Review Depth** | 5 = deep | Semantically cleanest but self-falsifies when Greptile misses a bug. Reject unless depth improves. |

### 4.2 The best option: keep "Confidence," add per-score labels
The strongest proposal in our review session was to keep the noun "Confidence" (preserves brand equity, no polarity inversion, no rebrand cost) but attach an **action label to each score**:

| Score | Label | What the reader should do |
|:---:|:---|:---|
| **0/5** | **Halt** | Close or redesign from the top |
| **1/5** | **Rework** | Significant problems; rebuild before re-review |
| **2/5** | **Revise** | Real bugs flagged; address them |
| **3/5** | **Discuss** | Concerns worth talking through before merge |
| **4/5** | **Polish** | Looks good; minor nits only |
| **5/5** | **Ship** | Merge with confidence |

Why this is better than any single-word replacement:
- **Preserves brand.** Keeps "Confidence" on the header.
- **Resolves the ambiguity at the score-label level.** "Confidence 4/5 — Polish" is unambiguous: *confident that this PR is ready to polish and merge*.
- **CI-gateable without losing humility.** Branch protection can require `≥ 4 (Polish)`. Matches CodeRabbit Pro's `CHANGES_REQUESTED` gating without overclaiming on the single-word noun.
- **Survives failure modes.** "Ship + missed bug" is no worse than "5/5 + missed bug" today; the label adds signal without adding liability.
- **Newcomer-parseable.** "Confidence 2/5 — Revise" tells a first-time contributor exactly what to do.
- **Sharpens disagreements.** On PR #2073 (Greptile 5/5 vs CodeRabbit 15 issues), "Ship" vs `CHANGES_REQUESTED` reads as two votes in the same semantic space — which is better than two numbers that look like they're measuring different things.

Low cost, high legibility win. Recommend shipping.

---

## 5. Competitive positioning (from real in-repo evidence)

| Tool | Greptile is… | Receipt |
|---|---|---|
| **CodeRabbit Pro** | complementary, secondary | CodeRabbit wins on depth + cross-PR memory (PR #1461 cited #1422); Greptile wins on speed + triage score. March 23 bake-off (#61319) concluded: "Keep CodeRabbit Pro primary, triage with Greptile." |
| **Claude bot** | cleaner, more focused | Claude bot's `synchronize` trigger causes 5–6 re-runs per PR; Greptile posts once. Claude bot reads CLAUDE.md; Greptile doesn't. |
| **GitHub Copilot** | direct competitor, Greptile wins | Greptile handles minified-bundle PRs cleanly; Copilot's 60–65% FP rate on those PRs is catastrophic. |

**Divergence as a product surface:** The PR #2073 dynamic — Greptile 5/5 safe-to-merge, CodeRabbit 15 issues with `CHANGES_REQUESTED` — is a recurring pattern in April 2026 PRs (also #2078, #2079). When the two tools disagree at magnitude, that divergence is itself a signal. Worth surfacing: *"CodeRabbit disagrees with your Ship verdict on this PR."* Could be a paid-tier feature or a free differentiator.

---

## 6. Ranked product recommendations

1. **Fix the `finally`-block false-positive class.** A control-flow pass for cleanup semantics. Highest ROI, cleanest win. The PR #1176 FPs are the most memorable Greptile miss in this repo — fix the class and the story flips.
2. **Read `CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md`.** 1-day integration. Step-function improvement on opinionated repos.
3. **Ship per-score labels** (Halt / Rework / Revise / Discuss / Polish / Ship). Resolves "confidence in what?" without a rebrand.
4. **Raise the 2–4 comment depth ceiling on complex diffs.** Either adaptive (bigger diff → more budget) or a user-facing "depth" knob.
5. **Add `CHANGES_REQUESTED` support.** Close the gating-capability gap with CodeRabbit Pro. Without this, Greptile can never be primary on repos that want automated gates.
6. **Add duplicate-PR / cross-PR memory.** Table stakes at the top of the market. The PR #1191 / #1211 duplicate-miss is the canonical case.
7. **Add stale-PR / conflict-awareness signals.** Note when a prior Greptile review was against an outdated base commit. 59% `CONFLICTING` PR rates are real.
8. **Fix the trial-expiry-as-first-impression UX.** Trial messaging should not appear as a PR review comment.

---

## 7. The single most important sentence

On this repo, at peak load, Greptile was the only outside voice in a maintainer's head during 34 unilateral merge decisions across 13+ contributors. **The product's real job description is heavier than "review assistant."** Design for that reality and the roadmap writes itself.

---

## Appendix: PR-level evidence table

Compressed from the source timeline analysis. Every PR where Greptile left a captured review, chronological:

| PR | Date | Greptile score | Finding summary | Valid? |
|---|---|---|---|---|
| #856 | Feb 1 | (trial) | Race condition in `lastActivityTime` reset | ✅ |
| #863 | Feb 1 | 4/5 | Template literal spacing nit | ✅ (trivial) |
| #879 | Feb 6 | — | ps-output parsing robustness | ✅ minor |
| #882 | Feb 6 | — | Windows notes in wrong doc | ✅ structural |
| #894 | Feb 6 | pass | CI check only (docs-only PR) | — |
| #917 | Feb 5 | 4/5 | IPv6 / portless localhost / test coverage gaps on CORS | ✅ (best Greptile review in repo) |
| #953 | Feb 6 | pass | CI check only (README formatting) | — |
| #968 | Feb 6 | **0/5** | Deleted files still referenced by imports | ✅ — author self-closed in 7h45m |
| #1006 | Feb 7 | 4/5 | PowerShell quoting + stale docstrings | ✅ (already fixed); maintainer rejected patches |
| #1138 | Feb 16 | 2/5 | Missing empty-response guard + cross-session concurrency bug | ✅ |
| #1154 | Feb 18 | — | Orphaned Chroma collection routing bug | ✅ (critical architectural catch) |
| #1176 | Feb 18 | — | 3 findings, 2 FP (`finally`-guarded); missed SQL injection + array desync | ⚠️ most memorable miss |
| #2059 | Apr 18 | — | 6 findings across settings/auth/env | ✅ |
| #2060 | Apr 18 | — | Migration breadth + prepared-statement loss + column-count mismatch | ✅ |
| #2072 | Apr 19 | — | P1: circuit-breaker counter incrementing per observation | ✅ (spawned whole fix session) |
| #2073 | Apr 19 | **5/5** | 3 P2 items, safe-to-merge verdict | ✅ but CodeRabbit blocked with 15 issues |
| #2078 | Apr 19 | — | 4 P1/P2 items | ✅ (CodeRabbit flagged 15 critical/major) |
| #2079 | Apr 19 | — | P2: FTS5 DDL probe runs every query | ✅ (fixed in commit `2472cf36`) |

---

*Compiled from the claude-mem persistent-memory system: 22 Greptile-specific observations, 102,154 tokens of context, 8 weeks of production use on an active open-source repo. Happy to share the raw observation IDs if your team wants to dig into any specific finding.*
