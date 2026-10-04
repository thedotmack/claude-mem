# CCS Lock — deny-beats-allow + node-identity dedupe (two-bucket conflict)

**Date:** 2026-09-09 (overnight lock-next work, written 2026-09-10)
**Status:** RESEARCH / SPEC ONLY. No code, no `/do`, no compiler, no settings changes.
**Parent brief:** [`plans/2026-09-09-ccs-scenario-research.md`](./2026-09-09-ccs-scenario-research.md) — this locks item 1 of its "Lock next" list (scenario 6).
**Seat:** CCS Align (leaf). **Audience:** Prioritizer first, then Alex and the house.

---

## TLDR for Prioritizer (≤6 lines)

1. One underlying fact = **one node with one identity** in the DOM. Applies attach labels to that identity; they never mint a copy. Copies are the anti-pattern this lock exists to kill.
2. Buckets get a **restricting** flag. A normal bucket label is an *allow* (OR — any match shows the node). A restricting bucket label is a *gate* (AND — only its members see the node, no matter what broader labels the node also carries). Deny beats allow; empty result fails closed.
3. "Stripped view" is **not** compiler magic: it's a second, explicitly authored node (a *derived node*) carrying its own labels and a `derived-from` edge back to the full node. The edge is what makes drift detectable instead of silent.
4. Scenario 6 resolved: Alex + Prioritizer see the full email node; Barb + Admin see the authored ticket-facts node; everyone else sees nothing. Each viewer's cache packs its matching node **once**, in the band the node lives in.
5. No new levels, no new mechanism beyond one flag and one edge type. Per-viewer automatic renderings stay Phase-N.
6. Ask: PASS this as the conflict rule; parent brief's scenario 6 stops being OPEN.

---

## 1. The problem being locked

Scenario 6 of the parent brief: a customer email is both a support ticket and board-sensitive (the customer is a potential acquirer complaining about a bug). Barb's intake applies `bucket:support-inbox` (Barb + group Admin). Alex applies `bucket:board-private` (Alex + Prioritizer). Same underlying content, two applies with different intents — one is "route this to the people who work tickets," the other is "this is sensitive, keep it close."

Naive union-of-matches shows the full email — board framing included — to everyone in either audience. Naive copying makes two emails that drift. Both are wrong. This spec locks the third path.

Everything here stays inside the four locks of the parent brief: three levels only (seat / sidebar-group / house), XML/DOM spine, bucket-assign → apply-targets ACL, packing with live work after the pending timeline squeezed toward the tip.

---

## 2. What a node identity is

A **node identity** is the durable, unique ID a chunk gets when it enters the DOM — minted once, at intake, and never re-minted for the same underlying fact.

In plain terms: when the acquirer's email arrives, the intake op creates **one node** with an ID (call it `node:email-4471`). That ID is the handle for everything that ever happens to the email afterward:

- **Labels attach to the identity.** `bucket:support-inbox` and `bucket:board-private` are both attached to `node:email-4471`. Two applies, one node.
- **Annotations attach as child nodes.** Barb's triage note is a child of the email node with its own labels (`bucket:support-inbox`); the board's "handle with care, acquisition context" note is a child with `bucket:board-private`. The email text itself is never edited by either side.
- **Edges reference the identity.** A derived node (section 5), a timeline entry, a status line — all point at `node:email-4471`, not at a pasted copy of its text.

The identity is what makes "one fact appears once" checkable rather than aspirational. If two nodes exist whose content is the same fact, that's a bug in intake (or someone pasted — see anti-patterns), and the fix is: pick one identity, re-attach the other's labels and children to it, retire the duplicate.

**Dedupe rule at intake:** before minting a node, the intake op asks "does this fact already have an identity?" (same source message, same artifact, same event). If yes, attach the new labels to the existing node instead of minting. The second apply in scenario 6 — Alex marking the email board-private — is exactly this: Alex's op finds `node:email-4471` already exists and attaches a label, it does not create a board copy of the email.

---

## 3. One fact, once in the DOM

Consequences of section 2, spelled out:

