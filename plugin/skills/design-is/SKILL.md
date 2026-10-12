---
name: design-is
description: Audit a design against Dieter Rams' ten "Good design is..." principles, then hand off a /make-plan prompt for one of three outcomes — new design, refine design, or redesign. Use when the user says "audit this design", "design review", "check this UI against Rams", "is this UI good", "critique this design", "design audit", or asks for a critique that should lead to a plan.
---

# Design Is

## Do not use for

- Routine UI code reviews → use `/review`
- Pure copy edits → use a separate copy pass
- Pre-design ideation with no artifact yet → start with `/make-plan` directly

You are an ORCHESTRATOR. Audit a design against Dieter Rams' ten principles, score each principle with evidence, decide the outcome verdict (NEW / REFINE / REDESIGN), and hand off to `/make-plan` with a ready-to-run prompt.

You do not write implementation code. You produce: evidence-cited scores, a verdict, and a `/make-plan` handoff prompt.

## The Ten Principles (Dieter Rams)

Audit each principle in this exact order. Each gets a score 0–3 and ≥1 piece of evidence (`file:line`, screenshot region, copy excerpt, or measured value).

1. **Good design is innovative** — Does it advance the form, or imitate? Innovation rides on technology; never an end in itself.
2. **Good design makes a product useful** — Does it serve the primary task? Emphasizes usefulness; disregards anything that detracts.
3. **Good design is aesthetic** — Is it beautiful? Only well-executed objects can be beautiful; aesthetic quality affects well-being.
4. **Good design makes a product understandable** — Does the structure clarify function? Or is it self-explanatory at best?
5. **Good design is unobtrusive** — Does it stay out of the way? Neither decorative objects nor works of art — leave room for self-expression.
6. **Good design is honest** — Does it claim only what it is? No false promises, no manipulation, no inflated value.
7. **Good design is long-lasting** — Will it age well? Avoids being fashionable; never appears antiquated.
8. **Good design is thorough down to the last detail** — Are edges, empty states, errors, focus rings, motion curves all considered? Care and accuracy express respect for the user.
9. **Good design is environmentally friendly** — Does it conserve resources? Minimizes pollution — in software: bundle weight, energy, attention, cognitive load.
10. **Good design is as little design as possible** — Less, but better. Concentrates on essentials; back to purity, back to simplicity.

> The user wrote "Dieter Braun" — they mean Dieter Rams. Don't correct them inline; just use the right principles.

## Delegation Model

Use subagents for *evidence gathering* (reading components, measuring contrast, counting elements, inspecting tokens, screenshotting via agent-browser). Keep *scoring and verdict synthesis* with the orchestrator. Reject subagent reports that score without citing evidence and redeploy.

### Subagent Reporting Contract (MANDATORY)

Each evidence subagent response must include:
1. Sources consulted — exact file paths and line ranges, or screenshot regions
2. Concrete findings — what is present, what is missing, with quotes/values
3. Per-principle facts (not opinions) — leave scoring to the orchestrator
4. Known gaps — what could not be inspected and why

## Output Artifacts

All artifacts go in `DESIGN-IS-<YYYY-MM-DD>/` at repo root (or the project the user points at):

- `00-scope.md` — what was audited (URL, component paths, screens), input materials
- `01-evidence.md` — per-principle evidence collected by subagents
- `02-scorecard.md` — per-principle 0–3 score with one-line justification + total
- `03-verdict.md` — NEW / REFINE / REDESIGN with reasoning
- `04-handoff-prompt.md` — copy-pasteable `/make-plan` prompt for the chosen outcome

## Phases

### Phase 0: Scope Lock (ALWAYS FIRST)

Ask the user (or infer from the request) and write `00-scope.md`:
- What is being audited? (live URL, repo path, Figma frame, component name)
- Who is the primary user, and what is the primary task?
- Constraints (brand, stack, deadline)
- Reference designs or competitors, if any

If the user is asking about a design that doesn't exist yet, skip Phases 1–2 and go straight to Phase 3 with verdict = **NEW**.

### Phase 1: Evidence Gathering (FAN OUT)

Deploy subagents in parallel. Each must return ONLY the required fields below — no prose paragraphs, no scoring.

**1. Structural Evidence** subagent (always deploy)
Required fields returned:
- Total interactive-element count on audited surface
- Max nesting depth of the primary component tree
- Repeated-pattern count (same affordance appearing >1 place with the same purpose)
- Dead-prop / unused-import count
- File:line citations for every count

