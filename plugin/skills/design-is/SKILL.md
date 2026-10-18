---
name: design-is
description: Audit a UI or product design against Dieter Rams' 10 principles, score each principle 0–3 with source evidence, determine an outcome verdict (NEW DESIGN, REFINE, or REDESIGN), and generate a self-contained /make-plan handoff prompt when triggered by "audit this design", "design review", "check this UI against Rams", "is this UI good", "critique this design", "design audit", or design critique requests leading to an execution plan, excluding routine UI code reviews (/review), isolated copy edits, and pre-design ideation lacking an existing artifact (/make-plan).
---

# Design Is

## Operational Scope & Task Routing

- Route incoming requests to the target execution workflow based on task classification:
  + Design audit and planning handoff (`"audit this design"`, `"design review"`, `"check this UI against Rams"`, `"is this UI good"`, `"critique this design"`, `"design audit"`, or design critiques requiring an execution plan) ➔ Execute the `design-is` orchestration pipeline.
  + Routine UI code review ➔ Route to `/review`.
  + Isolated copy editing ➔ Route to a dedicated copy pass.
  + Pre-design ideation lacking an existing artifact ➔ Route directly to `/make-plan`, or bypass `Evidence Gathering` and `Quantitative Scoring` to emit a `NEW DESIGN` handoff prompt.
- Resolve entity alias references directly to the canonical evaluation framework, excluding inline user correction:
  + `"Dieter Braun"` ➔ Dieter Rams' 10 principles.
- Restrict deliverable generation to diagnostic evidence, quantitative scorecards, outcome verdicts, and `/make-plan` handoff prompts stored inside `DESIGN-IS-<YYYY-MM-DD>/` at the repository root or user-specified project path, excluding implementation source code generation:
  + `00-scope.md` ➔ Audited surface paths, URLs, screens, primary user, primary task, constraints, and reference materials.
  + `01-evidence.md` ➔ Consolidated per-principle empirical findings collected by subagents.
  + `02-scorecard.md` ➔ Per-principle `0–3` integer scores, single-line justifications, and total score out of `30`.
  + `03-verdict.md` ➔ Deterministic outcome verdict (`NEW DESIGN`, `REFINE`, or `REDESIGN`) with 3–5 prioritized moves.
  + `04-handoff-prompt.md` ➔ Self-contained, copy-pasteable `/make-plan` prompt matching the selected verdict.

## Orchestration & Subagent Delegation Contract

- Partition execution responsibilities between the orchestrator and parallel evidence-gathering subagents:
  + Subagent authority: Execute component reading, contrast measurement, element counting, token inspection, and live screenshot/style capture via `agent-browser`, returning structured factual measurements and source citations, excluding narrative prose paragraphs, subjective opinions, and principle scores.
  + Orchestrator authority: Execute scope locking, subagent report validation, evidence synthesis, `0–3` principle scoring, verdict selection, and `/make-plan` prompt assembly.
- Enforce the 4-field reporting schema across each subagent response:
  1. `Sources consulted`: Exact file paths and line ranges (`file:line`) or screenshot regions.
  2. `Concrete findings`: Verified present and missing interface elements accompanied by verbatim quotes or measured values.
  3. `Per-principle facts`: Objective empirical observations mapped to target principles, excluding score assignments.
  4. `Known gaps`: Uninspected surfaces or properties accompanied by the technical cause preventing inspection.
- Validate each subagent report upon receipt: reject and redeploy any subagent report that omits source citations (`file:line`, screenshot region, copy excerpt, or measured value), evaluates screenshots in isolation when source code is accessible, or assigns principle scores.

## Execution Workflow

Execute the audit pipeline across 5 sequential stages: `Scope Lock (00-scope.md) ➔ Evidence Gathering (01-evidence.md) ➔ Quantitative Scoring (02-scorecard.md) ➔ Verdict Determination (03-verdict.md) ➔ Plan Handoff Generation (04-handoff-prompt.md)`.

### Scope Lock

- Extract from the input context or query the user to record 4 scope parameters in `DESIGN-IS-<YYYY-MM-DD>/00-scope.md` prior to evidence collection:
  + Audited surface: Live URL, repository path, Figma frame, or component identifier.
  + Target user and task: Primary user persona and primary task flow.
  + Operational constraints: Brand guidelines, technology stack, delivery deadline, and accessibility floor.
  + Comparative baseline: Reference designs or competitor products.
- Evaluate artifact maturity: bypass `Evidence Gathering` and `Quantitative Scoring` and transition directly to `Verdict Determination` with verdict = `NEW DESIGN` when the target design is uncreated or consists of a stub/wireframe lacking preservable design decisions.

### Evidence Gathering

