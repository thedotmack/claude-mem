---
name: focus-plan
description: Help the owner plan their focus areas from the evidence in My Work. Proposes, as suggestions only, a priority order with reasons, the initiatives to file the areas under, sharper goal sentences, a first draft of notes, and next asks. Use when asked to "help me plan my focus areas", "what should I work on next", "prioritize my focus areas", "sharpen my goals", or when My Work's planning help starts a plan.
---

# Focus Plan

The owner steers their agents through a small number of focus areas. Each area has a name, a one-sentence goal, the owner's own notes on why it matters, and a place in the owner's order. Under each area sit the requests the owner has made, each with its state and its last review.

This skill reads all of that and proposes a plan. **Everything it produces is a suggestion.** Nothing is applied. The owner reads each proposal in My Work and accepts or ignores it, and an accepted proposal is saved by the owner's own action (reorder, file under an initiative, edit the goal, edit the notes).

## 1. Read the plan input

When the worker starts this skill it gives the plan input inline:

- `scope`: `all` (every focus area) or `one` (a single area).
- `areas`: each with `focusAreaId`, `name`, `goal`, `notes`, `status` (`kept` or `suggested`), `position` (1 is the owner's top priority), `initiative` (the heading the area sits under now, or null), `initiativeFrom` (`owner` when the owner filed it there, `guess` when it is only the name of a folder), `folders` (the folders its requests ran in, most used first), and `requests`. Each request has its `title`, `state`, `percent`, `summary`, `nextStep`, `question` (what its agent is waiting to be told) and `asks`: the owner's own words, verbatim.
- `currentOrder`: the ids of the kept areas in the owner's current order. Empty when `scope` is `one`.
- `ownerInitiatives`: the initiative names the owner already uses.

Run by hand, read the same facts from My Work's focus areas and the request-progress reviews before proposing anything.

## 2. Propose

Propose only where you have something better than what is there. An empty list is a good answer for an area that is already clear and moving.

**Priority order** (`reorder`, only when `scope` is `all`, at most one). List every id in `currentOrder` once, in the order you propose. For each area you move, give one line of reasoning from the evidence: what is blocked on the owner, what is close to shipping, what has stalled, what the owner keeps asking for. Do not propose the order the owner already has.

**Initiatives** (`initiative`, one per initiative). The owner's page calls an initiative a **project**, so write "project" in every `reason`; the JSON key stays `initiative`. An initiative is a product or venture as the owner thinks of it, and it is the heading several focus areas sit under. A folder is not an initiative: one product is often built in several folders, and several small folders are often one thing to the owner. Group the areas by what they are for, from their names, goals, notes and asks; use `folders` only as a hint. Each proposal names one initiative (at most 60 characters), lists the `focusAreaIds` to file under it, and gives one line of reasoning.

- Never move an area whose `initiativeFrom` is `owner`: the owner filed it, and it stays.
- Reuse a name from `ownerInitiatives`, spelled the same, whenever an area belongs there.
- Prefer a few meaningful initiatives to one per folder. When several small unrelated areas are each an experiment or a side idea, file them together under one catch-all initiative (for example "Small experiments") instead of giving each its own.
- Propose nothing for an area whose guess is already the right name and stands alone.

**A sharper goal** (`goal`). Only where the current goal is vague, missing, or no longer matches what the owner asks for in that area. One sentence, at most 300 characters, that says what done looks like. Give the reason in one line.

**A first draft of notes** (`notes`). Only for an area whose `notes` is null. Never draft over the owner's notes. Write why the area matters and what the owner seems to want from it, from the evidence: at most 2000 characters. It is shown as a draft from evidence, so it must quote the owner: put one to four of the owner's asks in `quotes`, word for word, exactly as they appear in that area's `asks`. A quote the owner did not type refuses the draft.

**Next asks** (`next-asks`). Up to three per area: the next thing the owner could ask an agent to do, written as the ask itself, each with one line saying why now. Prefer what unblocks a waiting request or finishes one that is nearly done.

Never invent a request, a state or a quote. Reasons name what the input shows.

**Language.** Write every proposal in the human language most of the owner's asks are written in. Quotes stay as typed.

## 3. Output

Reply with only this JSON:

```json
{
  "proposals": [
    { "kind": "reorder", "focusAreaIds": ["fa_b", "fa_a"], "moves": [{ "focusAreaId": "fa_b", "reason": "Two requests wait on your answer." }] },
    { "kind": "initiative", "initiative": "Kite app", "focusAreaIds": ["fa_a", "fa_c"], "reason": "Both are the same product, built in two folders." },
    { "kind": "goal", "focusAreaId": "fa_a", "goal": "Every agent chat can be answered from My Work.", "reason": "The current goal names the page, not the outcome." },
    { "kind": "notes", "focusAreaId": "fa_b", "notes": "Why it matters: …", "quotes": ["answer an agent's question and have it reach the agent"] },
    { "kind": "next-asks", "focusAreaId": "fa_a", "asks": [{ "text": "Wire the answer box to the new route.", "reason": "The route shipped; the row still copies." }] }
  ]
}
```

The worker checks each proposal against the input, saves the ones that pass as the plan (`planning`, then `ready` or `failed`), and names the ones it left out. One plan is one run: if it fails, the failure is shown and nothing tries again until the owner asks.