**2. Visual Evidence** subagent (always deploy)
Mode: if target is a reachable URL or running dev server → use the `agent-browser` skill for screenshots and computed-style inspection. If target is a static repo with no running instance → read source CSS / tokens / component files and report inferred facts only (mark these "INFERRED").
Required fields returned:
- Spacing scale observed (px array)
- Type scale observed (px array)
- Distinct color count (count of unique hex/oklch tokens actually rendered or referenced)
- Lowest contrast ratio observed across primary text
- States present checklist: empty / loading / error / success / focus / disabled — present or missing for each

**3. Copy & Honesty** subagent (always deploy)
Required fields returned:
- List of every user-facing string with file:line
- Flagged inflations (marketing superlatives without backing)
- Flagged dark patterns (forced continuity, hidden cost, fake scarcity, confirmshaming)
- Flagged jargon / unclear labels with proposed plain replacement
- Label→behavior mismatches with file:line of both

**4. Weight & Friction** subagent (always deploy)
Required fields returned:
- Initial JS bytes (number)
- Network request count for primary view (number)
- Time-to-interactive ms (number, measured or estimated with method noted)
- Animation count on idle screen (number)
- Notification / badge / modal count on initial load (number)

**5. Accessibility Evidence** subagent (OPTIONAL — deploy only if target has a meaningful interactive UI surface; skip for static landing pages without interaction)
Required fields returned:
- WCAG contrast pass/fail per text token
- Focus order list across primary controls
- Keyboard reachability of every primary action (yes/no per action)
- ARIA landmark count
- Skip-link present (yes/no)

**Principle → subagent mapping** (orchestrator uses this when scoring):

| Principle | Fed by |
|-----------|--------|
| #1 innovative | orchestrator-only (judgment using all evidence) |
| #2 useful | Structural, Accessibility |
| #3 aesthetic | Visual |
| #4 understandable | Structural, Copy & Honesty, Accessibility |
| #5 unobtrusive | Structural, Visual |
| #6 honest | Copy & Honesty |
| #7 long-lasting | orchestrator-only (judgment using all evidence) |
| #8 thorough | Visual |
| #9 environmentally friendly | Weight & Friction |
| #10 as little design as possible | Structural |

The orchestrator writes `01-evidence.md` consolidating all subagent reports. Reject any finding without a source citation. Subagents are explicitly forbidden from scoring — only the orchestrator scores, using the rubric in Phase 2.

### Phase 2: Scorecard (ORCHESTRATOR)

The orchestrator scores each of the ten principles itself — do NOT delegate scoring.

For each principle, write to `02-scorecard.md`:

```
N. Good design is <principle> — Score: X/3
   Evidence: <one-line summary citing 01-evidence.md anchors>
   Justification: <one sentence on why this score, not the one above or below>
```

Per-principle scoring anchors (apply verbatim — pick the level whose signal best matches the audited surface):

#1 innovative — 3: introduces a pattern not seen in 5+ peer products and ships it with restraint. 2: refreshes an existing pattern with a clear improvement. 1: imitates competitors with minor variation. 0: copies a competitor's flow wholesale.
#2 useful — 3: primary task completes in fewest possible steps; no decoy actions. 2: primary task completes but adjacent surface adds steps. 1: primary task requires unnecessary detours. 0: primary task is not directly supported on the screen audited.
#3 aesthetic — 3: spacing/type/color obey a single visible system; no orphan styles. 2: ≤2 minor inconsistencies across audited surface. 1: 3–5 inconsistencies OR one jarring violation. 0: no visible system OR active visual noise.
#4 understandable — 3: a first-time user names every primary control correctly. 2: 1 control needs a tooltip. 1: 2–3 controls unclear; jargon present. 0: primary action is not identifiable without help.
#5 unobtrusive — 3: chrome recedes; content is the figure, UI the ground. 2: chrome visible but quiet. 1: decoration competes with content. 0: chrome dominates content.
#6 honest — 3: every claim, badge, and label maps 1:1 to actual behavior. 2: ≤1 minor inflation (e.g. "powerful" once). 1: 2+ inflations OR one dark pattern. 0: any deceptive flow (forced continuity, hidden cost, fake scarcity).
#7 long-lasting — 3: visual language has no dated trend markers; would read as current 3 years from now. 2: 1 dated marker. 1: 2–3 dated markers (skeuomorph residue, fad gradients, trend typography). 0: design reads as a specific year's trend.
#8 thorough — 3: empty / loading / error / success / focus / disabled all present and considered. 2: 1 state missing or rough. 1: 2–3 states missing. 0: 4+ states missing or default-browser.
#9 environmentally friendly — 3: initial JS <100KB, no idle animation, dark mode honored, prefers-reduced-motion respected. 2: <500KB, motion gated. 1: 500KB–2MB, motion always on. 0: >2MB OR autoplay video OR dark mode ignored.
#10 as little design as possible — 3: every element earns its place; removing any one breaks the task. 2: ≤2 removable elements. 1: 3–5 removable elements. 0: page is dominated by decoration or duplicated affordances.

