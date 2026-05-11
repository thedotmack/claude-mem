---
name: pr-consensus
description: Run a 3-round open-ended interview against both CodeRabbit and Greptile on a GitHub PR, then post a consensus report identifying which findings appeared independently in both bots. Use when explicitly asked to "run consensus on PR X", "cross-review PR X", "find consensus on PR X", or "what do both bots agree on for PR X". User-invoked only — do not auto-activate on generic PR review requests.
---

# pr-consensus

When two distinct LLM reviewers independently surface the same critique on a PR, you have the highest-signal possible feedback. Higher than either bot's individual review, higher than a single human reviewer's, because reviewer-style differences cancel out at the agreement layer. This skill operationalizes that finding.

## Core protocol

Both CodeRabbit and Greptile must already be installed on the repository. The skill posts identical, fully open-ended prompts to each, waits for responses, and synthesizes the cross-bot agreement.

Do not anchor the questions on specific topics — anchoring closes the aperture and produces echoed-back versions of the asker's priorities instead of the bots' actual concerns. The prompts in this skill are locked-down for that reason; do not modify them.

## When NOT to use

- The PR's bots have not yet posted initial reviews (the skill needs an initial review to follow up on).
- The user has not asked for this explicitly. This skill costs ~15 minutes of bot back-and-forth and several API calls — auto-invocation on every PR review request is wrong.
- A bot is not configured for the repository. The skill needs both bots to function.

## Pre-flight

```bash
PR=<number>
# Confirm both bots have posted initial reviews
gh pr view $PR --json reviews --jq '[.reviews[] | .author.login] | unique'
```

Expected: both `coderabbitai` and `greptile-apps` (or a comment from each). If either is missing, wait for the initial review to land before starting.

## The 3-round protocol

Post the prompts in order. Each round: post both prompts in parallel (one per bot), then wait until both bots have replied before posting the next round.

### Round 1 — open aperture

Post identical to both bots. Replace `@theirname` with the actual handle.

```text
@coderabbitai — what do you actually think about this PR? Not feedback on anything specific I might ask about; your unfiltered take. What stands out? What's right, what's wrong, what's missing, what worries you, what would you change? Tell me what you think matters most — let your priorities, not mine, lead.
```

```text
@greptileai — what do you actually think about this PR? Not feedback on anything specific I might ask about; your unfiltered take. What stands out? What's right, what's wrong, what's missing, what worries you, what would you change? Tell me what you think matters most — let your priorities, not mine, lead.
```

Wait for both replies before continuing.

### Round 2 — generic prod

```text
@coderabbitai — anything else? Whatever else stands out, whatever I should have asked you about and didn't.
```

```text
@greptileai — anything else? Whatever else stands out, whatever I should have asked you about and didn't.
```

Wait for both replies.

### Round 3 — actionable specifics

```text
@coderabbitai — what actionable changes would you make based on the feedback you gave?
```

```text
@greptileai — what actionable changes would you make based on the feedback you gave?
```

Wait for both replies.

## Waiting pattern

Use a single-shot `gh api` poll loop with `run_in_background: true`. Polling cadence: every 45 seconds. Sentinel: a timestamp captured immediately before the prompts are posted.

```bash
SENTINEL=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh pr comment $PR --body "<prompt for coderabbitai>"
gh pr comment $PR --body "<prompt for greptileai>"

until \
  cr=$(gh pr view $PR --json comments --jq "[.comments[] | select(.author.login==\"coderabbitai\") | select(.createdAt > \"$SENTINEL\")] | length") && \
  gr=$(gh pr view $PR --json comments --jq "[.comments[] | select(.author.login==\"greptile-apps\") | select(.createdAt > \"$SENTINEL\")] | length") && \
  [ "$cr" -ge 1 ] && [ "$gr" -ge 1 ]; do
    sleep 45
  done
```

Each round typically completes in 1–3 minutes total.

## Synthesis

After all three rounds complete, fetch every bot comment posted in the interview window and synthesize.

```bash
gh pr view $PR --json comments --jq "[.comments[] | select(.createdAt > \"$INTERVIEW_START\") | select(.author.login==\"coderabbitai\" or .author.login==\"greptile-apps\")] | sort_by(.createdAt)"
```

For the synthesis, treat each bot's combined output (all 3 rounds) as one body of opinion. Extract distinct claims from each — a "claim" is a specific concern, suggestion, or critique, not a stylistic flourish. Then identify *consensus*: claims that appeared independently in both bots, where "independently" means the second bot raised the same concern without that concern being mentioned in the first bot's earlier comments on the same PR.

A semantic match is enough. Both bots saying "the close reason is wrong" but one suggesting `duplicate` and the other suggesting `completed` still counts as consensus — they agreed the close reason is wrong.

## Output format — post as PR comment

Post the synthesis report as a single top-level comment on the PR. Use this structure exactly:

```markdown
## Cross-bot consensus report

**Method:** 3 rounds of open-ended interview against CodeRabbit and Greptile. Each bot answered three identical, non-leading prompts about this PR. The findings below are the consensus.

### Consensus findings (both bots, independently)

*These are the strongest-signal items. Two distinct LLM reviewers raised them without coordination and without being prompted on the topic. Treat these as the blocking concerns.*

1. **<one-line claim>** — CodeRabbit: "<short quote or paraphrase>". Greptile: "<short quote or paraphrase>".
2. ...

### Unique to CodeRabbit

*These reflect CodeRabbit's structural / methodology lens. They may still be correct, but they did not survive cross-bot independent verification.*

1. **<claim>** — <short summary>
2. ...

### Unique to Greptile

*These reflect Greptile's surgical / patch-level lens. Same caveat.*

1. **<claim>** — <short summary>
2. ...

### How to read this

The consensus section is the high-signal layer. Unique findings are not wrong, but require human judgment about whether they reflect a real issue or a reviewer-style artifact.

🤖 Generated by [pr-consensus](https://github.com/thedotmack/claude-mem/blob/main/plugin/skills/pr-consensus/SKILL.md). Method validated on PR #2409.
```

Do **not** @-mention either bot in the report — that retriggers them and corrupts the artifact. Refer to them by name only.

## Stop conditions

- All three rounds complete, both bots responded to each.
- Synthesis report posted as a top-level comment on the PR.
- The number of consensus findings is reported (could be zero — that's also a valid result).

## Failure modes

- **One bot doesn't reply within 10 minutes** — note `"<bot> did not respond within timeout"` in that round and continue. The report can still go out with whatever data was gathered, marked as partial.
- **A bot replies with "no further comments"** — that's a valid response. The round is exhausted; do not re-prompt.
- **Both bots produce zero overlap** — report the zero-consensus result honestly. It means the bots saw the PR through completely different lenses, which is itself a finding about either the PR (very narrow scope) or the bots' configurations.
- **Rate limits during the interview** — back off 5 minutes and resume; do not abandon mid-interview.
- **PR is closed/merged mid-interview** — abort and tell the user; the bots will not respond on a closed PR.

## Operational notes

- The skill validates only that *both* bots see the same problem, not that they're *right*. Consensus is a strong signal, not a proof. A human still needs to evaluate the findings.
- Bot personalities matter: CodeRabbit tends toward structural critique (adds sections), Greptile tends toward surgical critique (patches bugs). Consensus across these two styles is more meaningful than consensus across two bots of the same style would be.
- Do not vary the prompts. The locked phrasing is what produced the validated results — paraphrasing introduces anchoring effects that degrade the signal.
