# Knowledge Agents as Executable Plugin Agents

## Idea

Convert claude-mem's subagents (like the knowledge-agent skill) into official, executable Claude Code plugin agents — the kind defined in an `agents/` directory at the plugin root. Today these are described in skills/SKILL.md files; the proposal is to make them first-class delegatable agents that Claude Code can invoke directly via the Task/Agent tool, surfaced as `claude-mem:agent-name`.

This is a placeholder worktree — capturing the idea now, will continue later.

## How plugin agents work

Plugin agents are Markdown files with YAML frontmatter under `agents/` at the plugin root.

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json
└── agents/
    └── specialist.md
```

Example agent file:

```markdown
---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
---

You are a code reviewer. When invoked, analyze the code and provide
specific, actionable feedback on quality, security, and best practices.
```

## Frontmatter

**Required:**
- `name` — unique identifier, lowercase letters and hyphens
- `description` — tells Claude when to delegate to this agent

**Supported:**
- `tools`, `disallowedTools`
- `model`
- `maxTurns`
- `skills`
- `memory`
- `background`
- `effort`
- `isolation`
- `color`

**NOT supported in plugin agents (security):**
- `hooks`
- `mcpServers`
- `permissionMode`

These fields are silently ignored when loading agents from a plugin.

## Install / activation

After installing the plugin, run `/reload-plugins` to load agents. They appear in the UI as `plugin-name:agent-name`.

## Candidates to convert

- knowledge-agent (currently a skill)
- timeline-report (currently a skill — possibly stays a skill, or splits)
- pathfinder
- mem-search (probably stays a skill since it's a tool-style invocation)
- make-plan / do (currently skills — could become agents)

Decide per-skill: skill = orchestrator instructions Claude reads inline; agent = delegated subagent with its own context, tools, and system prompt. Knowledge agents fit the latter cleanly.

## Open questions

- Do plugin agents have access to the plugin's MCP server (claude-mem's mem-search MCP)? `mcpServers` frontmatter is unsupported, but agents may inherit the parent session's MCP — need to verify.
- How do we pass per-corpus parameters (e.g. which knowledge brain to load) into a static agent definition? Args via description? Skill-side wrapper that delegates?
- Migration path for existing skill-based flows.

## Next step

Pick this back up and prototype one (likely `knowledge-agent`) under `plugin/agents/knowledge-agent.md`.
