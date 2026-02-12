---
name: cc-subagent-creator
description: Create a new Claude Code subagent following official best practices. Generates agent markdown files with proper frontmatter, tool configuration, and system prompts.
disable-model-invocation: true
argument-hint: [description of the subagent to create]
---

# Claude Code Subagent Creator

Create a new Claude Code subagent following the official documentation patterns. This wizard walks through every decision and generates production-ready agent files.

## Workflow

### Step 1: Understand the Purpose

Ask the user (or use `$ARGUMENTS`) to understand:
- **What task** the subagent should handle
- **Read-only or read-write** access needed
- **How specialized** the subagent should be

### Step 2: Choose the Scope

| Scope | Path | When to Use |
|-------|------|-------------|
| Project | `.claude/agents/<name>.md` | Specific to this codebase, share via version control |
| User | `~/.claude/agents/<name>.md` | Personal, available in all your projects |
| Plugin | `<plugin>/agents/<name>.md` | Distributed with a plugin |
| CLI | `--agents` JSON flag | Temporary, for testing or automation |

### Step 3: Choose the Model

| Model | Best For | Cost/Speed |
|-------|----------|------------|
| `haiku` | Fast read-only tasks, exploration, simple analysis | Cheapest, fastest |
| `sonnet` | Balanced capability, code review, moderate complexity | Mid-range |
| `opus` | Complex reasoning, architecture decisions, difficult bugs | Most capable, slower |
| `inherit` | Same model as parent conversation (default) | Matches parent |

**Rule of thumb:** Start with `haiku` for read-only agents, `sonnet` for agents that need to reason about code, `inherit` for agents that need full capability.

### Step 4: Define Tool Access

**Read-only agent** (exploration, analysis, review):
```yaml
tools: Read, Grep, Glob, Bash
disallowedTools: Write, Edit
```

**Full access agent** (implementation, debugging, fixing):
```yaml
tools: Read, Edit, Write, Bash, Grep, Glob
```

**Restricted agent** (specific tool subset):
```yaml
tools: Bash
# Plus hooks for validation (see Step 6)
```

Omit `tools` to inherit all tools from the parent conversation.

### Step 5: Write the System Prompt

The markdown body below the frontmatter becomes the subagent's system prompt. Write it to be:

1. **Role-specific**: "You are a senior code reviewer" not "You are helpful"
2. **Action-oriented**: Start with "When invoked:" and list concrete steps
3. **Output-formatted**: Specify how to organize and present results
4. **Focused**: Each subagent should excel at ONE specific task

**Template:**

```markdown
You are a [specific role] specializing in [domain].

When invoked:
1. [First action]
2. [Second action]
3. [Third action]

[Domain-specific checklist or criteria]

For each [item], provide:
- [Output format point 1]
- [Output format point 2]
- [Output format point 3]

[Constraints or focus areas]
```

### Step 6: Add Optional Features

**Persistent memory** - Agent learns across sessions:
```yaml
memory: user    # or project, local
```
Add instructions in the body: "Update your agent memory as you discover patterns and key decisions."

**Preloaded skills** - Inject domain knowledge at start:
```yaml
skills:
  - api-conventions
  - error-handling-patterns
```

**Lifecycle hooks** - Validate operations before they execute:
```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "./scripts/validate-command.sh"
```

**Permission mode** - Control permission prompts:
```yaml
permissionMode: dontAsk    # or default, acceptEdits, bypassPermissions, plan
```

### Step 7: Generate the File

Create the markdown file in the chosen scope directory. The file name becomes the agent identifier.

Example: `.claude/agents/code-reviewer.md` creates an agent named `code-reviewer`.

### Step 8: Test the Subagent

After creating the file:
1. Restart Claude Code (or use `/agents` to reload)
2. Verify with `/agents` that it appears in the list
3. Test explicitly: "Use the code-reviewer subagent to review my recent changes"
4. Check that Claude delegates automatically when the task matches the description

## Decision Quick Reference

**Should it be read-only?**
- YES -> Set `tools: Read, Grep, Glob, Bash` and `disallowedTools: Write, Edit`
- NO -> Omit tools (inherits all) or list the needed tools

**Should it remember across sessions?**
- YES -> Add `memory: user` (all projects) or `memory: project` (this project)
- NO -> Omit `memory`

**Should it preload domain knowledge?**
- YES -> Add `skills:` with skill names
- NO -> Omit `skills`

**Should Claude use it proactively?**
- YES -> Include "Use proactively" in the description
- NO -> Write a specific description so Claude only delegates matching tasks

For the complete frontmatter reference and examples, see [reference.md](reference.md).
