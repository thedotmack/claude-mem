---
name: design-is
description: Design or critique a UI through Dieter Rams' ten "Good design is..." principles. Two modes — CONCEIVE produces an actual design (the reframe, the metaphor, key surfaces sketched, voice, honesty guardrails); CRITIQUE reads an existing design against the principles with evidence and names the highest-leverage moves. Use when the user says "design a better X", "conceive a new viewer", "rethink this UI", "audit this design", "critique this UI", "is this good design", or "check this against Rams".
---

# Design Is

Use Dieter Rams' ten principles as a **lens for design**, not a scoring form. The deliverable is a design (or an honest critique) — never a folder of process artifacts and never a handoff that punts the real work to another skill.

## Two modes

Pick from the request:

- **CONCEIVE** (generative) — "design a better X", "conceive a viewer", "rethink this UI", or no artifact exists yet. → You produce an actual design.
- **CRITIQUE** (evaluative) — "audit this", "is this good", "what's wrong with this UI", an artifact exists and the user wants judgment. → You produce an evidenced read.

Default to CONCEIVE when the user describes a *better thing they want*; CRITIQUE when they point at something and ask *if it's good*. They often chain (critique → conceive), but never start CONCEIVE by re-auditing what you're replacing — that's the trap that buries the design under meta.

## Do not use for

- Routine UI code reviews → use `/review`
- Pure copy edits → use a separate copy pass

## The Ten Principles (Dieter Rams)

1. **Good design is innovative** — Does it advance the form, or imitate? Innovation rides on technology; never an end in itself.
2. **Good design makes a product useful** — Does it serve the primary task? Emphasizes usefulness; disregards anything that detracts.
3. **Good design is aesthetic** — Is it beautiful? Only well-executed objects can be beautiful; aesthetic quality affects well-being.
4. **Good design makes a product understandable** — Does the structure clarify function? Is it self-explanatory?
5. **Good design is unobtrusive** — Does it stay out of the way? Leave room for self-expression.
6. **Good design is honest** — Does it claim only what it is? No false promises, no manipulation, no inflated value.
7. **Good design is long-lasting** — Will it age well? Avoids being fashionable; never appears antiquated.
8. **Good design is thorough down to the last detail** — Are edges, empty states, errors, focus rings, motion all considered? Care expresses respect for the user.
9. **Good design is environmentally friendly** — Does it conserve resources? In software: bundle weight, energy, attention, cognitive load.
10. **Good design is as little design as possible** — Less, but better. Concentrate on essentials; back to purity, back to simplicity.

> If the user wrote "Dieter Braun," they mean Dieter Rams. Don't correct them inline; just use the right principles.

The principles are a **lens**, never a rubric to back a predetermined answer into. The load-bearing three for software are usually **#2 useful, #4 understandable, #6 honest** — when they conflict with the rest, they win. In CONCEIVE they're generative questions (design *toward* them). In CRITIQUE they're a checklist (find where the design honors or violates each, with evidence).

## CONCEIVE mode

Hand back an **actual design**, not a plan to make one. A design is a *position*, not a feature list — so think it through before sketching. Work the steps below, then write ONE design doc.

1. **Reframe** — what is this thing *really*, to the person using it? Name the metaphor. What honest form does its claim demand? (#6) This is the spine; get it right and the rest follows.
2. **The moments** — who opens it, when, and what they need each time. Design for the primary task (#2). The most frequent or highest-trust moment leads the layout.
3. **North star** — one sentence the whole design serves.
4. **Core surfaces** — the few screens/states that carry the product. Sketch each concretely (ASCII layout is fine) as an *experience*, not a spec. Make structure clarify function (#4).
5. **The distinctive move** — what can THIS design do that a generic one can't, given its actual data/material? If the answer is "nothing," the design isn't done.
6. **Voice & aesthetic** — plain language over jargon; restraint over decoration (#5, #10); states designed in, not bolted on — empty, first-run, error, loading (#8).
7. **Honesty guardrails** — where could this design lie? (silent truncation, fake liveness, hidden cost, motion implying value it can't deliver). Design against each one. (#6)
8. **Signature moments** — the 3–5 details that make it *felt*, not just correct.
9. **Minimum vs. full** — what actually fixes the problem vs. what makes it singular, so it's buildable without over-building. (#10)

**Output:** one `<name>-design.md`. No scorecards, no telemetry, no five-file ceremony. Vivid and concrete — sketches over specs, no endpoints/hooks/build steps (that's `/make-plan`'s job, not the design's).

**Then (optional):** if the user wants to build it, offer a short `/make-plan` prompt — a paragraph naming the core surfaces and the must-haves. A paragraph, not a bracket template.

## CRITIQUE mode

An honest, evidenced read — what holds, what fails, what'd make it better. Lightweight.

1. **Look at the real thing.** Read the source and/or open it (use the `browse`/agent-browser skill if it's running). Score what *ships*, not what was intended.
2. **Walk the ten principles.** For each, one line: honors or violates, plus the evidence (`file:line`, a quoted string, a screenshot region, a measured value). Evidence over taste — "feels wrong" is not a finding.
3. **Call it.** Where is the design strong, where weak, and is the right move to **refine** (bones are good) or **rethink** (a load-bearing principle — #2/#4/#6 — is broken)? One sentence; don't hedge across both.
4. **Highest-leverage moves** — the 3–5 changes that move it most, each tied to a principle and its evidence.

Telemetry (byte counts, contrast ratios, time-to-interactive, ARIA audits) is **optional** — gather it only when a verdict actually turns on a number you can't eyeball (usually #9 weight or accessibility). Don't instrument by default; it's noise on a design read.

Honesty applies to the critique itself: if it's mostly good, say so; if it's broken, say so — regardless of what the user hoped to hear.

**Then (optional):** chain to CONCEIVE (if rethinking) or hand a short `/make-plan` prompt (if refining) — only if the user wants to proceed.

## Discipline

- **Evidence over taste** (critique); **position over feature-list** (conceive).
- **Judge/design what is**, not what was intended or hoped for.
- **One doc out**, not a folder of artifacts. The design — or the critique — *is* the deliverable. This skill never offloads the real work to a handoff.
- **Don't over-process.** If you're collecting metrics or filling templates instead of designing, stop and design.
