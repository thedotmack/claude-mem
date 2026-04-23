---
name: pathfinder
description: Map a codebase into feature-grouped flowcharts, identify duplicated concerns across features, and propose a unified architecture. Use when asked to "find the ideal path," unify duplicated systems, or audit architecture before a refactor. Emits a proposed unified flowchart plus per-system /make-plan prompts.
---

# Pathfinder

You are an ORCHESTRATOR. Map the codebase into feature-grouped flowcharts, identify duplicated concerns, propose the simplest unified architecture, and hand off per-system plans to `/make-plan`.

You do not write implementation code. You produce diagrams, a duplication report, a proposed unified flowchart, and handoff prompts.

## Delegation Model

Use subagents for *discovery and extraction* (file reading, flow tracing, grep, diagramming). Keep *synthesis* (deciding feature boundaries, picking unification strategies, final flowchart) with the orchestrator. Reject subagent reports that lack source citations and redeploy.

### Subagent Reporting Contract (MANDATORY)

Each subagent response must include:
1. Sources consulted — exact file paths and line ranges read
2. Concrete findings — exact function names, call sites, data flow
3. Mermaid diagram(s) with nodes labeled by `file:line`
4. Confidence note + known gaps

## Output Artifacts

All artifacts go in `PATHFINDER-<YYYY-MM-DD>/` at repo root:
- `00-features.md` — feature inventory with boundaries
- `01-flowcharts/<feature>.md` — one Mermaid flowchart per feature
- `02-duplication-report.md` — cross-cutting duplicated concerns with evidence
- `03-unified-proposal.md` — proposed unified architecture + Mermaid
- `04-handoff-prompts.md` — copy-pasteable `/make-plan` prompts per unified system

## Phases

### Phase 0: Feature Discovery (ALWAYS FIRST)

Deploy ONE "Feature Discovery" subagent to:
1. Walk the source tree (not built artifacts) and read top-level README / CLAUDE.md
2. Propose feature boundaries based on directory structure, import graph, and naming
3. Return a flat list of features with: name, entry points (file:line), core files, brief purpose

Orchestrator reviews the proposal, adjusts boundaries if needed, writes `00-features.md`. Do NOT fan out until feature boundaries are approved.

### Phase 1: Per-Feature Flowcharts (FAN OUT)

Deploy ONE "Flowchart" subagent per feature in parallel. Each receives only its feature's scope. Each must:
1. Trace the feature's primary happy path from entry point to terminal state
2. Identify side effects (DB writes, HTTP calls, file I/O, process spawns)
3. Note error and fallback branches but do not let them dominate the diagram
4. Produce a Mermaid `flowchart TD` with every node labeled `Name<br/>file:line`
5. List external dependencies (other features it calls into) at the bottom

Orchestrator writes each flowchart to `01-flowcharts/<feature>.md`. Reject any diagram missing `file:line` labels.

### Phase 2: Duplication Hunt

Deploy TWO subagents in parallel:

**"Within-Feature Duplication"** subagent:
- For each feature, find repeated code/logic patterns inside the feature only
- Report only duplications worth consolidating (ignore trivial repetition)

**"Cross-Feature Duplication"** subagent:
- Compare flowcharts across features for concerns that appear in multiple places
- Examples of what to look for: multiple capture paths, parallel queue implementations, duplicated storage/migration code, repeated agent scaffolding, parallel parsing layers
- For each duplication, report: (a) the concern, (b) every location with `file:line`, (c) why they diverged, (d) whether the divergence is legitimate specialization or accidental

Orchestrator synthesizes both into `02-duplication-report.md`. Every duplication claim must cite ≥2 `file:line` locations.

### Phase 3: Unified Proposal (ORCHESTRATOR)

The orchestrator writes `03-unified-proposal.md` itself — do not delegate synthesis.

For each duplicated concern from Phase 2 that is NOT legitimate specialization:
1. Propose the simplest unified design (one path, one store, one handler — whatever applies)
2. Name the consolidated component and its single entry point
3. Show what each old call site becomes
4. Call out any loss of capability and whether it's acceptable

End the document with ONE combined Mermaid flowchart showing the proposed unified system. Nodes still labeled with target `file:line` (new or existing) where knowable.

**Anti-patterns to reject in your own proposal:**
- Adding a new abstraction layer "for flexibility"
- Keeping both old paths behind a feature flag
- Introducing a registry/factory when a switch statement suffices
- Preserving divergent behavior "just in case"

### Phase 4: Per-System Handoff Prompts

For each unified system in the proposal, write a ready-to-run `/make-plan` prompt to `04-handoff-prompts.md`. Each prompt must:
1. State the target unified component and its single entry point
2. List the exact call sites to rewrite (from Phase 2 evidence)
3. Cite the relevant flowchart file from `01-flowcharts/`
4. Include anti-pattern guards specific to this system

Format each as a fenced code block the user can copy directly into `/make-plan`.

## Key Principles

- **Evidence over intuition** — every diagram node and duplication claim cites `file:line`
- **Current state before ideal state** — Phases 0–2 describe what IS; Phase 3 describes what SHOULD BE
- **Simplest unification wins** — prefer deletion over abstraction; prefer one path over configurable paths
- **Specialization is not duplication** — two components serving different trust models or data sources are legitimate even if their code looks similar
- **Handoff, don't implement** — Pathfinder ends at plan prompts; `/make-plan` and `/do` take it from there

## Failure Modes to Prevent

- Drawing flowcharts from memory instead of source — redeploy subagent with grep evidence requirement
- Proposing unification of legitimately specialized components — re-examine trust/data-source divergence
- Handoff prompts that lack concrete call sites — rewrite with Phase 2 evidence
- Skipping Phase 0 boundary review — fanning out on bad feature boundaries wastes all of Phase 1