- Deploy 4 core subagents in parallel and 1 conditional subagent to return only the required structured fields:
  + `Structural Evidence` (deploy unconditionally):
    - Total interactive-element count on the audited surface.
    - Maximum nesting depth of the primary component tree.
    - Repeated-pattern count (identical affordance appearing in `> 1` location serving the same purpose).
    - Dead-prop and unused-import count.
    - Exact `file:line` citations for each reported count.
  + `Visual Evidence` (deploy unconditionally):
    - Inspection mode selection:
      + Reachable URL or running development server ➔ Execute the `agent-browser` skill for screenshot capture and computed-style inspection.
      + Static repository lacking a running instance ➔ Inspect source CSS, design tokens, and component files to extract derived facts tagged `"INFERRED"`.
    - Spacing scale observed (`px` array).
    - Type scale observed (`px` array).
    - Distinct color count (unique hex/oklch tokens rendered or referenced).
    - Lowest contrast ratio observed across primary text.
    - UI state coverage checklist across 6 states (`empty`, `loading`, `error`, `success`, `focus`, `disabled`), recording `present` or `missing` per state.
  + `Copy & Honesty` (deploy unconditionally):
    - Complete list of user-facing strings with `file:line` citations.
    - Flagged value inflations (unsubstantiated marketing superlatives).
    - Flagged dark patterns (forced continuity, hidden cost, fake scarcity, confirmshaming).
    - Flagged domain jargon or ambiguous labels paired with plain-language replacements.
    - Label-to-behavior mismatches citing `file:line` for both the label declaration and the execution logic.
  + `Weight & Friction` (deploy unconditionally):
    - Initial JavaScript payload size in bytes (numeric value).
    - Network request count for the primary view (numeric value).
    - Time-to-interactive in milliseconds (measured or estimated numeric value accompanied by calculation method).
    - Animation count on the idle screen (numeric value).
    - Notification, badge, and modal count on initial load (numeric value).
  + `Accessibility Evidence` (deploy conditionally when the target contains an interactive UI surface, excluding static landing pages limited to non-interactive content):
    - WCAG contrast pass/fail status per text token.
    - Focus order sequence across primary controls.
    - Keyboard reachability status (`yes` / `no`) for each primary action.
    - ARIA landmark count.
    - Skip-link presence status (`yes` / `no`).
- Consolidate validated subagent findings into `DESIGN-IS-<YYYY-MM-DD>/01-evidence.md`, anchoring every entry to user-facing behavior and verified source citations (`file:line`, screenshot region, copy excerpt, or measured value).

### Quantitative Scoring

- Score each of the 10 principles sequentially inside the orchestrator on an integer scale of `0–3` with equal weight, citing `>= 1` piece of evidence from `01-evidence.md` per principle:

| Principle | Operational Criterion | Evidence Source | Score 3 | Score 2 | Score 1 | Score 0 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Good design is innovative** | Advances functional form through technology as an enabler rather than an end in itself, distinct from imitation. | Orchestrator synthesis across all evidence | Introduces a pattern absent from 5+ peer products and ships it with restraint. | Refreshes an existing pattern with a clear functional improvement. | Imitates competitors with minor variation. | Copies a competitor's flow wholesale. |
| **2. Good design makes a product useful** | Serves the primary task directly, emphasizing utility and excluding detracting elements. | `Structural`, `Accessibility` | Completes the primary task in the fewest possible steps, excluding decoy actions. | Completes the primary task while adjacent surfaces add steps. | Requires unnecessary detours to complete the primary task. | Omits direct support for the primary task on the audited screen. |
| **3. Good design is aesthetic** | Achieves visual execution quality through systemic order that supports user well-being. | `Visual` | Aligns spacing, type, and color to a single visible system, excluding orphan styles. | Contains `<= 2` minor inconsistencies across the audited surface. | Contains `3–5` inconsistencies OR `1` jarring violation. | Lacks a visible system OR exhibits active visual noise. |
| **4. Good design makes a product understandable** | Clarifies function through structure so the interface operates as self-explanatory. | `Structural`, `Copy & Honesty`, `Accessibility` | Enables a first-time user to name every primary control accurately. | Requires a tooltip on `1` control. | Contains `2–3` unclear controls; domain jargon present. | Obscures the primary action in the absence of external help. |
| **5. Good design is unobtrusive** | Recedes as neutral background infrastructure, leaving room for user content and self-expression. | `Structural`, `Visual` | Subordinates chrome so content forms the figure and UI forms the ground. | Renders visible chrome with quiet visual weight. | Introduces decoration that competes with content. | Dominates content with UI chrome. |
| **6. Good design is honest** | States only actual product capabilities, excluding false promises, manipulation, and inflated value. | `Copy & Honesty` | Maps every claim, badge, and label 1:1 to actual runtime behavior. | Contains `<= 1` minor inflation (e.g., `"powerful"` once). | Contains `>= 2` inflations OR `1` dark pattern. | Implements any deceptive flow (forced continuity, hidden cost, fake scarcity). |
| **7. Good design is long-lasting** | Maintains visual durability over time, excluding transient fashion that renders the interface antiquated. | Orchestrator synthesis across all evidence | Exhibits zero dated trend markers; reads as current 3 years from audit date. | Contains `1` dated trend marker. | Contains `2–3` dated markers (skeuomorph residue, fad gradients, trend typography). | Reads as a specific single year's trend. |
| **8. Good design is thorough down to the last detail** | Addresses edges, empty states, errors, focus rings, and motion curves with precision. | `Visual` | Implements and refines all 6 states (`empty`, `loading`, `error`, `success`, `focus`, `disabled`). | Omits or leaves rough `1` state. | Omits `2–3` states. | Omits `>= 4` states or relies on unstyled browser defaults. |
| **9. Good design is environmentally friendly** | Conserves computational and human resources across bundle weight, energy, attention, and cognitive load. | `Weight & Friction` | Maintains initial JS `< 100KB`, zero idle animation, honored dark mode, and respected `prefers-reduced-motion`. | Maintains initial JS `< 500KB` with gated motion. | Produces initial JS `500KB–2MB` with continuous motion. | Exceeds `2MB` initial JS OR runs autoplay video OR ignores dark mode. |
| **10. Good design is as little design as possible** | Concentrates on essential elements ("Less, but better"), returning to structural purity and simplicity. | `Structural` | Binds every element to task execution such that removing any single element breaks the task. | Contains `<= 2` removable elements. | Contains `3–5` removable elements. | Populates the page with decoration or duplicated affordances. |