- **The DOM holds the email once.** Both buckets' membership sees *the same bytes* (or an authored derivative — section 5), so there is no version skew to reconcile.
- **Applies are cheap and reversible.** Adding or removing a bucket label touches label metadata on one node. It never rewrites content, and removing an apply cleanly removes visibility — nothing to chase down and delete.
- **Multiple matches don't multiply packing.** If an agent matches a node through two tokens (say a future Prioritizer enrolled in both buckets), the node still packs **once** in that agent's cache. Match count is a boolean, not a multiplier.
- **Compile is per-viewer selection, not per-viewer rewriting.** Each agent's cache is compiled by selecting the nodes that agent's token set matches (after the deny pass, section 4) and packing each selected node once into its band. The compiler selects; it does not paraphrase. (Automatic per-viewer renderings are explicitly Phase-N — see section 8.)

---

## 4. Deny beats allow: the restricting flag

### 4.1 Two kinds of bucket label

Today every label on a node is an **allow**: visibility = "does the agent share *any* token with the node" (OR semantics). That's right for the common case and wrong for scenario 6, where the board apply carries restriction intent, not broadcast intent.

The lock: a bucket can be marked **restricting** at apply time.

- **Normal (allow) label** — OR. Any agent sharing the token sees the node.
- **Restricting label** — AND. The node is visible **only** to agents carrying that bucket's token, regardless of any other, broader labels on the node.

`bucket:board-private` is restricting. `bucket:support-inbox`, `group:building`, `house:status` are normal.

### 4.2 Evaluation order

For each node, at compile time:

1. **Allow pass:** collect every agent that matches at least one normal label on the node (plain token match, unchanged from the parent brief).
2. **Deny pass:** for each *restricting* label on the node, intersect the allow set with that bucket's members.
3. **Result:** whoever survives sees the node. If the result is empty — for example, a node carrying two restricting buckets with disjoint memberships — **nobody** sees it and the compile flags it for its owner. Fail closed, never fail open.

This is "deny beats allow" in one sentence: **one restricting label outranks any number of broad allows.** A node labeled `[house:all, bucket:board-private]` is visible to exactly the board bucket's members — the house label buys nothing against the gate. It also composes with the existing seat > group > house precedence without touching it: precedence orders *rules* in the cascade; the restricting flag gates *visibility of a node*. They answer different questions and never race.

### 4.3 Scenario 6 under this rule

`node:email-4471` carries `[bucket:support-inbox, bucket:board-private(restricting)]`.

- Allow pass: Barb, Admin members (via `bucket:support-inbox`), Alex, Prioritizer (via `bucket:board-private`).
- Deny pass: intersect with `bucket:board-private` members → **Alex + Prioritizer**.
- Barb and Admin lose the full node. They are served by the derived node instead (next section).

---

## 5. Stripped vs full vs nothing

The parent brief flagged "stripped/summary variant per viewer" as compiler territory and recommended absence. This lock keeps that recommendation but gives the stripped view an honest, no-compiler home:

**A stripped view is a second node, authored on purpose.** When Alex (or whoever the board delegates) marks the email restricting, and support still needs the facts, someone writes a **derived node**: the ticket facts — bug report, customer-visible details, needed action — with none of the board framing (no acquirer context, no negotiation posture). That node:

- has its **own identity** (`node:email-4471-ticket`),
- carries **only** the labels its audience should match (`bucket:support-inbox`),
- carries a **`derived-from` edge** pointing at `node:email-4471`.

The `derived-from` edge is the whole trick. It's what separates a derived node from a drifting copy: when the parent node changes (customer sends a follow-up, board updates the facts), the edge lets the house *flag the derivative stale* instead of letting it silently rot. Who acts on that flag is an open question (section 8), but with the edge the drift is at least visible; without it, drift is invisible until Barb replies to the customer with old facts — the parent brief's exact failure story.

**The resulting visibility table for scenario 6:**

| Viewer | Sees | Why |
|---|---|---|
| Alex, Prioritizer | **Full node** (email + board children) | Members of the restricting bucket |
| Barb, Admin members | **Derived node only** (ticket facts) | Match `bucket:support-inbox` on the derivative; denied on the full node |
| Pepper, CCS Align, Orifice*, Grok Memory, everyone else | **Nothing** | Match neither node's labels |

\* Orifice sees the ticket-facts node only if Orifice is in Admin; otherwise nothing.

Two properties worth stating plainly, Alex:

