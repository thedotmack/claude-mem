# Subagent Reference - Official Documentation

Complete reference for Claude Code subagent creation based on the official documentation.

## Frontmatter Fields

Only `name` and `description` are required.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier using lowercase letters and hyphens |
| `description` | Yes | When Claude should delegate to this subagent. Include "Use proactively" to encourage automatic delegation. |
| `tools` | No | Tools the subagent can use. Inherits all tools if omitted. |
| `disallowedTools` | No | Tools to deny, removed from the inherited or specified list. |
| `model` | No | Model to use: `sonnet`, `opus`, `haiku`, or `inherit`. Default: `inherit`. |
| `permissionMode` | No | Permission mode: `default`, `acceptEdits`, `dontAsk`, `bypassPermissions`, or `plan`. |
| `skills` | No | Skills to preload into the subagent's context at start. Full skill content is injected, not just made available. |
| `hooks` | No | Lifecycle hooks scoped to this subagent. |
| `memory` | No | Persistent memory scope: `user`, `project`, or `local`. Enables cross-session learning. |

## Available Tools

Subagents can use any of Claude Code's internal tools:

- `Read` - Read files
- `Write` - Write/create files
- `Edit` - Edit existing files
- `Grep` - Search file contents
- `Glob` - Find files by pattern
- `Bash` - Execute shell commands
- `WebFetch` - Fetch web content
- `WebSearch` - Search the web
- `Task` - Launch sub-subagents (NOT available - subagents cannot spawn other subagents)

MCP tools are also available if configured (not available in background subagents).

## Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Standard permission checking with prompts |
| `acceptEdits` | Auto-accept file edits |
| `dontAsk` | Auto-deny permission prompts (explicitly allowed tools still work) |
| `bypassPermissions` | Skip all permission checks (use with caution) |
| `plan` | Plan mode (read-only exploration) |

## Persistent Memory

When `memory` is enabled:
- The subagent's system prompt includes instructions to read/write the memory directory
- First 200 lines of `MEMORY.md` are included in the system prompt
- Read, Write, and Edit tools are auto-enabled for memory management

| Scope | Location | Use When |
|-------|----------|----------|
| `user` | `~/.claude/agent-memory/<agent-name>/` | Agent should remember learnings across all projects |
| `project` | `.claude/agent-memory/<agent-name>/` | Knowledge is project-specific and shareable via version control |
| `local` | `.claude/agent-memory-local/<agent-name>/` | Knowledge is project-specific but shouldn't be checked in |

## Scope Priority (highest to lowest)

1. `--agents` CLI flag (current session only)
2. `.claude/agents/` (current project)
3. `~/.claude/agents/` (all your projects)
4. Plugin's `agents/` directory (where plugin is enabled)

When multiple subagents share the same name, the higher-priority location wins.

## Hook Events for Subagents

### In subagent frontmatter

| Event | Matcher Input | When It Fires |
|-------|--------------|---------------|
| `PreToolUse` | Tool name | Before the subagent uses a tool |
| `PostToolUse` | Tool name | After the subagent uses a tool |
| `Stop` | (none) | When the subagent finishes (converted to `SubagentStop` at runtime) |

### In project-level settings.json

| Event | Matcher Input | When It Fires |
|-------|--------------|---------------|
| `SubagentStart` | Agent type name | When a subagent starts |
| `SubagentStop` | (none) | When any subagent completes |

## Example Subagents

### Code Reviewer (read-only, proactive)

```markdown
---
name: code-reviewer
description: Expert code review specialist. Proactively reviews code for quality, security, and maintainability. Use immediately after writing or modifying code.
tools: Read, Grep, Glob, Bash
model: inherit
---

You are a senior code reviewer ensuring high standards of code quality and security.

When invoked:
1. Run git diff to see recent changes
2. Focus on modified files
3. Begin review immediately

Review checklist:
- Code is clear and readable
- Functions and variables are well-named
- No duplicated code
- Proper error handling
- No exposed secrets or API keys
- Input validation implemented
- Good test coverage
- Performance considerations addressed

Provide feedback organized by priority:
- Critical issues (must fix)
- Warnings (should fix)
- Suggestions (consider improving)

Include specific examples of how to fix issues.
```

### Debugger (read-write, proactive)

```markdown
---
name: debugger
description: Debugging specialist for errors, test failures, and unexpected behavior. Use proactively when encountering any issues.
tools: Read, Edit, Bash, Grep, Glob
---

You are an expert debugger specializing in root cause analysis.

When invoked:
1. Capture error message and stack trace
2. Identify reproduction steps
3. Isolate the failure location
4. Implement minimal fix
5. Verify solution works

For each issue, provide:
- Root cause explanation
- Evidence supporting the diagnosis
- Specific code fix
- Testing approach
- Prevention recommendations

Focus on fixing the underlying issue, not the symptoms.
```

### Data Scientist (domain-specific)

```markdown
---
name: data-scientist
description: Data analysis expert for SQL queries, BigQuery operations, and data insights. Use proactively for data analysis tasks.
tools: Bash, Read, Write
model: sonnet
---

You are a data scientist specializing in SQL and BigQuery analysis.

When invoked:
1. Understand the data analysis requirement
2. Write efficient SQL queries
3. Analyze and summarize results
4. Present findings clearly

For each analysis:
- Explain the query approach
- Document any assumptions
- Highlight key findings
- Suggest next steps based on data
```

### Database Reader (hook-validated)

```markdown
---
name: db-reader
description: Execute read-only database queries. Use when analyzing data or generating reports.
tools: Bash
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-readonly-query.sh"
---

You are a database analyst with read-only access. Execute SELECT queries to answer questions about the data.

You cannot modify data. If asked to INSERT, UPDATE, DELETE, or modify schema, explain that you only have read access.
```

## Execution Modes

- **Foreground** (default): Blocks conversation until complete. Permission prompts pass through to user.
- **Background**: Runs concurrently. Pre-approves needed permissions before launch. Auto-denies anything not pre-approved. MCP tools not available.

Ask Claude to "run this in the background" or press Ctrl+B to background a running task.

## Resuming Subagents

Subagents can be resumed with their full previous context preserved. Ask Claude to "continue that code review" to resume the most recent subagent. Transcripts are stored in `~/.claude/projects/{project}/{sessionId}/subagents/`.

## Key Constraints

- Subagents CANNOT spawn other subagents (no nesting)
- Subagents do NOT inherit skills from the parent session (must be specified explicitly)
- Subagents do NOT inherit conversation history from the parent
- Background subagents cannot use MCP tools
- Auto-compaction triggers at ~95% context capacity
