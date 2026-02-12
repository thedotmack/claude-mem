---
name: cc-extend
description: Guide for choosing the right Claude Code extension mechanism. Use when users ask "how should I extend Claude Code?", "should I use a skill or subagent?", "what's the difference between hooks and skills?", or need help deciding between CLAUDE.md, Skills, Subagents, MCP, Hooks, or Plugins.
---

# Claude Code Extension Guide

Help users choose the right extension mechanism for their needs. Claude Code has 7 extension types, each solving a different problem.

## Quick Decision Tree

**"I need Claude to always know something"**
-> **CLAUDE.md** (project conventions, coding rules, "always do X")

**"I need a reusable workflow or reference material"**
-> **Skill** (code review checklist, deploy workflow, API style guide)

**"I need to isolate heavy work from my conversation"**
-> **Subagent** (research tasks, parallel analysis, specialized workers)

**"I need multiple agents working in parallel and communicating"**
-> **Agent Team** (competing hypotheses, parallel code review, feature development)

**"I need to connect to an external service"**
-> **MCP** (database queries, Slack, browser control, GitHub API)

**"I need deterministic automation on events"**
-> **Hook** (auto-format after edit, lint on save, block sensitive files)

**"I need to package and share extensions"**
-> **Plugin** (distribute skills + hooks + agents + MCP as a unit)

## Feature Comparison

| Feature | What It Does | When to Use | Context Cost |
|---------|-------------|-------------|--------------|
| **CLAUDE.md** | Persistent context loaded every session | Project conventions, "always do X" rules | Every request |
| **Skill** | Reusable instructions and workflows | Reference docs, invocable workflows (`/name`) | Low (descriptions only until invoked) |
| **Subagent** | Isolated execution context returning summary | Heavy research, parallel tasks, specialized workers | Isolated from main session |
| **Agent Team** | Multiple independent Claude Code sessions | Parallel research, competing hypotheses | Each teammate is a separate instance |
| **MCP** | Connect to external services | Database, Slack, browser, external APIs | Every request (tool definitions) |
| **Hook** | Deterministic shell script on events | Auto-format, lint, logging, file protection | Zero (runs externally) |
| **Plugin** | Package and distribute extensions | Share skills + hooks + agents across projects | Depends on contents |

## Head-to-Head Comparisons

### CLAUDE.md vs Skill

| Aspect | CLAUDE.md | Skill |
|--------|-----------|-------|
| **Loads** | Every session, automatically | On demand |
| **Best for** | Rules Claude must always follow | Reference material, invocable workflows |
| **Can trigger workflows** | No | Yes, with `/name` |

**Rule of thumb:** Keep CLAUDE.md under ~500 lines. Move reference content to skills.

### Skill vs Subagent

| Aspect | Skill | Subagent |
|--------|-------|----------|
| **What it is** | Reusable instructions/knowledge | Isolated worker with own context |
| **Key benefit** | Share content across contexts | Context isolation, only summary returns |
| **Best for** | Reference material, workflows | Tasks that read many files, parallel work |

**They combine:** A subagent can preload skills (`skills:` field). A skill can run in isolation (`context: fork`).

### Subagent vs Agent Team

| Aspect | Subagent | Agent Team |
|--------|----------|------------|
| **Communication** | Reports results to parent only | Peers message each other directly |
| **Coordination** | Parent manages all work | Shared task list, self-coordination |
| **Best for** | Focused tasks, quick workers | Complex work requiring discussion |

**Transition point:** If parallel subagents hit context limits or need to communicate, use agent teams.

### MCP vs Skill

| Aspect | MCP | Skill |
|--------|-----|-------|
| **Provides** | Access to tools and data | Knowledge, workflows, reference material |
| **Example** | Database connection, Slack integration | Query patterns, message format rules |

**They combine:** MCP provides the connection; a skill teaches Claude how to use it effectively.

## Common Patterns

| Pattern | How It Works | Example |
|---------|-------------|---------|
| **Skill + MCP** | MCP provides connection; skill teaches usage | MCP connects to DB, skill documents schema and query patterns |
| **Skill + Subagent** | Skill spawns subagents for parallel work | `/review` starts security, performance, and style subagents |
| **CLAUDE.md + Skills** | CLAUDE.md has always-on rules; skills have on-demand reference | CLAUDE.md says "follow API conventions," skill has the full guide |
| **Hook + MCP** | Hook triggers external actions via scripts | Post-edit hook sends Slack notification for critical files |

## Context Cost Summary

| Feature | When Loaded | Cost |
|---------|------------|------|
| **CLAUDE.md** | Session start | Every request (full content) |
| **Skills** | Session start + when used | Low: descriptions at start, full on invoke |
| **MCP** | Session start | Every request (tool definitions + schemas) |
| **Subagents** | When spawned | Isolated (doesn't consume main context) |
| **Hooks** | On trigger | Zero (runs externally) |

**Tips to manage context:**
- Use `disable-model-invocation: true` on task skills to hide them from Claude until you invoke them
- Run `/mcp` to check token costs per MCP server; disconnect unused servers
- Use subagents to keep heavy research out of your main conversation
- Keep CLAUDE.md concise; move detailed reference to skills
