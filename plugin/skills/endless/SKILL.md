---
name: endless
description: Run a task in endless mode — automatically cycles Claude Code sessions to avoid context window limits. Your work is preserved across cycles via claude-mem observations.
---

# Endless Mode

Run a long-running task that automatically cycles Claude Code sessions when context fills up. Claude-mem's observation system captures your work, and each new session starts with compressed context from previous cycles.

## Usage

The user provides a task description. This skill sends it to the worker's endless mode endpoint.

## Steps

1. Confirm the task with the user
2. Call `POST http://localhost:37777/api/endless/run` with:
   ```json
   {
     "task": "<the user's task description>",
     "project": "<current project name>",
     "cwd": "<current working directory>"
   }
   ```
3. Report that the task has started
4. The user can check status with `GET http://localhost:37777/api/endless/status`

## Important

- Only one endless mode task can run at a time
- The task runs in the background on the worker — it survives if the user's session ends
- Each cycle spawns a full Claude Code instance with all tools available
- Context continuity comes from claude-mem's SessionStart observation injection
- The task cycles when the observer stores an observation (indicating meaningful work was captured)
- Natural completion (agent finishes the task) stops the loop automatically
- Safety valve: maximum 100 cycles
