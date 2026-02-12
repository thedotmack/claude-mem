---
name: cc-skill-creator
description: Create a new Claude Code skill following official best practices. Generates SKILL.md files with proper frontmatter, directory structure, and supporting files.
disable-model-invocation: true
argument-hint: [description of the skill to create]
---

# Claude Code Skill Creator

Create a new Claude Code skill following the official documentation patterns. This wizard walks through every decision and generates production-ready files.

## Workflow

### Step 1: Understand the Goal

Ask the user (or use `$ARGUMENTS`) to understand:
- **What** the skill should do
- **When** it should trigger (automatically by Claude, manually by user, or both)
- **Where** it should run (inline in conversation or isolated in a subagent)

### Step 2: Choose the Skill Type

| Type | When to Use | Key Frontmatter |
|------|-------------|-----------------|
| **Reference** | Knowledge Claude applies to current work (conventions, patterns, style guides) | Default (no special fields) |
| **Task** | Step-by-step actions the user triggers manually (`/deploy`, `/commit`, `/review`) | `disable-model-invocation: true` |
| **Background** | Knowledge Claude loads automatically but users don't invoke directly | `user-invocable: false` |
| **Forked Task** | Task that runs in isolated subagent context | `context: fork`, `agent: Explore\|Plan\|general-purpose` |

### Step 3: Choose the Scope

| Scope | Path | When to Use |
|-------|------|-------------|
| Personal | `~/.claude/skills/<name>/SKILL.md` | Available in all your projects |
| Project | `.claude/skills/<name>/SKILL.md` | Only this project, shared via version control |
| Plugin | `<plugin>/skills/<name>/SKILL.md` | Distributed with a plugin |

### Step 4: Generate the SKILL.md

Create the directory and `SKILL.md` with proper frontmatter. Follow these rules:

**Frontmatter rules:**
- `name`: lowercase letters, numbers, and hyphens only (max 64 chars)
- `description`: Write it from the perspective of "Use when..." to help Claude decide when to load it
- `disable-model-invocation: true`: Add ONLY for task skills with side effects
- `user-invocable: false`: Add ONLY for background knowledge skills
- `allowed-tools`: Comma-separated list to restrict what Claude can use (e.g., `Read, Grep, Glob` for read-only)
- `context: fork` + `agent`: ONLY when the skill has explicit task instructions (not for reference skills)
- `argument-hint`: Add when the skill accepts arguments (e.g., `[filename]`, `[issue-number]`)

**Content rules:**
- Use `$ARGUMENTS` placeholder where user input should be inserted
- Use `${CLAUDE_SESSION_ID}` for session-specific logging or file naming
- Use `!`command`` syntax for dynamic context injection (runs before Claude sees the content)
- Keep SKILL.md under 500 lines
- Move detailed reference material to supporting files

### Step 5: Add Supporting Files (if needed)

If the skill needs detailed reference material, examples, or scripts:

```
my-skill/
  SKILL.md           # Main instructions (required, < 500 lines)
  reference.md       # Detailed API docs or specifications
  examples.md        # Usage examples
  scripts/
    helper.py        # Utility scripts Claude can execute
```

Reference supporting files from SKILL.md with markdown links:

```markdown
## Additional resources
- For complete API details, see [reference.md](reference.md)
- For usage examples, see [examples.md](examples.md)
```

### Step 6: Test the Skill

After creating the files:
1. Restart Claude Code (or use `/skills` to reload)
2. Check the skill appears with `What skills are available?`
3. Test with `/skill-name` (for user-invocable skills)
4. Test by asking something matching the description (for auto-invocable skills)

## Decision Quick Reference

**Should Claude auto-invoke this skill?**
- YES (default) -> Omit `disable-model-invocation`
- NO (user controls timing) -> Add `disable-model-invocation: true`

**Should it run in isolation?**
- YES -> Add `context: fork` and `agent: Explore` (read-only) or `agent: general-purpose` (full access)
- NO (default) -> Omit `context`

**Should it restrict tools?**
- YES -> Add `allowed-tools: Read, Grep, Glob` (or whichever tools are appropriate)
- NO (default) -> Omit `allowed-tools`

For the complete frontmatter reference and advanced patterns, see [reference.md](reference.md).
