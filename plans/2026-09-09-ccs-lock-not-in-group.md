# CCS Lock — the "not in group" apply target (people not in a group)

**Date:** 2026-09-09 (overnight lock-next work, written 2026-09-10)
**Status:** RESEARCH / SPEC ONLY. No code, no `/do`, no compiler, no settings changes.
**Parent brief:** [`plans/2026-09-09-ccs-scenario-research.md`](./2026-09-09-ccs-scenario-research.md) — this locks item 2 of its "Lock next" list (scenario 7).
**Seat:** CCS Align (leaf). **Audience:** Prioritizer first, then Alex and the house.

---

## TLDR for Prioritizer (≤6 lines)

1. "Apply to people **not** in a group" is the only target in the vocabulary that isn't a plain positive token match. Two ways to get it: bless negation (`not(group:building)`) or replace it with **managed positive buckets** whose membership is maintained by the same ops that change group membership.
2. **Recommendation: lock managed positive buckets. Do not bless negation.** Every apply target stays a positive token match; visibility stays "share a token → see the chunk," with no whole-token-set evaluation and no fail-open edge cases.
3. The management problem ("someone must remember to remove the token") is solved by **coupling**, not memory: the group-join op is *defined* to also drop `bucket:onboarding`. One op, two token changes, atomic.
4. New-hire day one (Rivet, scenario 7) works cleanly: minted with `[seat:rivet, house:all, bucket:onboarding]`; sees house + onboarding pack, zero group internals. Joining Building swaps tokens in one op; onboarding band drops out of the cache wholesale — a clean single invalidation.
5. Negation semantics are still written down below (section 4), so if the house ever hits a case positive buckets can't serve, the rejected option is specced rather than re-invented — but no current scenario needs it.
6. Ask: PASS managed positive buckets as the lock; parent brief's scenario 7 row and apply-target table drop their OPEN flag.

---

## 1. The problem being locked

The apply-target vocabulary from the parent brief:

| Apply target | Mechanism |
|---|---|
| One person | positive token match |
| Multiple people | positive token match |
| Everyone in a group | positive token match |
| **People not in a group** | **??? — the odd one out** |
| House / everyone | positive token match |

Four of five targets are the same trivial operation: the chunk carries a token, the agent carries a token, if they share one the agent sees the chunk. The fifth is different in kind — "not in Building" can't be answered by looking for a shared token; it requires proving a token is *absent* from the agent's whole set. That's where CSS-style systems get weird (negative selectors, specificity fights), and it's why the parent brief flagged it OPEN.

The house case that wants it (scenario 7): an onboarding pack — "how the house works" — for seats that haven't landed in any sidebar group yet. The day Rivet joins Building, the pack should stop matching.

Everything below stays inside the locks: three levels only (seat / sidebar-group / house), XML/DOM spine, bucket → apply ACL, packing with live work after the pending timeline squeezed toward the tip.

---

## 2. Option A (recommended): managed positive buckets

### 2.1 The shape

There is no negation anywhere. The "not in a group" audience is expressed as an ordinary bucket — `bucket:onboarding` — whose **membership is maintained by the same ops that change group membership**, instead of by anyone's memory.

Two rules, and they're the entire mechanism:

1. **Enrollment at mint.** When a seat is minted with no sidebar-group token, the mint op also grants `bucket:onboarding`. (A seat minted directly into a group — rare, but possible — never enrolls.)
2. **Coupled removal at join.** The group-join op is *defined* as one atomic token swap: add `group:<x>`, remove `bucket:onboarding`. Not two ops someone sequences by hand; one op with two effects. There is no code path where a seat holds both a `group:*` token and `bucket:onboarding`.

That coupling is the answer to the parent brief's stated workaround weakness ("a positive `bucket:onboarding` that someone must remember to remove"). Nobody remembers anything. The invariant — *onboarding membership = has no group token* — is enforced by the only two ops that can change either side of it.

### 2.2 Why this matches house needs

