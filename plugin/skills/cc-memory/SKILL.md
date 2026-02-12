---
name: cc-memory
description: Guide for setting up and organizing Claude Code memory (CLAUDE.md files). Use when users ask "how do I configure CLAUDE.md?", "how does Claude remember things?", "where should I put project instructions?", or need help structuring memory across user, project, and local levels.
---

# Claude Code Memory Guide

Help users set up and organize CLAUDE.md files correctly. Memory is the foundation of how Claude understands your project across sessions.

## Memory Hierarchy (loaded top to bottom)

| Level | Location | Shared With | Use For |
|-------|----------|-------------|---------|
| **Enterprise** | `C:\Program Files\ClaudeCode\CLAUDE.md` (Win) / `/etc/claude-code/CLAUDE.md` (Linux) / `/Library/Application Support/ClaudeCode/CLAUDE.md` (Mac) | Entire organization | Company-wide policies, security standards, compliance |
| **User** | `~/.claude/CLAUDE.md` | Only you (all projects) | Personal coding preferences, tool shortcuts |
| **Project** | `./CLAUDE.md` or `./.claude/CLAUDE.md` | Team via version control | Architecture, coding standards, build commands |
| **Project rules** | `./.claude/rules/*.md` | Team via version control | Modular topic-specific instructions |
| **Local** | `./CLAUDE.local.md` | Only you (this project) | Personal sandbox URLs, test data, local paths |

All files load automatically at session start. Higher levels load first (higher priority).

## Quick Setup

**Start a new project memory:**
```
/init
```
This generates a CLAUDE.md with your project's basics.

**Edit any memory file directly:**
```
/memory
```
Opens the memory file in your system editor.

## What Goes Where

### User memory (`~/.claude/CLAUDE.md`)

Personal preferences that apply to ALL your projects:

```markdown
# My Preferences
- Use 2-space indentation
- Prefer const over let in JavaScript
- Write commit messages in imperative mood
- Always add type annotations in TypeScript
- When writing tests, use describe/it pattern
```

### Project memory (`./CLAUDE.md` or `./.claude/CLAUDE.md`)

Team-shared instructions checked into version control:

```markdown
# Project Name

## Build Commands
- `npm run build` - Build the project
- `npm test` - Run all tests
- `npm run lint` - Lint the codebase

## Architecture
- Frontend: React + TypeScript in src/components/
- Backend: Express API in src/api/
- Database: PostgreSQL with Prisma ORM

## Coding Standards
- Use functional components with hooks
- Error responses follow RFC 7807 format
- All API endpoints require authentication
```

### Local memory (`./CLAUDE.local.md`)

Personal project-specific notes NOT checked into version control (auto-added to .gitignore):

```markdown
# My Local Config
- Dev server: http://localhost:3000
- Test database: postgresql://localhost:5432/myapp_test
- My sandbox API key is in .env.local
- When debugging auth, check the jwt-debug tool at /debug/tokens
```

## Imports

CLAUDE.md files can import other files with `@path/to/file`:

```markdown
See @README for project overview and @package.json for available npm commands.

# Additional Instructions
- Git workflow: @docs/git-instructions.md
- Individual preferences: @~/.claude/my-project-instructions.md
```

**Import rules:**
- Relative and absolute paths allowed
- `@~/` expands to home directory
- Imports inside code blocks and backticks are ignored
- Recursive imports allowed (max depth: 5)
- Great for team members to point to personal instructions without checking them in

## Best Practices

**Keep CLAUDE.md under ~500 lines.** Move reference material to skills instead.

**Be specific:**
- "Use 2-space indentation" (good)
- "Format code correctly" (bad - too vague)

**Use structured bullet points** grouped under descriptive markdown headings.

**Review periodically** as your project evolves.

**What belongs in CLAUDE.md vs Skills:**

| Content | Where |
|---------|-------|
| Rules Claude must ALWAYS follow | CLAUDE.md |
| Build/test/lint commands | CLAUDE.md |
| Architecture overview | CLAUDE.md |
| Detailed API reference docs | Skill (loaded on demand) |
| Invocable workflows (`/deploy`) | Skill |
| Domain knowledge needed sometimes | Skill |

**What belongs in CLAUDE.md vs Rules:**

| Content | Where |
|---------|-------|
| General project instructions | CLAUDE.md |
| Topic-specific guidelines (testing, API design) | `.claude/rules/topic.md` |
| Path-specific rules (only for certain files) | `.claude/rules/` with `paths:` frontmatter |
| Growing CLAUDE.md (500+ lines) | Split into `.claude/rules/` |

## How Claude Searches for Memory

1. Reads `CLAUDE.md` and `CLAUDE.local.md` from current directory
2. Recurses UPWARD to the root, reading any CLAUDE.md files found
3. Discovers nested CLAUDE.md in subdirectories as Claude accesses those files
4. Loads `.claude/rules/*.md` recursively from the project root

This means in a monorepo at `packages/frontend/`, Claude sees both `packages/frontend/CLAUDE.md` AND the root `CLAUDE.md`.
