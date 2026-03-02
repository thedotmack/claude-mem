---
name: focus
description: Load context for a specific project in hub mode. Shows project observations and timeline.
---

# Focus on Project

Switch context to a specific project in a hub-mode vault. Loads that project's observations, timeline, and recent activity.

## When to Use

- User runs `/focus <project-name>` to switch project context
- User wants to see history/observations for a specific repo
- After seeing the hub projects table in SessionStart context

## Workflow

### If project name is provided:

1. Use the `search` MCP tool to get recent observations for the project:
   ```
   search(type="observations", limit=30, project="<project-name>", orderBy="date_desc")
   ```

2. Use the `timeline` MCP tool to show chronological context:
   ```
   timeline(query="recent", depth_before=10, depth_after=5, project="<project-name>")
   ```

3. Summarize findings to the user:
   - Number of observations loaded
   - Key recent sessions, decisions, and discoveries
   - Any active bugs or features in progress

4. Announce: "Context for **<project-name>** loaded. Subsequent searches will include this project's history."

### If no project name is provided:

1. Use the `search` MCP tool without project filter to list available projects:
   ```
   search(type="observations", limit=5)
   ```

2. Check the SessionStart context for the hub projects table (it should already be visible in the conversation).

3. Ask the user which project they want to focus on.

## Notes

- This skill works with the existing `search`, `timeline`, and `get_observations` MCP tools — all accept a `project` parameter.
- The project name must match what's in the database (e.g., "legal-core", "prognosticos", "plant-disease-classifier").
- Multiple `/focus` calls in a session are fine — each loads additional project context.