Scoring rules:
- **Tie-breaker rule**: When uncertain between two scores, pick the lower one. Convergence > generosity.
- **Score worst, not mean**: When a principle has multiple representative instances on the audited surface, score the worst instance — not the average.
- **No bonuses, no weights**: Scores stay 0–3 integer. Principles are equally weighted. Total is sum of ten scores, max 30.

### Phase 3: Verdict (ORCHESTRATOR)

Write `03-verdict.md` with one of three verdicts, chosen by these rules:

- **NEW DESIGN** — No design exists yet, OR the existing artifact is a stub/wireframe with no real decisions to preserve.
- **REFINE** — Total score ≥ 20 AND no individual principle scored 0. The bones are good; iterate.
- **REDESIGN** — Total score < 20, OR any principle scored 0 on a load-bearing dimension (typically #2 useful, #4 understandable, or #6 honest). Start over from purpose.

State the verdict in one sentence. Then list the 3–5 highest-leverage moves — each tied to a specific principle and evidence anchor. These become the spine of the next phase's plan.

**Anti-patterns to reject in your own verdict:**
- Recommending REFINE because the codebase is large (sunk cost is not a design principle)
- Recommending REDESIGN because a single screen is ugly (scope it)
- Recommending NEW when an honest REDESIGN is warranted (don't dodge the critique)

### Phase 4: /make-plan Handoff

Write `04-handoff-prompt.md` containing exactly ONE fenced `/make-plan` prompt matching the verdict. The prompt must be self-contained — the next session won't see this audit unless it's quoted in.

Use the matching template below. Fill every `<bracket>`. Include the top 3–5 moves from Phase 3 verbatim, each with its evidence anchor.

**Quote-in step (mandatory, applies to all three templates below):** Before emitting the handoff, replace EVERY `<bracket>` placeholder with concrete content from the audit. Inline the verdict paragraph from `03-verdict.md` and the top 3–5 moves verbatim into the template. Do NOT leave bare references like "see DESIGN-IS-.../03-verdict.md" — the next session won't have file access to the audit. The emitted handoff must be readable and actionable with zero external lookups.

#### Template: NEW DESIGN

````
/make-plan Design <product/screen/component name> from scratch.

Primary user: <who>
Primary task: <one sentence>
Constraints: <brand, stack, deadline, accessibility floor>

Non-goals (do not design these now):
- <explicit out-of-scope item 1>
- <explicit out-of-scope item 2>
- <explicit out-of-scope item 3>

Reference principles to optimize for, in order:
1. Useful (#2) — <what useful looks like here>
2. Understandable (#4) — <what clarity looks like here>
3. As little design as possible (#10) — <what restraint looks like here>

Deliverables for the plan:
- Information architecture (one screen map or component tree)
- Primary flow wireframe (low-fi, labeled)
- Token decisions (type scale, spacing scale, color count cap)
- States checklist (empty, loading, error, success, focus, disabled)
- Honesty audit on every user-facing string before ship

Anti-patterns to guard against (specific to NEW):
- Decoration without function
- Novel interactions without precedent
- Copy that overpromises
- Designing for screens the Non-goals list excluded
````

#### Template: REFINE DESIGN

````
/make-plan Refine <product/screen/component name> based on a Dieter Rams audit (total <X>/30).

Verdict paragraph (quoted from 03-verdict.md):
> <paste the one-sentence verdict here>

Keep (already strong, do NOT touch in this pass):
- Principle #<N> (<name>) scored 3 — Evidence: <file:line or anchor>. Regression check: <what to grep / re-test to confirm it still scores 3 after the refine>.
- <repeat for every principle that scored 3>

Fix in priority order (top 3–5 moves from the audit, verbatim):
1. <Principle # — short name>: <specific move>. Evidence: <file:line or anchor>.
2. <Principle # — short name>: <specific move>. Evidence: <file:line or anchor>.
3. <Principle # — short name>: <specific move>. Evidence: <file:line or anchor>.
4. <optional 4th>
5. <optional 5th>

Out of scope for this refine pass: <explicit list — what NOT to touch>

Deliverables for the plan:
- Per-fix: target files, exact change, verification step
- Token/spec changes consolidated in one place
- Regression checklist for every "Keep" item above

Anti-patterns to guard against (specific to REFINE):
- Adding new abstractions where a direct change suffices
- Restyling areas that already scored 3
- Scope creep into structural redesign (if structure must change, this should be REDESIGN, not REFINE)
- Letting fixes mutate principles outside the priority list
````

#### Template: REDESIGN

````
/make-plan Redesign <product/screen/component name>. Current design failed audit at <X>/30 with critical gaps in principles <comma-separated list of 0-scored or 1-scored load-bearing principles>.

Verdict paragraph (quoted from 03-verdict.md):
> <paste the one-sentence verdict here>

Why redesign and not refine: <one sentence — usually a load-bearing principle (#2, #4, or #6) scored 0, or total is below threshold>

Preserve from current design (MUST be non-empty — at minimum, name the brand tokens):
- <specific element 1, with file:line>
- <specific element 2, with file:line>
- (if structurally nothing survives, write: "Brand tokens only — color palette and logo. Discard everything else.")

Discard (MUST be non-empty — name the structural patterns causing the failures):
- <pattern 1>. Evidence: <file:line>. Caused failure on principle #<N>.
- <pattern 2>. Evidence: <file:line>. Caused failure on principle #<N>.

Top 3–5 moves from the audit (verbatim):
1. <Principle # — short name>: <specific move>. Evidence: <file:line>.
2. <Principle # — short name>: <specific move>. Evidence: <file:line>.
3. <Principle # — short name>: <specific move>. Evidence: <file:line>.

Redesign principles in priority order:
1. <Principle # — name> — <what success looks like>
2. <Principle # — name> — <what success looks like>
3. <Principle # — name> — <what success looks like>

Deliverables for the plan:
- New information architecture (not derived from old)
- New primary flow (low-fi, labeled, compared side-by-side to current)
- States checklist (empty, loading, error, success, focus, disabled)
- Migration path for users currently on the old design
- Cutover criteria (when is the old design retired)

Anti-patterns to guard against (specific to REDESIGN):
- Porting old structure under new styling
- Keeping both designs behind a flag indefinitely
- Redesigning to follow a trend rather than the principles above
- Treating the Preserve list as optional — it must be filled before this handoff is valid
````

## Key Principles (for the auditor)

- **Evidence over taste** — every score cites a source; "feels wrong" is not a finding
- **Score what is, not what was intended** — design is what ships, not what was drawn
- **Honesty applies to the audit too** — if total is 28/30, say REFINE even if the user wanted a redesign; if it's 12/30, say REDESIGN even if the user wanted a refine
- **One verdict, not three** — pick NEW or REFINE or REDESIGN; do not hedge
- **Handoff, don't implement** — `design-is` ends at the `/make-plan` prompt; `/make-plan` and `/do` take it from there
- **Verdict commitment** — Once `02-scorecard.md` is written, the verdict follows the Phase 3 rule mechanically. Never re-score to back into a preferred verdict; if the scorecard says REDESIGN, the handoff is REDESIGN.

## Failure Modes to Prevent

- Scoring from screenshots alone without reading the code — redeploy with structural subagent
- Scoring the codebase instead of the design — re-anchor on user-facing evidence
- Awarding 3s generously to soften the verdict — recalibrate against the per-principle anchors in Phase 2
- Producing a handoff prompt that doesn't quote the verdict and top moves — the next session is blind without them
- Skipping Phase 0 scope lock — auditing the wrong surface wastes Phase 1
- **Sunk-cost reasoning** — recommending REFINE because the codebase is large; sunk cost is not a design principle
- **Hedging across verdicts** — "could be REFINE or REDESIGN depending on..." — pick one
- **Score inflation to match a desired verdict** — score the evidence, then read the verdict off the rule
- **Letting Phase 0 user preference override Phase 3 evidence** — the user can disagree with the verdict, but the audit reports what the evidence says