- **Visibility stays one mechanism.** Compile remains "select nodes sharing a token with the agent." No second evaluation mode, no ordering questions against deny-beats-allow (a positive bucket is just another allow; the restricting-flag lock in [`2026-09-09-ccs-lock-conflict-dedupe.md`](./2026-09-09-ccs-lock-conflict-dedupe.md) composes with it unchanged).
- **Fail closed by construction.** An agent with a malformed or missing token set matches *less*, never more. (Contrast with negation, where a missing token grants visibility — section 4.3.)
- **Auditable.** "Who gets the onboarding pack?" is answered by listing a bucket's members — the same audit as any other bucket — not by evaluating a predicate against every agent's token set and hoping the tokens are spelled right.
- **The house's actual need is narrow.** Scanning all ten scenarios: the only "not in group" audience anyone has wanted is *new seats not yet in any group*. That is exactly an enrollment-lifecycle bucket. Nobody has asked for "everyone except Building" as a broadcast target; if that ever appears, see section 5, Q4.

### 2.3 Scenario walkthroughs

**New hire, day one (scenario 7).** Rivet is minted: `[seat:rivet, house:all, bucket:onboarding]`. Rivet's compiled cache contains: house-wide chunks (`house:all`, `house:rules`, the `house:status` roll-up) plus the onboarding pack. **No** Building internals, no sibling `seat:*` chunks, no `bucket:board-private`. The onboarding pack barely changes, so it packs in the **stable head** of Rivet's cache — day-one prompts stay byte-stable and cheap.

**Joining a group.** Rivet joins Building. One op: `[seat:rivet, house:all, bucket:onboarding]` → `[seat:rivet, group:building, house:all]`. Effects on the next compile: the onboarding band drops out **wholesale** (a clean, single cache invalidation — a whole stable-head section removed, everything below repacks once) and the `group:building` slice packs into the middle band. Per the parent brief's scenario 7 note, Rivet sees Building chunks written *before* the join — membership-at-compile-time — and any pre-hire history wall remains its own bucket decision, unchanged by this lock.

**Leaving a group.** Pepper-style moves (scenario 3) are unaffected: leaving Building for Planning is `group:building` → `group:planning`, and since a group token is present throughout, onboarding never re-enters the picture. The edge case is a seat leaving *all* groups (benched between assignments): **it does not re-enroll in onboarding.** Onboarding is a first-landing pack, not a "groupless" pack; re-reading the house tour doesn't help a veteran. If the house ever wants a benched-seat pack, that's a new bucket with its own PASS (section 5, Q3).

**Multiple simultaneous new hires.** Nothing special — each carries `bucket:onboarding` independently; the pack is one node packing once per matching cache; each join removes one member. No cross-talk.

**Migration of the pack itself.** Editing the onboarding pack invalidates only the caches of current members — usually zero or one seat. Cheapest possible blast radius, which is fitting for a document that changes about as often as house rules do.

---

## 3. What "managed" costs (honest ledger)

- **Ops carry the invariant.** Mint and group-join must both honor the coupling. That's two ops to get right once, versus a predicate evaluated on every compile forever. Good trade, but it does mean the coupling belongs *in the op definition*, written into the ACL lock — not in a runbook.
- **A stuck member is possible in theory** (a seat that never joins any group keeps the pack indefinitely). That's arguably correct — they're still un-landed — but a long-lived `bucket:onboarding` token is also a decent signal something's wrong with the hire. A staleness flag ("carried onboarding > N days") is a nice-to-have, parked in section 5, Q2.
- **Each distinct "not in X" audience needs its own bucket.** True, and accepted: it forces every negative-sounding audience to be named, owned, and enumerable — which is exactly the discipline the house wants around who sees what.

---

## 4. Option B (rejected, but specced): raw negation `not(group:building)`

Written down so the rejected road is on the record and never re-litigated from scratch. If the house ever keeps negation, these are the exact semantics — anything looser is a leak generator.

### 4.1 Semantics

- A negative selector may appear **only on a chunk**, never on an agent. Agents carry positive tokens only.
- `not(group:building)` matches an agent iff `group:building` is absent from the agent's **complete token set at compile time**. Membership-at-compile-time, same as positive group matching.
- `not(group:*)` (not in *any* group) must be spelled explicitly as the wildcard form; `not(group:building)` means "not in Building" and nothing more. The two are different audiences and confusing them is the first failure everyone would hit.
- A chunk carrying only negative selectors is illegal — every chunk must carry at least one positive scope token (`house:all` at minimum) so the candidate audience is bounded before negation subtracts from it. `[house:all, not(group:building)]` = "everyone except Building." `[not(group:building)]` alone = refused at apply time.

