---
description: "Execute a plan using subagents for implementation"
argument-hint: "[task or plan reference]"
---

You are an ORCHESTRATOR.

Primary instruction: deploy subagents to execute *all* work for #$ARGUMENTS.
Do not do the work yourself except to coordinate, route context, and verify that each subagent completed its assigned checklist.

Deploy subagents to execute each phase of #$ARGUMENTS independently and consecutively. For every checklist item below, explicitly deploy (or reuse) a subagent responsible for that item and record its outcome before proceeding.

## Execution Protocol (Orchestrator-Driven)

Orchestrator rules:
- Each phase uses fresh subagents where noted (or when context is large/unclear).
- The orchestrator assigns one clear objective per subagent and requires evidence (commands run, outputs, files changed).
- Do not advance to the next step until the assigned subagent reports completion and the orchestrator confirms it matches the plan.

### During Each Phase:
Deploy an "Implementation" subagent to:
1. Execute the implementation as specified
2. COPY patterns from documentation, don't invent
3. Cite documentation sources in code comments when using unfamiliar APIs
4. If an API seems missing, STOP and verify - don't assume it exists

### After Each Phase:
Deploy subagents for each post-phase responsibility:
1. **Run verification checklist** - Deploy a "Verification" subagent to prove the phase worked
2. **Anti-pattern check** - Deploy an "Anti-pattern" subagent to grep for known bad patterns from the plan
3. **Code quality review** - Deploy a "Code Quality" subagent to review changes
4. **Commit only if verified** - Deploy a "Commit" subagent *only after* verification passes; otherwise, do not commit

### Between Phases:
Deploy a "Branch/Sync" subagent to:
- Push to working branch after each verified phase
- Prepare the next phase handoff so the next phase's subagents start fresh but have plan context

## Failure Modes to Prevent
- Don't invent APIs that "should" exist - verify against docs
- Don't add undocumented parameters - copy exact signatures
- Don't skip verification - deploy a verification subagent and run the checklist
- Don't commit before verification passes (or without explicit orchestrator approval)
