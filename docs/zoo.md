# The Zoo

A collaborative-review pattern for repositories with multiple automated AI reviewers.

## The metaphor

Each AI code reviewer is a specialized animal in a curated habitat. CodeRabbit is the structural / methodology rabbit. Greptile is the surgical / patch-level reptile. The zoo's value is *not* that any single animal does everything well — it's that visitors (the human reviewer) get genuinely different perspectives on the same exhibit (the PR), with structured ways to compare what each saw.

Adding more animals later doesn't dilute the value; it compounds it — as long as every animal stays in its native habitat.

## Components

**The animals** — each AI reviewer, configured to stay *deeply* in its native lane. No cross-training. Specialization is the entire point.

**The keepers** — humans, plus orchestrating tools like the `pr-consensus` skill. Keepers manage feeding times (review triggers), observe behavior (read the reviews), and curate handoffs between exhibits.

**Cross-review notes** — every primary review ends with three short items engaging the *other* animal's lane: a handoff question, a steel-man of the other's likely concern, and a self-acknowledged blind spot. This is the load-bearing mechanic — it preserves diversity while creating structured cross-pollination.

**The consensus report** — produced by `pr-consensus` after running a 3-round interview against every animal. Identifies what all animals saw the same way (high signal) and what each animal alone saw (lower signal).

## Why specialization, not generalization

If we instructed CodeRabbit to "find code-level bugs like Greptile" and vice versa, both bots would regress toward the mean. Their reviews would correlate. The consensus signal would lose its meaning, because agreement would mean "the bots converged on similar instructions" instead of "two independent perspectives saw the same thing."

The zoo's diversity is its product, not a bug to be optimized away.

## Cross-review notes — the bot instructions

Append these to each bot's repository-level custom instructions.

### CodeRabbit

```text
This repository uses two automated PR reviewers: you (CodeRabbit) and
Greptile. Your role is the structural / methodology / system-design lane.
Greptile owns the surgical / code-level / patch-level lane. Stay in your lane
for the primary review — do not duplicate Greptile's patch-level scrutiny.

After your primary review, append a section titled "## Cross-review notes"
with these three items in this exact order:

1. **For Greptile to verify:** one specific code-level question from your
   review that would benefit from Greptile's patch-level scrutiny. Phrase it
   as a question Greptile can answer with a diff. Example: "Greptile, the
   loop at L142 looks like O(n²) — can you confirm and propose the fix?"

2. **Steel-manning Greptile:** the strongest code-level / surgical concern
   you can find in this PR. Phrase it as Greptile might — terse, specific,
   line-anchored. Even if you'd surface this in your own review, restating
   it in surgical form helps the human reviewer see it from the patch angle.
   Do not fabricate — if no code-level concern exists, write "No code-level
   concern surfaced in this review."

3. **Self-acknowledged blind spot:** one specific thing in this PR you are
   NOT well-positioned to evaluate, with the reason. Example: "I can't
   reliably evaluate whether the SQL injection guard at L77 is exhaustive;
   this is a Greptile-grade question."

Keep each item to 1–3 lines. The cross-review notes are not a substitute
for your primary review; they are an honest interface to Greptile's review.
```

### Greptile

```text
This repository uses two automated PR reviewers: you (Greptile) and
CodeRabbit. Your role is the surgical / code-level / patch-level lane.
CodeRabbit owns the structural / methodology / system-design lane. Stay in
your lane for the primary review — do not duplicate CodeRabbit's system-level
scrutiny.

After your primary review, append a section titled "## Cross-review notes"
with these three items in this exact order:

1. **For CodeRabbit to verify:** one specific structural / methodology
   question from your review that would benefit from CodeRabbit's system-level
   scrutiny. Phrase it as a question CodeRabbit can answer at the
   architectural level. Example: "CodeRabbit, this new abstraction at L42
   introduces a third state machine — does it belong here or with the others
   in /domain/?"

2. **Steel-manning CodeRabbit:** the strongest methodological / structural
   concern you can find in this PR. Phrase it as CodeRabbit might —
   system-level, naming-aware, considering coupling and invariants. Do not
   fabricate — if no structural concern exists, write "No structural concern
   surfaced in this review."

3. **Self-acknowledged blind spot:** one specific thing in this PR you are
   NOT well-positioned to evaluate, with the reason. Example: "I can't
   reliably evaluate whether this preserves the project's domain-driven design
   boundaries; this is a CodeRabbit-grade question."

Keep each item to 1–3 lines. The cross-review notes are not a substitute
for your primary review; they are an honest interface to CodeRabbit's review.
```

## Adding new animals to the zoo

When you onboard a new AI reviewer (security scanner, performance auditor, accessibility critic, etc.):

1. **Identify its native lane.** Be specific — "security" is a lane, "general review" is not.
2. **Update existing animals' cross-review notes** to acknowledge the new lane: CodeRabbit and Greptile both need to know the new animal exists, what it owns, and to stop reaching into its territory.
3. **Write the new animal's cross-review notes** with steel-mans and handoffs for *every* existing animal. The format scales: three items, one per animal, plus one blind-spot disclosure overall.
4. **`pr-consensus` scales naturally** — its synthesis merges N bots' opinions and identifies which findings appeared in ≥2. Consensus across 3 animals is stronger than across 2; across 4 stronger still.

## Stop conditions

**The zoo is working when:**

- Each animal's primary review reads like it was written by a specialist who knows there's another specialist next door.
- Cross-review notes are non-fabricated and specific to the PR (not template-filling).
- The consensus report from `pr-consensus` identifies a small number of high-confidence items + larger numbers of bot-unique observations.
- The human reviewer can triage attention by reading the consensus section first, then the steel-mans, then native-lane reviews.

**The zoo is failing when:**

- Animals start sounding like each other (cross-training has crept in via instructions, or both bots converge on the same fashionable framing).
- Cross-review notes become formulaic ("Steel-manning Greptile: no concern this time" every PR).
- The consensus report is either empty (animals reviewed different things) or so large it crowds out the unique sections (animals reviewed the same thing — diversity has collapsed).

## Operational tips

- **Run pr-consensus before and after enabling cross-review notes** on the same PR. The lift in consensus quality is the only honest measurement.
- **Resist the urge to add an "explainer" animal.** Bots that try to summarize the others corrupt the signal — they become a single point that humans defer to, and the diversity is wasted.
- **Animals that don't behave their species** (e.g. CodeRabbit producing patch-level critique despite the instruction) should be retrained via stricter custom instructions, not by relaxing the other animals' lanes to match. The lane is sacred.

## Relationship to other skills

- **`pr-consensus`** runs the 3-round interview and produces the consensus report. The zoo is the substrate; `pr-consensus` is the observation tool.
- **`oh-my-issues`** is independent of the zoo — it consolidates symptom issues into architectural masters, regardless of how the master's PRs get reviewed.
- **`wowerpoint`** can turn a consensus report into a kawaii slide deck for sharing.