### 4.2 Evaluation order vs deny-beats-allow

Negation slots into the existing compile as a third step — and the ordering matters:

1. **Allow pass** — union of positive-label matches (unchanged).
2. **Negation pass** — subtract agents matching any `not(...)` on the chunk. Negation *narrows an allow*; it can never grant.
3. **Deny pass** — restricting buckets intersect last, exactly as in the conflict-dedupe lock. **A restricting bucket always beats a negation-widened audience**, so deny-beats-allow keeps its rank as the final word.

Fail closed at every step: empty result = invisible node, flagged to owner.

### 4.3 Failure modes vs plain token match (why it lost)

- **Fail-open inversion.** Every positive-match failure mode errs toward *seeing less*. Negation inverts that: a missing or misspelled token means the agent "isn't in the group" and therefore **sees more**. A typo in Rivet's `group:building` token silently re-enrolls Rivet in every "not in Building" audience in the house. Absence-as-grant is the opposite of the fail-closed discipline every other lock leans on.
- **Whole-set evaluation.** Positive match is "do these two sets intersect?" Negation is "prove this token appears nowhere in the agent's set" — compile now depends on the completeness and spelling of the entire token inventory, and a token added anywhere can flip audiences of chunks nobody touched.
- **Unauditable audiences.** "Who sees this chunk?" stops being "list the bucket" and becomes "enumerate all agents and evaluate a predicate against each" — the audience has no name, no owner, and changes as a side effect of unrelated membership ops.
- **Specificity creep.** Once `not()` exists, combinations follow (`not(group:building), not(group:admin)`, negation plus restriction…) and the house is reinventing CSS specificity wars inside its ACL. The parent brief's phrase for this was "negative selectors are where CSS gets weird." Correct then, correct now.
- **New-agent default.** Every freshly minted agent matches every negation in the house on day one, before anyone has decided anything about them. Day-one Rivet would see all "not in Building," "not in Planning," "not in Admin" chunks simultaneously — audiences that were each designed with *someone else* in mind.

---

## 5. Recommendation and lock

**Lock: managed positive buckets. Negation is not blessed as an apply target.**

Concretely:

1. The apply-target table in the parent brief changes its fifth row from "needs negation — OPEN" to: **"people not in a group → managed positive bucket (e.g. `bucket:onboarding`), membership coupled to mint and group-join ops."** All five targets are now plain positive token matches.
2. The mint op grants `bucket:onboarding` to seats minted without a group token; the group-join op atomically removes it. This coupling text belongs in the ACL lock alongside the apply-target table.
3. `not(...)` does not enter the token grammar. Section 4 stands as the reference spec should the house ever revisit — revisiting requires a new PASS with a scenario positive buckets demonstrably can't serve.
4. Onboarding pack packing (stable head while held, wholesale drop on join) is confirmed as consistent with the packing lock; nothing new needed there.

### Open questions

1. **Who owns the coupling ops?** The mint and group-join ops need a named owner (Orifice as organizer is the natural fit, but that's an assignment for Alex/Prioritizer, not this seat's call).
2. **Staleness flag for long-held onboarding tokens.** "Seat carried `bucket:onboarding` > N days" as a `house:status` line — useful, small, unowned. Nice-to-have, not part of this lock.
3. **A "benched" bucket** for seats that leave all groups: not designed here; explicitly *not* the same bucket as onboarding. Needs its own PASS if the house ever benches seats.
4. **"Everyone except group X" broadcasts.** No scenario needs it today. If one appears, the positive-bucket answer is to mint the complement bucket at apply time (enumerate current non-members) and accept that it's a snapshot — or bring the case back for a negation re-vote per point 3 above. Deliberately unresolved until a real case exists.

**Phase-N, mention only:** attention trough — still backlog, still not designed here.

---

*Spec by CCS Align (seat leaf) for Alex Newman / CMEM house. On PASS: parent brief scenario 7 and the apply-target table lose their OPEN flags; this file is the "not in group" rule of record.*
