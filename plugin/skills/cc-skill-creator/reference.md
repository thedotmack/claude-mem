# Skill Reference - Official Documentation

Complete reference for Claude Code skill creation based on the official documentation.

## Frontmatter Fields

All fields are optional. Only `description` is recommended.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Display name. If omitted, uses directory name. Lowercase, numbers, hyphens only (max 64 chars). Becomes the `/slash-command`. |
| `description` | Recommended | What the skill does and when to use it. Claude uses this to decide when to apply the skill. If omitted, uses first paragraph of markdown content. |
| `argument-hint` | No | Hint shown in autocomplete for expected arguments. Example: `[issue-number]` or `[filename] [format]`. |
| `disable-model-invocation` | No | Set `true` to prevent Claude from auto-loading this skill. Use for workflows you want to trigger manually with `/name`. Default: `false`. |
| `user-invocable` | No | Set `false` to hide from `/` menu. Use for background knowledge users shouldn't invoke directly. Default: `true`. |
| `allowed-tools` | No | Tools Claude can use without permission when this skill is active. Comma-separated. |
| `model` | No | Model to use when this skill is active. |
| `context` | No | Set to `fork` to run in an isolated subagent context. |
| `agent` | No | Which subagent type to use when `context: fork` is set. Options: `Explore`, `Plan`, `general-purpose`, or any custom agent from `.claude/agents/`. |
| `hooks` | No | Hooks scoped to this skill's lifecycle. |

## String Substitutions

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | All arguments passed when invoking the skill. If not present in content, arguments are appended as `ARGUMENTS: <value>`. |
| `${CLAUDE_SESSION_ID}` | Current session ID. Useful for logging, session-specific files, or correlating output. |

## Invocation Control Matrix

| Frontmatter | User Can Invoke | Claude Can Invoke | Context Loading |
|-------------|-----------------|-------------------|-----------------|
| (default) | Yes | Yes | Description always in context, full content loaded when invoked |
| `disable-model-invocation: true` | Yes | No | Description NOT in context, full content on user invoke |
| `user-invocable: false` | No | Yes | Description always in context, full content on Claude invoke |

## Dynamic Context Injection

The `!`command`` syntax executes shell commands BEFORE Claude sees the content. The output replaces the placeholder.

```yaml
---
name: pr-summary
description: Summarize changes in a pull request
context: fork
agent: Explore
allowed-tools: Bash(gh:*)
---

## Pull request context
- PR diff: !`gh pr diff`
- PR comments: !`gh pr view --comments`
- Changed files: !`gh pr diff --name-only`

## Your task
Summarize this pull request...
```

## Skill Patterns

### Reference Skill (auto-invocable knowledge)

```yaml
---
name: api-conventions
description: API design patterns for this codebase. Use when writing API endpoints or reviewing API code.
---

When writing API endpoints:
- Use RESTful naming conventions
- Return consistent error formats
- Include request validation
```

### Task Skill (user-triggered action)

```yaml
---
name: deploy
description: Deploy the application to production
disable-model-invocation: true
---

Deploy $ARGUMENTS to production:
1. Run the test suite
2. Build the application
3. Push to the deployment target
4. Verify the deployment succeeded
```

### Forked Task Skill (isolated execution)

```yaml
---
name: deep-research
description: Research a topic thoroughly
context: fork
agent: Explore
---

Research $ARGUMENTS thoroughly:
1. Find relevant files using Glob and Grep
2. Read and analyze the code
3. Summarize findings with specific file references
```

### Visual Output Skill (generates HTML)

```yaml
---
name: codebase-visualizer
description: Generate an interactive tree visualization of your codebase
allowed-tools: Bash(python:*)
---

# Codebase Visualizer
Run the visualization script from your project root:

python ~/.claude/skills/codebase-visualizer/scripts/visualize.py .
```

## Directory Structure

```
my-skill/
  SKILL.md           # Required - main instructions (< 500 lines)
  reference.md       # Optional - detailed reference material
  examples.md        # Optional - usage examples
  template.md        # Optional - template for Claude to fill in
  scripts/
    helper.py        # Optional - scripts Claude can execute
    validate.sh      # Optional - validation scripts
```

## Skill Scopes (Priority Order)

1. **Enterprise** - Admin managed settings (highest priority)
2. **Personal** - `~/.claude/skills/<name>/SKILL.md`
3. **Project** - `.claude/skills/<name>/SKILL.md`
4. **Plugin** - `<plugin>/skills/<name>/SKILL.md`

Project skills override personal skills with the same name.

## Plugin Skills

Skills in plugins are namespaced: `/<plugin-name>:<skill-name>`.
No additional configuration needed beyond the directory structure.

## Troubleshooting

**Skill doesn't trigger:**
1. Check description includes keywords users would naturally say
2. Verify skill appears in `What skills are available?`
3. Try rephrasing your request to match the description more closely
4. Invoke directly with `/skill-name`

**Skill triggers too often:**
1. Make the description more specific
2. Add `disable-model-invocation: true` for manual-only invocation

**Claude doesn't see all skills:**
- Descriptions may exceed the character budget (default 15,000 chars)
- Run `/context` to check for excluded skills warning
- Set `SLASH_COMMAND_TOOL_CHAR_BUDGET` env var to increase limit

**Extended thinking:**
Include the word "ultrathink" anywhere in skill content to enable extended thinking mode.
