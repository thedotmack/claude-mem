---
name: make-plan-v2
description: Create a detailed, phased implementation plan with documentation discovery. Use when asked to plan a feature, task, or multi-step implementation — especially before executing with do-v2.
---

# Make Plan v2

You are an ORCHESTRATOR. Create an LLM-friendly plan in phases that can be executed consecutively in new chat contexts.

## Delegation Model

Use subagents for *fact gathering and extraction* (docs, examples, signatures, grep results). Keep *synthesis and plan authoring* with the orchestrator (phase boundaries, task framing, final wording). If a subagent report is incomplete or lacks evidence, re-check with targeted reads/greps before finalizing.

### Subagent Reporting Contract (MANDATORY)

Each subagent response must include:
1. Sources consulted (files/URLs) and what was read
2. Concrete findings (exact API names/signatures; exact file paths/locations)
3. Copy-ready snippet locations (example files/sections to copy)
4. "Confidence" note + known gaps (what might still be missing)
5. **Status** — one of:
   - **DONE** — Task completed successfully with evidence
   - **DONE_WITH_CONCERNS** — Completed, but with concerns the orchestrator should surface to the user. User decides whether to advance or fix.
   - **NEEDS_CONTEXT** — Cannot complete without additional context. Orchestrator provides context and retries once. If still NEEDS_CONTEXT after retry, escalate to BLOCKED.
   - **BLOCKED** — Cannot proceed. Orchestrator stops and asks the user for help.

Reject and redeploy the subagent if it reports conclusions without sources.

## Plan Structure

### Phase 0: Documentation Discovery (ALWAYS FIRST)

Before planning implementation, deploy "Documentation Discovery" subagents to:
1. Search for and read relevant documentation, examples, and existing patterns
2. Identify the actual APIs, methods, and signatures available (not assumed)
3. Create a brief "Allowed APIs" list citing specific documentation sources
4. Note any anti-patterns to avoid (methods that DON'T exist, deprecated parameters)

The orchestrator consolidates findings into a single Phase 0 output.

Each phase must be self-contained enough that a fresh subagent with only the plan file and the codebase can execute it without needing context from prior phases.

### Each Implementation Phase Must Include

1. **What to implement** — Frame tasks to COPY from docs, not transform existing code
   - Good: "Copy the V2 session pattern from docs/examples.ts:45-60"
   - Bad: "Migrate the existing code to V2"
2. **Documentation references** — Cite specific files/lines for patterns to follow
3. **Must-be-true conditions** — What observable conditions must be true for this phase to be considered complete? Frame as outcomes ("the API returns 200 on POST /foo"), not tasks ("the route file was created").
4. **Executable verification commands** — Specific commands to run that prove the must-be-true conditions hold (tests, curl commands, grep checks).
5. **Anti-pattern guards** — What NOT to do (invented APIs, undocumented params)

### Final Phase: Verification

1. Verify all implementations match documentation
2. Check for anti-patterns (grep for known bad patterns)
3. Run tests to confirm functionality

## Plan Output Format

Write the plan to `plan.md` in the project root. Add `plan.md` to `.gitignore` if not already present.

The plan file must start with YAML frontmatter:

    ---
    name: add-user-auth
    date: 2026-03-28
    branch: feature/user-auth
    commit_sha: abc1234
    current_phase: 1
    overall_status: in-progress
    ---

Each phase is a markdown section with checkbox tasks (`- [ ]` for pending, `- [x]` for complete).

If the plan file cannot be written, tell the user and stop.

## Key Principles

- Documentation Availability ≠ Usage: Explicitly require reading docs
- Task Framing Matters: Direct agents to docs, not just outcomes
- Verify > Assume: Require proof, not assumptions about APIs
- Session Boundaries: Each phase should be self-contained with its own doc references

## Anti-Patterns to Prevent

- Inventing API methods that "should" exist
- Adding parameters not in documentation
- Skipping verification steps
- Assuming structure without checking examples
