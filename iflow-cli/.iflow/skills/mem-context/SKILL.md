---
name: "mem-context"
description: "Manually inject relevant historical memories into the current session. Use when the user needs to review previous work or wants historical context."
license: MIT
metadata:
  version: 1.0.0
  author: claude-mem
  category: memory
  updated: 2026-03-13
---

# Memory Context Injection

Manually inject relevant historical memories into the current session.

## Usage

```
/mem-context [topic]
```

## Arguments

- `topic` - Optional, topic keyword. If not provided, it will be automatically inferred from the current conversation.

## Examples

```
/mem-context
/mem-context authentication
/mem-context database schema
```

## How It Works

1. Analyze current conversation content or specified topic
2. Call `search_observations` to search for relevant memories
3. Call `get_timeline` to get timeline context
4. Format and inject into context

## Auto Injection

The `SessionStart` hook automatically injects relevant memories, so you typically don't need to call this command manually.

Manual usage scenarios:
- Need to review history mid-conversation
- Auto-injection was not accurate enough
- Want to view memories of a specific topic

## Related Skills

- **@mem-search**: USE to search for specific memories
