---
name: do-v2
description: Execute a phased implementation plan using subagents. Use when asked to execute, run, or carry out a plan — especially one created by make-plan-v2.
---

# Do Plan

You are an ORCHESTRATOR. Deploy subagents to execute *all* work. Do not do the work yourself except to coordinate, route context, and verify that each subagent completed its assigned checklist.

## Plan File

- Read the plan from `plan.md` in the project root at start.
- If the plan file cannot be read or is missing, tell the user to run make-plan-v2 first and stop.
- Check staleness: compare the plan's `branch` and `commit_sha` frontmatter against the current git branch and HEAD. If they differ, warn the user before proceeding.
- After each phase, update the plan file:
  - Set `current_phase` to the next phase number
  - Set `overall_status` to `in-progress` (or `complete` when all phases are done)
  - Check off completed tasks (`- [ ]` to `- [x]`)

## Execution Protocol

### Rules

- Each phase uses fresh subagents where noted (or when context is large/unclear)
- Assign one clear objective per subagent and require evidence (commands run, outputs, files changed)
- Do not advance to the next step until the assigned subagent reports completion and the orchestrator confirms it matches the plan

### During Each Phase

Deploy an "Implementation" subagent to:
1. Execute the implementation as specified
2. COPY patterns from documentation, don't invent
3. Cite documentation sources in code comments when using unfamiliar APIs
4. If an API seems missing, STOP and verify — don't assume it exists

### After Each Phase

Deploy subagents for each post-phase responsibility:
1. **Verify must-be-true conditions** — Deploy a "Verification" subagent to check each must-be-true condition using the executable verification commands from the plan
2. **Anti-pattern check** — Deploy an "Anti-pattern" subagent to grep for known bad patterns from the plan
3. **Code quality review** — Deploy a "Code Quality" subagent to review changes
4. **Human gate** — Before deploying the Commit subagent, briefly show the user what changed in this phase (files modified, key changes) and confirm they want to commit
5. **Commit only if verified** — Deploy a "Commit" subagent *only after* verification passes and user confirms; otherwise, do not commit

### Between Phases

Deploy a "Branch/Sync" subagent to:
- Push to working branch after each verified phase
- Prepare the next phase handoff so the next phase's subagents start fresh but have plan context

## Subagent Status Protocol

Each subagent must report one of these statuses:

- **DONE** — Advance to the next step
- **DONE_WITH_CONCERNS** — Show concerns to the user. User decides whether to advance or fix.
- **NEEDS_CONTEXT** — Provide additional context and retry once. If still NEEDS_CONTEXT after retry, treat as BLOCKED.
- **BLOCKED** — Stop execution and ask the user for guidance.

## Failure Modes to Prevent

- Don't invent APIs that "should" exist — verify against docs
- Don't add undocumented parameters — copy exact signatures
- Don't skip verification — deploy a verification subagent and run the checklist
- Don't commit before verification passes (or without explicit orchestrator approval)
- Don't ignore DONE_WITH_CONCERNS — surface every concern to the user before advancing
- Don't check task completion — check whether the must-be-true conditions actually hold
