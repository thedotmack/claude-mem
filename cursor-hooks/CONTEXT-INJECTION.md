# Context Injection in Cursor Hooks

## The Solution: Auto-Updated Rules File

Context is automatically injected via Cursor's **Rules** system:

1. **Install**: `claude-mem cursor install` creates initial context file
2. **Stop hook**: `session-summary.sh` updates context after each session ends
3. **Cursor**: Automatically includes `.cursor/rules/claude-mem-context.mdc` in all chats

**Result**: Context appears at the start of every conversation, just like Claude Code!

## How It Works

### Installation Creates Initial Context

```bash
claude-mem cursor install
```

This:
1. Copies hook scripts to `.cursor/hooks/`
2. Creates `hooks.json` configuration
3. Fetches existing context from claude-mem and writes to `.cursor/rules/claude-mem-context.mdc`

### Stop Hook Updates Context

After each session ends, `session-summary.sh`:

```bash
# 1. Generate session summary
curl -X POST .../api/sessions/summarize

# 2. Fetch fresh context (includes new observations)
context=$(curl -s ".../api/context/inject?project=...")

# 3. Write to rules file for next session
cat > .cursor/rules/claude-mem-context.mdc << EOF
---
alwaysApply: true
---
# Memory Context
${context}
EOF
```

### The Rules File

Located at: `.cursor/rules/claude-mem-context.mdc`

```markdown
---
alwaysApply: true
description: "Claude-mem context from past sessions (auto-updated)"
---

# Memory Context from Past Sessions

[Your context from claude-mem appears here]

---
*Updated after last session.*
```

### Update Flow

Context updates **after each session ends**:
1. User has a conversation
2. Agent completes (loop ends)
3. `stop` hook runs `session-summary.sh`
4. Summary generated + context file updated
5. **Next session** sees the updated context

## Comparison with Claude Code

| Feature | Claude Code | Cursor |
|---------|-------------|--------|
| Context injection | ✅ `additionalContext` in hook output | ✅ Auto-updated rules file |
| Injection timing | Immediate (same prompt) | Next session (after stop hook) |
| Persistence | Session only | File-based (persists across restarts) |
| Initial setup | Automatic | `claude-mem cursor install` creates initial context |
| MCP tool access | ✅ Full support | ✅ Full support |
| Web viewer | ✅ Available | ✅ Available |

## First Session Behavior

When you run `claude-mem cursor install`:
- If worker is running with existing memory → initial context is generated
- If no existing memory → placeholder file created

After each session ends, context is updated for the next session.

## Additional Access Methods

### 1. MCP Tools

Configure claude-mem's MCP server in Cursor for search tools:
- `search(query, project, limit)`
- `timeline(anchor, depth_before, depth_after)`
- `get_observations(ids)`

### 2. Web Viewer

Access context manually at `http://localhost:37777`

### 3. Manual Request

Ask the agent: "Check claude-mem for any previous work on authentication"

## File Location

The context file is created at:
```
<workspace>/.cursor/rules/claude-mem-context.mdc
```

This is version-controlled by default. Add to `.gitignore` if you don't want to commit it:
```
.cursor/rules/claude-mem-context.mdc
```