- **Nothing means absence, not redaction.** Barb's cache contains no marker saying "a board note exists about this ticket." A redaction marker is itself a leak (it advertises that something sensitive exists and roughly where). The wall is that the bytes were never packed — same principle as the sibling wall in scenario 8.
- **If nobody authors a derivative, Barb sees nothing at all.** That is the correct default. A restricting apply with no derivative means the restrictor decided support doesn't need it (or hasn't gotten to it yet). Fail closed; the fix is authoring the derivative, not weakening the gate.

---

## 6. Packing: once per matching cache

Nothing new is invented here — this section just confirms the parent brief's packing lock survives the conflict rule:

- The **full node** packs once into Alex's and Prioritizer's caches. It's an open, sensitive deliberation → **pending timeline** band.
- The **derived node** packs once into Barb's and each Admin member's cache. It's an open ticket → **pending timeline** of those caches.
- If the ticket becomes active work ("Barb drafting reply now"), that's a **live-work band** status line in `house:status` — a separate roll-up chunk, written as roll-up (no board detail), sitting after the pending timeline, squeezed toward the tip, per the packing lock.
- No cache ever contains both the full and derived node — the deny pass removes the full node from exactly the caches that hold the derivative, so there's no double-packing and no diff for a curious agent to compute.
- Label changes (adding the restricting bucket, retiring the ticket) invalidate cache from the node's band down, in the affected caches only. Cheap for pending-timeline entries, by design.

---

## 7. Anti-patterns (what this lock forbids)

1. **Two drifting copies.** One email pasted into two bucket "folders," each side annotating its own. This is the flat-concat failure wearing a bucket costume. Forbidden: any second node with the same underlying fact and no `derived-from` edge. Detection heuristic: intake dedupe (section 2); remedy: merge to one identity.
2. **Share-by-paste.** Quoting a restricted node's content into a normal-bucket chunk to route around the gate. Mechanism can't fully stop a voluntary paste (same norms boundary as scenario 8's sibling wall), but the derived-node path makes the *legitimate* version of this cheap, so the paste has no excuse. One line in house rules, not new mechanism.
3. **Redaction markers.** "\[Board-restricted content removed\]" in a non-member's cache. Forbidden — absence only, see section 5.
4. **Deny as commentary.** Marking a bucket restricting to signal importance rather than to gate visibility. Restricting is an access decision with real fail-closed consequences (empty intersection = invisible node); using it as a highlighter creates accidental blackouts.
5. **Compiler-written derivatives.** Auto-summarizing the full node into the stripped view. That's the per-viewer-rendering territory the parent brief marked OPEN and this lock parks at Phase-N. Overnight rule: derivatives are authored by someone accountable, or they don't exist.
6. **Restricting-by-default.** If every bucket is restricting, the OR fabric that makes groups and house scopes work collapses into pairwise silos. Restricting is the exception, applied at apply time, by someone allowed to (section 8, Q1).

---

## 8. Open questions

Carried honestly, not solved here:

1. **Who may mark a bucket restricting?** Recommendation to lock later: Alex always; Prioritizer for board matters; a seat may restrict only buckets it owns. Needs a PASS, not assumed here.
2. **Who authors and audits derived nodes?** The `derived-from` edge makes staleness flaggable — but who watches the flags? Natural owner is whoever applied the restriction (they created the need for the derivative). Unowned as of this writing.
3. **Restricting: per-bucket or per-apply?** This spec treats it as a property set at apply time on the bucket. If the same bucket must be restricting on one node and normal on another, that's evidence it should be two buckets — but the house hasn't hit the case yet.
4. **Double-restricted nodes.** Two restricting buckets with disjoint members → empty intersection → invisible to everyone, flagged to owner. Is silent-until-flagged good enough, or should the *apply op itself* refuse to create an always-invisible node? Leaning refuse-at-apply; needs a decision.
5. **Derivative freshness contract.** How stale may a derived node be before the flag escalates (a line in `house:status`? a block on replies?)? Related to — but not the same as — the usage-left freshness question owned by Skillex in scenario 9.
6. **Membership listing.** Who may *list* a restricting bucket's members remains the parent brief's lock-next item 5 (recommendation there: Alex + Prioritizer only, listing itself board-private). Not re-argued here; noting the two locks should land together.

**Phase-N, mention only:** per-viewer automatic renderings / compiled variants of one node; attention trough (still backlog, still not designed here).

---

*Spec by CCS Align (seat leaf) for Alex Newman / CMEM house. On PASS: parent brief scenario 6 loses its OPEN marker; this file is the conflict rule of record.*
