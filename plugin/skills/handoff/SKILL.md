---
name: handoff
description: Generate a HANDOFF.md that captures goal, current state, files touched, failed attempts, and next steps — so a fresh Claude session can continue exactly where this one left off. Use when sessions are getting long, Claude keeps retrying the same broken solution, or the user wants to step away and resume later.
---

# Handoff

Generate a structured `HANDOFF.md` file that gives a fresh Claude session everything it needs to continue this work without dragging the current degraded context forward.

## When to Use

- The session is long and Claude feels confused or repetitive
- Claude keeps trying the same failing solution over and over
- The user wants to step away and resume later
- `/compact` ran but Claude still lacks clear direction
- The user says "handoff", "generate a handoff", "I want to start fresh", or "write a handoff doc"

## What to Capture

Think hard about the full arc of this conversation before writing. The handoff must be useful to a Claude instance that has never seen this conversation.

### Required Sections

1. **Goal** — One paragraph. What is the user actually trying to accomplish? State the end state, not the current sub-task. Be specific enough that a fresh agent can orient immediately.

2. **Current State** — What is working right now? What is broken? What is the exact symptom of the problem? Include error messages verbatim if relevant.

3. **Files in Play** — List every file that has been read, edited, or created during this session that is relevant to the current task. Use absolute or repo-relative paths. Include a one-line note on why each file matters.

4. **What Has Been Tried (and Why It Failed)** — This is the most important section. List every approach attempted that did not work, and explain WHY it failed (not just that it failed). A fresh agent that skips this section will repeat the same mistakes.

5. **Current Best Theory** — What do you currently believe is the right path forward, even if you haven't proven it yet? Include any evidence or reasoning that supports it.

6. **Next Steps** — Concrete, ordered actions for the fresh agent to take. Be specific: file paths, function names, commands to run. The fresh agent should be able to start on step 1 immediately.

7. **Key Constraints and Context** — Any non-obvious constraints: environment specifics, user preferences expressed during this session, things the user explicitly said NOT to do, external dependencies, performance requirements, etc.

## Writing Rules

- Write the handoff for a fresh Claude, not for the user. The user knows what happened; the fresh Claude does not.
- Be ruthlessly specific. Vague next steps are useless. "Fix the auth" is bad. "In `src/auth/middleware.ts:47`, the token expiry check uses `Date.now()` but should use `req.timestamp` — change the comparison on line 52" is good.
- Include exact error messages, stack traces, or test output that captures the failure mode.
- Do not pad. Every sentence should be load-bearing information for the fresh agent.
- Do not write the handoff from the user's perspective. Write it as a briefing document addressed to the incoming agent.

## Output

Write the handoff to `HANDOFF.md` in the current working directory (the project root).

Use this structure:

```markdown
# Handoff

> Generated: [timestamp]  
> Project: [project name or directory]  
> Session summary: [one sentence describing what this session was about]

## Goal

[What the user is trying to accomplish — the actual end state]

## Current State

**Working:**
- [list what is confirmed working]

**Broken:**
- [exact symptom, error message, or failure mode]

## Files in Play

| File | Why It Matters |
|------|---------------|
| `path/to/file.ts` | [one line] |

## What Has Been Tried (and Why It Failed)

### Attempt 1: [short name]
- **What:** [what was done]
- **Why it failed:** [root cause, not just "it didn't work"]

### Attempt 2: [short name]
...

## Current Best Theory

[What you currently believe is the correct approach and why]

## Next Steps

1. [Specific, actionable step with file path or command]
2. [Next step]
3. ...

## Key Constraints

- [Non-obvious constraint or preference the user expressed]
- [Things explicitly ruled out]
```

## After Writing

Tell the user:

1. That `HANDOFF.md` has been written
2. To run `/clear` or start a new Claude Code session
3. To open the new session and say: **"Read HANDOFF.md and continue from where we left off."**
4. That the fresh agent will have no memory of this session, so the handoff doc is its only briefing

Keep the message short. The user is ready to move — don't make them read a wall of text.