- Apply 4 calibration constraints when computing scores:
  + Shipped-surface grounding: Evaluate actual rendered user-facing behavior rather than unshipped design intent or internal codebase architecture.
  + Lower-bound tie-breaker: Select the lower integer score whenever evidence falls between two adjacent rubric levels, prioritizing calibration convergence over score generosity.
  + Worst-instance floor: Score the lowest-performing instance whenever a principle manifests across multiple instances on the audited surface, excluding mean averaging.
  + Unweighted integer sum: Keep each principle score as an integer in `[0, 3]` and sum all 10 scores to produce a maximum total of `30`, excluding bonus points or differential weights.
- Write `DESIGN-IS-<YYYY-MM-DD>/02-scorecard.md` using the fixed entry schema for each principle followed by the total sum:

```text
N. Good design is <principle> — Score: X/3
   Evidence: <one-line summary citing 01-evidence.md anchors>
   Justification: <one sentence on why this score, not the one above or below>
```

### Verdict Determination

- Select exactly 1 outcome verdict for `DESIGN-IS-<YYYY-MM-DD>/03-verdict.md` by applying the decision rules mechanically to `02-scorecard.md`:
  + `NEW DESIGN`: Target design is uncreated, OR the existing artifact is a stub/wireframe lacking preservable design decisions.
  + `REFINE`: Total score `>= 20` AND every individual principle scores `>= 1` (zero principles scored `0`).
  + `REDESIGN`: Total score `< 20`, OR any principle scores `0` on a load-bearing dimension (specifically `#2 useful`, `#4 understandable`, or `#6 honest`, or any individual `0`-scored principle).
- Resolve conflict hierarchy during verdict selection in descending priority order: `Scorecard Mathematical Rule > Verified User-Facing Evidence > Scope Containment > User Initial Preference`, excluding multi-verdict hedging, retroactive score adjustments, sunk-cost preservation of large codebases, or full-system redesigns triggered by an isolated single-screen defect.
- Format `03-verdict.md` with two sequential elements:
  1. A single-sentence verdict declaration stating the chosen outcome (`NEW DESIGN`, `REFINE`, or `REDESIGN`) and its decisive score/principle basis.
  2. A prioritized list of the 3–5 highest-leverage corrective moves, binding each move to its principle number and verified evidence anchor (`file:line` or `01-evidence.md` citation).

### Plan Handoff Generation

- Generate `DESIGN-IS-<YYYY-MM-DD>/04-handoff-prompt.md` containing 1 fenced `/make-plan` prompt matching the verdict from `03-verdict.md`.
- Populate every `<bracket>` parameter with concrete content from the audit, inline the verbatim single-sentence verdict paragraph from `03-verdict.md`, and embed the 3–5 prioritized moves verbatim with their `file:line` or evidence anchors so the handoff prompt operates as a self-contained specification, excluding external references to `DESIGN-IS-<YYYY-MM-DD>/` files.

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
