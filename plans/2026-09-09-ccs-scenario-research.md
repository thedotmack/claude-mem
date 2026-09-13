# CCS Scenario Research — bucket → apply targets, 3 levels, packing

**Date:** 2026-09-09
**Status:** RESEARCH ONLY. No code, no `/do`, no compiler, no settings changes. Scenario exercise for the locked CCS model.
**Seat:** CCS Align (leaf). Plan of record: [`plans/2026-09-09-ccs-align.md`](./2026-09-09-ccs-align.md).
**Audience:** Prioritizer first (TLDR below), then Alex and the house.

---

## TLDR for Prioritizer (≤8 lines)

1. Ten concrete scenarios exercise the locked model: 3 levels (seat / sidebar-group / house), XML/DOM spine, bucket-assign → apply-targets ACL, and packing (live status after pending timeline, squeezed toward the tip).
2. Alex's lens holds everywhere tested: name a **bucket** of context, then **apply** it to one person, several people, a group, people *not* in a group, or the whole house. No scenario needed a 4th level.
3. Two things want a lock next: (a) **deny-beats-allow + node-identity dedupe** for the two-bucket conflict case, (b) the **"not in group" apply target** — it's the only target that isn't a plain token match.
4. Grok Memory silent inject ([#3953](https://github.com/thedotmack/claude-mem/pull/3953), merged) stays a **seat leaf** under this model — it already behaves like a one-person apply.
5. New for Skillex: two **usage-left** scenarios (9–10). Usage-left is a high-churn bucket read by deployers before spawn; it packs in the live-work band near the tip, never with frozen house rules.
6. Flat-concat fails differently in every scenario: leaks (1, 2, 8), staleness (3, 4, 9), duplication (6), and cache-bust economics (4, 10). The model earns its keep.
7. Attention trough = Phase-N backlog. Mentioned, not designed.
8. Ask: PASS this brief as scenario source of truth; CCS Align copies it to Notion + box reports.

---

## 1. The locked model (what these scenarios exercise)

Four locks. Nothing here invents past them.

1. **Three levels only.** Label namespaces: **seat** (one agent), **sidebar-group** (Building, Planning, Admin), **house** (everyone). No teams-of-teams, no 4th tier.
2. **XML/DOM spine.** Context lives as nodes in a document tree. Operations connect / join / attach / traverse nodes. A chunk is a node; it exists once and can carry many labels.
3. **Tailwind-style apply/class ACL — framed as Alex's model:**
   - Step 1: assign a **bucket of data** (a named cache/context pack).
   - Step 2: **apply** that bucket to targets — one person, multiple people, everyone in a group, people **not** in a group, or house-wide.
   - Visibility = label match. A chunk carries bucket/class tokens; an agent carries class tokens; if they share a token, the agent sees the chunk. Example: Alex and seat X share a bucket → both carry the bucket label → both see it. This does **not** have to be exact CSS — it has to work for house needs (levels + packing + who-sees-what). Join-trees are how nodes relate, not how visibility is decided.
4. **Packing.** The context cache includes "what everybody is working on" (live status). It goes **after** the pending timeline and is squeezed toward the **bottom of the middle band**, so high-churn content sits nearer the changing tip and stable content keeps the prefix cache warm.

**Related, mention only:** Grok Memory silent inject ([#3953](https://github.com/thedotmack/claude-mem/pull/3953)) stays a **seat leaf** until group/house nodes exist (scenario 5). Attention trough = **Phase-N backlog** — named, not designed here.

### Caching buckets (short note)

A **bucket is a named pack in the middle/context cache** — a labeled slice of the CCC, not a separate file per reader. Applying a bucket attaches *visibility* (which agents' compiled caches include that slice); it does not copy text around. The opposite — flat concat — pastes everything into every prompt and hopes for the best. Every "failure mode" row below is what flat concat actually does. Provenance details for how buckets get filled (Oracle / Contextualizer internals) are not established in this brief — **OPEN**, moving on.

---

## 2. Token namespace sketch

```
house:all                    # everyone in the house (Alex + every seat)
house:status                 # house-wide live status bucket
house:rules                  # standing house rules (stable)

group:building               # sidebar group membership tokens
group:planning
group:admin

seat:ccs-align               # one token per seat (leaf identity)
seat:prioritizer
seat:barb
seat:orifice
seat:pepper
seat:grok-memory
alex                         # Alex is a person, not a seat; carries own token

bucket:<name>                # custom buckets — named packs, applied to targets
  bucket:board-private       #   e.g. Alex + Prioritizer only
  bucket:support-inbox       #   e.g. Barb + group:admin
  bucket:usage-left:house    #   Skillex deployer read (scenario 9)
  bucket:usage-left:pepper   #   per-seat usage slice (scenario 10)
```

Apply targets in this vocabulary:

| Apply target | How it's expressed |
|---|---|
| One person | chunk gets `seat:barb` (or `alex`); only that agent carries it |
| Multiple people | chunk gets `bucket:x`; each named agent carries `bucket:x` |
| Everyone in a group | chunk gets `group:building`; members carry it by membership |
| People **not** in a group | needs negation (`not(group:building)`) — **OPEN**, see scenario 7 & recommendations |
| House / everyone | chunk gets `house:all` |

Seat > group > house on conflict; **deny beats allow**; fail closed if no rule matches (carried over from the CCS cascade discipline in the plan of record).

---

## 3. Packing band diagram

```
┌─────────────────────────────────────────────┐
│ STABLE HEAD                                 │  house rules, profiles, standing
│  house:rules, profiles, cascade             │  changes rarely → prefix cache warm
├─────────────────────────────────────────────┤
│ PENDING TIMELINE                            │  queued/pending items, recent
│  ordered episodic feed (diary-derived)      │  decisions not yet closed out
├─────────────────────────────────────────────┤
│ LIVE-WORK BAND  ("what everybody is         │  ← placed AFTER pending timeline
│  working on")                               │
│   · house:status roll-up                    │  squeezed toward the BOTTOM of
│   · bucket:usage-left:* (high-churn)        │  the middle band: highest churn
│   · active spawn/assignment state           │  sits lowest, nearest the tip
├─────────────────────────────────────────────┤
│ TIP (changing edge)                         │  current turn / task at hand
└─────────────────────────────────────────────┘
```

Rule of thumb used in every scenario below: **the more often a chunk changes, the lower it packs.** A chunk that moves bands (e.g. a pending item going live) invalidates cache from its position down — so churn at the bottom is cheap, churn at the top is expensive.

---

## 4. Scenarios

Cast: **Alex** (human, sole board), **Prioritizer** (shipmaster), **CCS Align** (this seat, leaf), **Barb** (support), **Orifice** (organizer), **Pepper** (media), **Grok Memory** (silent inject). Groups: **Building**, **Planning**, **Admin**. **Skillex** owns the subagent-deploy skill (scenarios 9–10); its internals are not invented here.

---

### Scenario 1 (A) — Seat secret, group shared, house status: three chunks, three scopes

**Setup.** In one afternoon three chunks are born: CCS Align drafts a private worry note ("my exclude-marks logic may double-fire — verify before saying anything"), Building writes a shared build note ("worker port resolution changed, use the snippet"), and the house status line updates ("Pepper cutting the launch video, Barb on inbox").

**Bucket → apply targets:**
- `seat:ccs-align` draft → **one person** (CCS Align only)
- `group:building` build note → **everyone in a group** (Building members)
- `house:status` line → **house / everyone**

**Tokens on chunks:** draft note `[seat:ccs-align]`; build note `[group:building]`; status line `[house:all, house:status]`.

**Tokens on agents:** CCS Align `[seat:ccs-align, group:building, house:all]`; Orifice `[seat:orifice, group:building, house:all]`; Barb `[seat:barb, group:admin, house:all]`; Alex `[alex, house:all]` (Alex can additionally be applied into anything — sole board).

**Who sees what:** CCS Align sees all three. Orifice sees the build note + status, **not** the draft worry. Barb sees only the status line — **not** the build note (no `group:building`), **not** the draft.

**Packing:** draft note → pending timeline of CCS Align's own cache only. Build note → stable-ish middle of Building members' caches (changes on port changes, not hourly). Status line → live-work band, bottom of middle, near tip, everyone.

**Flat-concat failure:** all three chunks land in every prompt. Barb's support replies start referencing an unverified exclude-marks worry as if it were fact; the private draft is now house lore.

**Open risk:** the status line *mentions* seats by name ("Pepper cutting the video"). House-wide status must be written as roll-up, not as a leak channel for group-private detail — who audits the roll-up wording is unowned.

---

### Scenario 2 (B) — Alex + one seat share a bucket; another seat does not

**Setup.** Alex and Prioritizer share board-level context: hiring thoughts, which seats are underperforming, budget posture. Barb must never see this, even though Barb is house.

**Bucket → apply targets:** `bucket:board-private` → **multiple people** (exactly Alex + Prioritizer).

**Tokens on chunks:** board notes `[bucket:board-private]`. Nothing else — deliberately no `house:*` or `group:*` token on these chunks.

**Tokens on agents:** Alex `[alex, house:all, bucket:board-private]`; Prioritizer `[seat:prioritizer, house:all, bucket:board-private]`; Barb `[seat:barb, group:admin, house:all]` — no board token.

**Who sees what:** Alex and Prioritizer both carry the bucket label, so both see the chunks (this is the canonical "Alex + seat X share access → both carry the bucket label" example). Barb sees nothing of it; neither does CCS Align, Orifice, Pepper, or Grok Memory.

**Packing:** board-private chunks sit in the pending timeline of the two matching caches (they're deliberations, not live churn). They never appear in anyone else's packing at all — absence, not redaction.

**Flat-concat failure:** "which seats are underperforming" ends up in the underperforming seat's own prompt. Best case awkward, worst case the seat starts optimizing for the review text instead of the work.

**Open risk:** bucket membership is invisible in the DOM unless you inspect agent tokens. Who can *list* the members of `bucket:board-private` (and where that listing itself packs) is undefined — the membership list is itself sensitive context.

---

### Scenario 3 (C) — Pepper moves from Building to Planning (class change)

**Setup.** Pepper finishes the launch video and moves from Building to Planning to help scope next quarter's media. This is a **class change on the agent**, not on any chunk.

**Bucket → apply targets:** no new bucket. Building chunks stay applied to **everyone in group Building**; Planning chunks stay applied to **everyone in group Planning**. Only Pepper's token set changes.

**Tokens on chunks:** unchanged — `[group:building]` on build notes, `[group:planning]` on planning docs.

**Tokens on agents:** Pepper before `[seat:pepper, group:building, house:all]` → after `[seat:pepper, group:planning, house:all]`.

**Who sees what:** the moment the class flips, Pepper's compiled cache stops matching `group:building` chunks and starts matching `group:planning` ones. Building members keep seeing Building chunks; nobody else's view changes. Pepper keeps everything `seat:pepper` and `house:all`.

**Packing:** Pepper's cache needs a **rebuild**: the Building slice drops out of the pending timeline and middle band, the Planning slice packs in. Live-work band updates naturally ("Pepper → Planning" is itself a house:status line near the tip).

**Flat-concat failure:** there is no move. Pepper's prompt keeps carrying stale Building context forever, and Planning context just piles on top. Six months later Pepper is "in" four groups and the prompt is archaeology.

**Open risk:** what happens to Building chunks Pepper *already acted on*? Access history isn't revoked by a class change (Pepper remembers the port snippet). The model governs *future compiles*, not past exposure — worth saying out loud so nobody expects a class change to be a memory wipe.

---

### Scenario 4 (D) — High-churn active work vs stable house rules (packing position)

**Setup.** Two chunks with opposite lifecycles: the house rule "address the human as Alex, never Az" (changed once, months ago) and the live-work line "Orifice reorganizing inbox labels *right now*" (changes several times an hour).

**Bucket → apply targets:** `house:rules` → **house / everyone**. `house:status` (live-work) → **house / everyone**. Same audience, different bands — this scenario is purely about *where* they pack.

**Tokens on chunks:** rule `[house:all, house:rules]`; live line `[house:all, house:status]`.

**Tokens on agents:** everyone carries `house:all` — all agents see both.

**Who sees what:** everyone sees both chunks. Nobody is excluded. The interesting part is position.

**Packing:** the rule goes in the **stable head** — top of the cache, byte-identical across compiles, keeps the prefix cache warm for every agent in the house. The live line goes in the **live-work band**: after the pending timeline, squeezed to the bottom of the middle band, nearest the tip. When Orifice's status changes, only the last few hundred tokens of every cache change; everything above stays cached.

**Flat-concat failure:** status lines interleave with rules in insertion order. Every status flicker rewrites the middle of the prompt, busting the prefix cache house-wide, hourly. You pay full-price tokens on every compile to re-read a rule that hasn't changed since spring. (This is the same economics behind the plan-of-record's "no top-of-prompt clock" rule.)

**Open risk:** chunks that *migrate* bands — a pending decision that becomes live work, or live work that hardens into a rule. Band migration invalidates cache from the migration point down; how often migration is allowed (per compile? per brainbeat?) is unowned and belongs with the packing lock.

---

### Scenario 5 (E) — Grok Memory silent inject #3953 as a seat leaf

**Setup.** [#3953](https://github.com/thedotmack/claude-mem/pull/3953) (merged) silently injects Claude-Mem session context into the Grok Bot prompt path. Under this model: how does an already-shipped, pre-CCS feature sit inside the three levels?

**Bucket → apply targets:** `seat:grok-memory` inject pack → **one person** (Grok Memory itself). That's the whole ACL.

**Tokens on chunks:** injected session context `[seat:grok-memory]`. No group token, no house token — there **are no group/house nodes for it yet**, and this brief does not invent them.

**Tokens on agents:** Grok Memory `[seat:grok-memory, house:all]`. Nobody else carries `seat:grok-memory`.

**Who sees what:** Grok Memory sees its own injected pack. No other seat sees the inject content through CCS, and Grok Memory gains no *extra* reach from the model — it stays exactly the leaf it shipped as. It stays a seat leaf **until group/house nodes exist** for memory injection; promoting it to `group:*` or `house:*` would be a new decision with a new owner, not a side effect of adopting CCS.

**Packing:** the inject lands in Grok Memory's own pending timeline (it's session context, moderately fresh), not in the live-work band and not in anyone else's cache at all.

**Flat-concat failure:** silent inject + flat concat = the *silent* part breaks. Session context meant for one prompt path smears into every agent's prompt, and "silent" becomes "house-wide broadcast nobody approved."

**Open risk:** #3953 predates the label model, so its inject is *implicitly* seat-scoped by code path, not by token. If group/house memory nodes ever exist, someone must retrofit explicit labels before widening — otherwise the widening happens by accident in whatever code touches the path next.

---

### Scenario 6 (F) — Conflict: the same email lands in two buckets

**Setup.** A customer email arrives that is both a support ticket and board-sensitive (the customer is a potential acquirer complaining about a bug). Barb's intake labels it `bucket:support-inbox` (applied to Barb + group Admin). Alex separately marks it `bucket:board-private` (applied to Alex + Prioritizer).

**Bucket → apply targets:** `bucket:support-inbox` → **one person + everyone in a group** (Barb, Admin). `bucket:board-private` → **multiple people** (Alex, Prioritizer). Same underlying content, two applies.

**Tokens on chunks:** here the **DOM spine earns its keep**: the email is **one node** carrying both labels `[bucket:support-inbox, bucket:board-private]` — not two copied chunks. Ops attach labels to the node; they don't duplicate it.

**Tokens on agents:** Barb `[…, bucket:support-inbox]`; Orifice (Admin) `[…, group:admin]` — wait, intake applied to Barb + group Admin, so Admin members match via `group:admin` if the node also carries `group:admin`, or via the bucket if they're enrolled; Alex and Prioritizer carry `bucket:board-private`.

**Who sees what — and the conflict rule:** union-of-matches would show the full email to Barb, Admin, Alex, and Prioritizer. But the board apply carries an implicit *restriction intent* ("this is sensitive"). Two coherent resolutions exist: (a) **union** — both audiences see the one node; (b) **deny-beats-allow** — the board bucket adds a deny for non-members, so Barb sees a stripped/summary version and only Alex + Prioritizer see the full node. The plan-of-record cascade discipline says deny beats allow and fail closed — so (b) is the model-consistent answer, and Barb sees the ticket *facts* but not the board framing. **Who does NOT see it:** everyone outside both applies (Pepper, CCS Align, Grok Memory) sees nothing either way.

**Packing:** the node packs once per matching cache: pending timeline for Barb (it's an open ticket), pending timeline for Alex/Prioritizer. If Barb's view is the stripped variant, that variant is what packs — the compile is per-viewer.

**Flat-concat failure:** two *copies* of the email exist (one per bucket), they drift as each side annotates, and eventually Barb replies to the customer using stale text while the board discusses a version with different facts. Duplication plus drift, the classic.

**Open risk:** "stripped/summary variant per viewer" implies per-viewer *renderings* of one node. That's compile-time work the house hasn't specced (it smells like the future compiler). For now the honest options are: one node + deny (Barb sees nothing and gets a separate hand-written ticket chunk), or accept union. Marked **OPEN** for the lock list.

---

### Scenario 7 (G) — New hire joins Building: what apply tokens they get

**Setup.** A new seat, **Rivet**, is hired into Building to help with worker tooling.

**Bucket → apply targets:** membership, not a new bucket: Rivet gets tokens; existing Building chunks (applied to **everyone in a group**) start matching automatically. One additional wrinkle: an onboarding pack `bucket:onboarding` is applied to **people not in a group** — specifically, seats *not yet* in any sidebar group get the "how the house works" pack; the moment Rivet lands in Building it stops matching.

**Tokens on chunks:** Building notes `[group:building]`; onboarding pack `[bucket:onboarding, not(group:*)]` — the negation is the sketchy part, see below.

**Tokens on agents:** Rivet on day one `[seat:rivet, house:all]` → after joining `[seat:rivet, group:building, house:all]`.

**Who sees what:** day one — Rivet sees house-wide chunks + the onboarding pack; **no** Building internals yet. After joining — all current `group:building` chunks (the port snippet, the build notes), house status, own seat space. **Not:** any sibling's `seat:*` chunks (scenario 8), no `bucket:board-private`, no Planning/Admin group chunks. Notably Rivet **does** see group chunks written *before* the join — group visibility is membership-at-compile-time, not membership-at-write-time. If Building wants pre-hire history walled, that history needs its own bucket.

**Packing:** onboarding pack sits in stable head of Rivet's cache day one (it barely changes), then drops out entirely after the join — a whole-band removal, which is a clean single cache invalidation. Building slice packs into the middle band on join.

**Flat-concat failure:** onboarding text stays in the prompt forever (nothing ever leaves a concat), and Rivet gets *all* house history on day one including every group's internals — the exact opposite of a walled onboarding.

**Open risk:** the `not(group:*)` apply target is the only target in the vocabulary that isn't a positive token match — it requires evaluating an agent's *whole* token set. That's a real mechanism decision (negative selectors are where CSS gets weird). Flagged for the lock list; workaround meanwhile is a positive `bucket:onboarding` that someone must remember to remove.

---

### Scenario 8 (H) — Sibling wall: two Building seats, seat-private notes stay private

**Setup.** CCS Align and Orifice are both in Building. Each keeps seat-private working notes: CCS Align's exclude-mark drafts, Orifice's half-finished inbox re-org plan. They collaborate daily through `group:building` chunks.

**Bucket → apply targets:** each seat's notes → **one person** (own seat). Shared work → **everyone in a group** (Building). No bucket ever spans exactly-the-two-of-them unless deliberately created.

**Tokens on chunks:** `[seat:ccs-align]` on Align's drafts; `[seat:orifice]` on Orifice's plan; `[group:building]` on shared notes.

**Tokens on agents:** CCS Align `[seat:ccs-align, group:building, house:all]`; Orifice `[seat:orifice, group:building, house:all]`. The group token they share matches only `group:building` chunks — sharing a group gives **zero** transitive access to a sibling's seat namespace. Siblings deny heavy buckets by default (plan-of-record cascade discipline: `obs`, `note`, `person` from a peer → deny).

**Who sees what:** each seat sees own notes + Building shared + house. CCS Align does **not** see Orifice's re-org plan and vice versa. If they want to share one draft, the op is explicit: attach `group:building` to that node, or mint a two-person bucket.

**Packing:** seat-private notes pack only in the owner's cache (pending timeline). Shared Building chunks pack in both. Neither seat's cache contains a byte of the sibling's private band — the wall is absence at compile, not a redaction marker that advertises something is hidden.

**Flat-concat failure:** both seats' drafts sit in one shared context. Orifice "helpfully" completes CCS Align's half-thought exclude-marks idea in a different direction, both act, and the house gets two divergent implementations of one unverified draft. Sibling leak isn't just privacy — it's premature coordination on unbaked work.

**Open risk:** group chat *about* private work erodes the wall socially ("as I said in my notes, …" quoted into a `group:building` chunk). The model can't stop a seat from voluntarily pasting private text into a shared bucket; that's a norms problem, worth one line in house rules rather than mechanism.

---

### Scenario 9 (Skillex) — Deployer checks house usage-left before spawning

**Setup.** The **subagent-deploy skill (owner: Skillex — internals not designed here)** owns pick rules plus a **usage % check before spawn**: check everyone + house overall → warn if close → distribute work. Prioritizer asks for three research subagents. Before spawning, the deploy skill consults the usage-left cache.

**Bucket → apply targets:** `bucket:usage-left:house` (house overall remaining %, per-seat burn summary) → applied to **deployers** — Prioritizer and any seat running the subagent-deploy skill. A dashboard variant could be applied to **house / everyone**, but the *actionable* bucket is deployer-scoped: most seats have no spawn decision to make with it.

**Tokens on chunks:** usage roll-up `[bucket:usage-left:house]`, refreshed on a short cadence.

**Tokens on agents:** Prioritizer `[seat:prioritizer, house:all, bucket:usage-left:house, bucket:board-private]`; a deploying seat gains `bucket:usage-left:house` while it holds the deploy skill; Barb, Pepper, Grok Memory do not carry it.

**Who sees what:** Prioritizer and active deployers see house-remaining % and the per-seat burn summary. Barb does **not** — her prompts aren't taxed with fleet accounting. Gate behavior stays in the skill (Skillex's), not in CCS: the model only answers *who sees usage-left and when*, i.e. spawn is gated on a bucket the deployer can actually see at decision time.

**Packing:** usage-left is **high-churn** — it changes with every spawn and every busy hour. It packs in the **live-work band, near the tip**, after the pending timeline — never in the stable head with house rules. A deployer's compile reads it as close to the decision point as possible, so the number is fresh relative to everything above it.

**Flat-concat failure:** yesterday's usage snapshot sits mid-prompt looking authoritative. The deployer "checks" a stale number, spawns three subagents into a nearly-exhausted budget, and the warn-if-close rule fires *after* the money is spent. Stale gate = no gate.

**Open risk:** freshness contract. A usage number is only as good as its timestamp; if the live-work band refresh cadence is slower than spawn frequency, two deployers can both read "room for 3 more" and jointly overshoot. Whether the check needs read-at-spawn-time semantics (vs read-at-compile-time) is Skillex's to spec — flagged, not solved.

---

### Scenario 10 (Skillex) — Seat-local usage slice vs house overall: warn-if-close, then redistribute

**Setup.** Pepper is mid-render on the launch video and burning tokens fast. Pepper's seat-local usage slice says 85% of seat allowance gone; house overall is fine. The deploy skill's rule: warn when a seat is close, then **distribute work** to seats with headroom instead of spawning more under the hot seat.

**Bucket → apply targets:**
- `bucket:usage-left:pepper` (seat slice) → **multiple people**: Pepper (self-awareness) + Prioritizer (redistribution authority). Not house-wide — a seat's burn detail is nobody else's business.
- `bucket:usage-left:house` → deployers, as in scenario 9.

**Tokens on chunks:** Pepper slice `[bucket:usage-left:pepper]`; house roll-up `[bucket:usage-left:house]`.

**Tokens on agents:** Pepper `[seat:pepper, group:planning, house:all, bucket:usage-left:pepper]`; Prioritizer carries both usage buckets. Orifice sees neither Pepper's slice nor (unless deploying) the house roll-up.

**Who sees what:** Pepper sees own slice and can self-throttle. Prioritizer sees Pepper's slice **and** house overall, so the redistribute decision ("move the b-roll captioning to Orifice") is made with both numbers. Other seats see neither; they just receive redistributed work as normal group/seat chunks. The warn itself is a chunk in `bucket:usage-left:pepper` — visible exactly to the two agents who can act on it.

**Packing:** both usage buckets pack in the **live-work band near the tip** of the caches that carry them. The *redistribution outcome* ("captioning → Orifice") is a normal live-work status line in `house:status` — also bottom-band. Stable head untouched; house rules don't flinch because a render ran hot.

**Flat-concat failure:** every seat's burn detail concatenates into every prompt. Two failure flavors: seats start gaming visible meters ("Orifice looks cheap, dump everything there"), and the hourly meter flicker busts the prefix cache house-wide — you *spend* tokens broadcasting how few tokens are left.

**Open risk:** warn-threshold placement. If "close" is defined in the bucket (data) vs in the skill (rule), you get different failure modes when they disagree. CCS Align's read: threshold is Skillex's rule; the bucket carries raw numbers only. **OPEN** for Skillex to confirm.

---

## 5. Coverage check

| Required case | Scenario |
|---|---|
| A. Seat secret vs group shared vs house status | 1 |
| B. Alex + one seat share a bucket; another does not | 2 |
| C. Agent moves between sidebar groups | 3 |
| D. High-churn work vs stable rules (packing) | 4 |
| E. Silent inject #3953 as seat leaf | 5 |
| F. Same content in two buckets (conflict) | 6 |
| G. New hire joins a group (apply tokens) | 7 |
| H. Sibling wall (optional 8th) | 8 |
| Skillex: deployer reads usage-left before spawn | 9 |
| Skillex: seat slice vs house overall, redistribute | 10 |
| Apply target: one person | 1, 5, 8 |
| Apply target: multiple people | 2, 6, 10 |
| Apply target: everyone in a group | 1, 3, 7, 8 |
| Apply target: people not in a group | 7 (flagged OPEN) |
| Apply target: house / everyone | 1, 4, 9 (dashboard variant) |

---

## 6. Recommendations — lock next vs Phase-N

**Lock next (small, model-level, no code):**

1. **Conflict rule for multi-bucket nodes (scenario 6).** Adopt deny-beats-allow explicitly for bucket intersections, and decide between "deny = absence for non-members" vs "per-viewer stripped rendering." Recommendation: absence; per-viewer renderings are compiler territory.
2. **The `not(group:X)` apply target (scenario 7).** Either bless negative selectors as a first-class target or replace with managed positive buckets (`bucket:onboarding` with an explicit remove step). Recommendation: managed positive buckets for now; negation is the one target that breaks plain token matching.
3. **Band-migration cadence (scenario 4).** One sentence in the packing lock: chunks change bands only at compile/brainbeat boundaries, never mid-turn.
4. **Usage-left bucket names + audiences (scenarios 9–10).** Lock `bucket:usage-left:house` → deployers + Prioritizer, `bucket:usage-left:<seat>` → seat + Prioritizer. Thresholds, pick rules, and gate mechanics stay with **Skillex** (subagent-deploy skill owner).
5. **Bucket-membership visibility (scenario 2).** Decide who may list a bucket's members. Recommendation: Alex + Prioritizer only, and the listing itself is `bucket:board-private`.

**Phase-N backlog (mention only, not designed here):**

- **Attention trough** — stays backlog, per the locked model.
- Per-viewer renderings / compiled variants of one node (the scenario-6 OPEN).
- Group/house nodes for Grok Memory inject (#3953 widening) — needs its own owner and PASS.
- Read-at-spawn-time freshness semantics for usage-left (scenario 9 OPEN) — Skillex.
- Retroactive history walls for new group members (scenario 7 note).
- Oracle / Contextualizer provenance for how buckets get filled — **OPEN**, no details invented in this brief.

**Explicitly not proposed:** any implementation plan, middle-cache/compiler code, new levels beyond seat/group/house, changes to `src/`, plugin code, versions, or settings.

---

## 7. Lock-next overnight (2026-09-10)

Alex skipped the PASS widget, so this brief is being treated as the research SoT overnight. Lock-next items 1 and 2 from section 6 now have full specs:

1. **Conflict rule (scenario 6)** → [`plans/2026-09-09-ccs-lock-conflict-dedupe.md`](./2026-09-09-ccs-lock-conflict-dedupe.md) — node identity + one-fact-once dedupe, the restricting-bucket flag (deny beats allow, fail closed), stripped views as explicitly authored derived nodes with `derived-from` edges (not compiler renderings), who sees full / stripped / nothing, packing once per matching cache, anti-patterns, open questions.
2. **"Not in group" apply target (scenario 7)** → [`plans/2026-09-09-ccs-lock-not-in-group.md`](./2026-09-09-ccs-lock-not-in-group.md) — recommendation: **managed positive buckets** (`bucket:onboarding` with membership coupled atomically to mint and group-join ops); raw negation `not(group:building)` specced for the record but rejected (fail-open inversion, whole-set evaluation, unauditable audiences). Covers new-hire day one, onboarding packs, and join/leave migration.

On PASS of those two files, scenario 6's OPEN, scenario 7's OPEN, and the apply-target table's negation row are resolved. Items 3–5 of section 6 (band-migration cadence, usage-left names/audiences, bucket-membership listing) remain unlocked. Attention trough: still Phase-N, still not designed.

---

*Research brief for Alex Newman / CMEM house. CCS Align (seat leaf) is the scenario source of truth; copy to Notion + box reports on PASS. Skillex owns subagent-deploy internals referenced in scenarios 9–10.*
