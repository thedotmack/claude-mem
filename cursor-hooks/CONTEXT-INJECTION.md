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

### Context Updates at Three Points

Context is refreshed **three times** per session for maximum freshness:

1. **Before prompt submission** (`context-inject.sh`): Ensures you start with the latest context from previous sessions
2. **After summary completes** (worker auto-update): Immediately after the summary is saved, worker updates the context file
3. **After session ends** (`session-summary.sh`): Fallback update in case worker update was missed

### Before Prompt Hook Updates Context

When you submit a prompt, `context-inject.sh`:

```bash
# 1. Ensure worker is running
ensure_worker_running "$worker_port"

# 2. Fetch fresh context
context=$(curl -s ".../api/context/inject?project=...")

# 3. Write to rules file (used immediately by Cursor)
cat > .cursor/rules/claude-mem-context.mdc << EOF
---
alwaysApply: true
---
# Memory Context
${context}
EOF
```

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

Context updates at **three points**:

**Before each prompt:**
1. User submits a prompt
2. `beforeSubmitPrompt` hook runs `context-inject.sh`
3. Context file refreshed with latest observations from previous sessions
4. Cursor reads the updated rules file

**After summary completes (worker auto-update):**
1. Summary is saved to database
2. Worker checks if project is registered for Cursor
3. If yes, immediately writes updated context file with new observations
4. No hook involved - happens in the worker process

**After session ends (fallback):**
1. Agent completes (loop ends)
2. `stop` hook runs `session-summary.sh`
3. Context file updated (ensures nothing was missed)
4. Ready for next session

## Project Registry

When you run `claude-mem cursor install`, the project is registered in `~/.claude-mem/cursor-projects.json`. This allows the worker to automatically update your context file whenever a new summary is generated - even if it happens from Claude Code or another IDE working on the same project.

To see registered projects:
```bash
cat ~/.claude-mem/cursor-projects.json
```

## Comparison with Claude Code

| Feature | Claude Code | Cursor |
|---------|-------------|--------|
| Context injection | ✅ `additionalContext` in hook output | ✅ Auto-updated rules file |
| Injection timing | Immediate (same prompt) | Before prompt + after summary + after session |
| Persistence | Session only | File-based (persists across restarts) |
| Initial setup | Automatic | `claude-mem cursor install` creates initial context |
| MCP tool access | ✅ Full support | ✅ Full support |
| Web viewer | ✅ Available | ✅ Available |

## First Session Behavior

When you run `claude-mem cursor install`:
- If worker is running with existing memory → initial context is generated
- If no existing memory → placeholder file created

Context is then automatically refreshed:
- Before each prompt (ensures latest observations are included)
- After each session ends (captures new observations from the session)

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
