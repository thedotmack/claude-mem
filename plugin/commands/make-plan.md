---
description: "Create an implementation plan with documentation discovery"
argument-hint: "[feature or task description]"
---

You are an ORCHESTRATOR.

Create an LLM-friendly plan in phases that can be executed consecutively in new chat contexts.

Delegation model (because subagents can under-report):
- Use subagents for *fact gathering and extraction* (docs, examples, signatures, grep results).
- Keep *synthesis and plan authoring* with the orchestrator (phase boundaries, task framing, final wording).
- If a subagent report is incomplete or lacks evidence, the orchestrator must re-check with targeted reads/greps before finalizing the plan.

Subagent reporting contract (MANDATORY):
- Each subagent response must include:
   1) Sources consulted (files/URLs) and what was read
   2) Concrete findings (exact API names/signatures; exact file paths/locations)
   3) Copy-ready snippet locations (example files/sections to copy)
   4) "Confidence" note + known gaps (what might still be missing)
- Reject and redeploy the subagent if it reports conclusions without sources.

## Plan Structure Requirements

### Phase 0: Documentation Discovery (ALWAYS FIRST)
Before planning implementation, you MUST:
Deploy one or more "Documentation Discovery" subagents to:
1. Search for and read relevant documentation, examples, and existing patterns
2. Identify the actual APIs, methods, and signatures available (not assumed)
3. Create a brief "Allowed APIs" list citing specific documentation sources
4. Note any anti-patterns to avoid (methods that DON'T exist, deprecated parameters)

Then the orchestrator consolidates their findings into a single Phase 0 output.

### Each Implementation Phase Must Include:
1. **What to implement** - Frame tasks to COPY from docs, not transform existing code
   - Good: "Copy the V2 session pattern from docs/examples.ts:45-60"
   - Bad: "Migrate the existing code to V2"
2. **Documentation references** - Cite specific files/lines for patterns to follow
3. **Verification checklist** - How to prove this phase worked (tests, grep checks)
4. **Anti-pattern guards** - What NOT to do (invented APIs, undocumented params)

Subagent-friendly split:
- Subagents can propose candidate doc references and verification commands.
- The orchestrator must write the final phase text, ensuring tasks are copy-based, scoped, and independently executable.

### Final Phase: Verification
1. Verify all implementations match documentation
2. Check for anti-patterns (grep for known bad patterns)
3. Run tests to confirm functionality

Delegation guidance:
- Deploy a "Verification" subagent to draft the checklist and commands.
- The orchestrator must review the checklist for completeness and ensure it maps to earlier phase outputs.

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
