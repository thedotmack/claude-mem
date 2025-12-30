# Claude-Mem Rules for Cursor

## Automatic Context Injection

The `context-inject.sh` hook **automatically creates and updates** a rules file at:

```
.cursor/rules/claude-mem-context.mdc
```

This file:
- Has `alwaysApply: true` so it's included in every chat session
- Contains recent context from past sessions
- Auto-refreshes on every prompt submission

**You don't need to manually create any rules file!**

## Optional: Additional Instructions

If you want to add custom instructions about claude-mem (beyond the auto-injected context), create a separate rules file:

### `.cursor/rules/claude-mem-instructions.mdc`

```markdown
---
alwaysApply: true
description: "Instructions for using claude-mem memory system"
---

# Memory System Usage

You have access to claude-mem, a persistent memory system. In addition to the auto-injected context above, you can search for more detailed information using MCP tools:

## Available MCP Tools

1. **search** - Find relevant past observations
   ```
   search(query="authentication bug", project="my-project", limit=10)
   ```

2. **timeline** - Get context around a specific observation
   ```
   timeline(anchor=<observation_id>, depth_before=3, depth_after=3)
   ```

3. **get_observations** - Fetch full details for specific IDs
   ```
   get_observations(ids=[123, 456])
   ```

## When to Search Memory

- When the user asks about previous work or decisions
- When encountering unfamiliar code patterns in this project
- When debugging issues that might have been addressed before
- When asked to continue or build upon previous work

## 3-Layer Workflow

Follow this pattern for token efficiency:
1. **Search first** - Get compact index (~50-100 tokens/result)
2. **Timeline** - Get chronological context around interesting results
3. **Fetch details** - Only for relevant observations (~500-1000 tokens/result)

Never fetch full details without filtering first.
```

## File Locations

| File | Purpose | Created By |
|------|---------|------------|
| `.cursor/rules/claude-mem-context.mdc` | Auto-injected context | Hook (automatic) |
| `.cursor/rules/claude-mem-instructions.mdc` | MCP tool instructions | You (optional) |

## Git Ignore

If you don't want to commit the auto-generated context file:

```gitignore
# .gitignore
.cursor/rules/claude-mem-context.mdc
```

The instructions file can be committed to share with your team.
