---
name: set-mode
description: Set the claude-mem observation mode for the current project. Creates or updates .claude-mem.json in the project root. Use when asked to "set mode", "change mode", "use gstack mode", or "switch to code mode".
---

# Set Mode

Set the observation mode for the current project by creating or updating `.claude-mem.json` in the project root.

## Workflow

1. **Query available modes** by fetching `http://localhost:37777/api/modes` (GET request)
2. **If no mode specified**, show the user the available modes and ask which one they want
3. **Validate** the requested mode exists in the available modes list
4. **Write `.claude-mem.json`** to the project root (same directory as `.git/` or `CLAUDE.md`)
5. **Confirm** the mode was set

## File Format

`.claude-mem.json` — placed in the project root:

```json
{
  "mode": "code--gstack"
}
```

## Common Modes

| Mode | Description |
|------|------------|
| `code` | Software development (default) |
| `code--chill` | Software development, selective recording |
| `gstack` | Strategic workflow — product decisions, demand signals |
| `code--gstack` | Code + strategic hybrid |
| `email-investigation` | Email fraud investigation |
| `law-study` | Law study |

Language variants follow the `code--{lang}` pattern (e.g., `code--es`, `code--ko`, `code--ja`).

## Important

- The mode takes effect on the **next session** (next time Claude Code starts a conversation in this project)
- Per-project mode does NOT affect other projects — each project can have its own mode
- If `.claude-mem.json` already exists, preserve any other fields and only update `mode`
- If the mode doesn't exist, warn the user and suggest using `/create-mode` to create a custom one

## Example

User: "set mode to gstack"

1. Read existing `.claude-mem.json` if present (to preserve other fields)
2. Write:
```json
{
  "mode": "gstack"
}
```
3. Respond: "Mode set to `gstack` for this project. New sessions will use strategic observation tracking."
