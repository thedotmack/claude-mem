# Plan: Integrate Workflow Agents and Commands into Claude-Mem

## Executive Summary

This plan integrates the `/make-plan` and `/do` orchestration workflow from `~/.claude/commands/` into the claude-mem plugin as project-level development tools.

## Dependency Analysis

### Commands to Copy (from `~/.claude/commands/`)

| File | Purpose | Dependencies |
|------|---------|--------------|
| `make-plan.md` | Orchestrator for LLM-friendly phased planning | Uses Task tool with subagents |
| `do.md` | Orchestrator for executing plans via subagents | Uses Task tool with subagents |
| `anti-pattern-czar.md` | Error handling anti-pattern detection/fixing | Uses Read, Edit, Bash tools |

### Specialized Agents Referenced

The `/make-plan` and `/do` commands reference these **conceptual agent roles** (not actual agent files):

| Agent Role | Referenced In | Description |
|------------|---------------|-------------|
| "Documentation Discovery" | make-plan.md | Fact-gathering from docs/examples |
| "Verification" | make-plan.md, do.md | Verify implementation matches plan |
| "Implementation" | do.md | Execute implementation tasks |
| "Anti-pattern" | do.md | Grep for known bad patterns |
| "Code Quality" | do.md | Review code changes |
| "Commit" | do.md | Commit after verification passes |
| "Branch/Sync" | do.md | Push and prepare phase handoffs |

**Key Finding**: These are **role descriptions**, not separate agent files. The Task tool's `general-purpose` subagent_type executes all roles. The commands define *what* each role should do, not separate agent implementations.

### Existing Project Assets

Located in `.claude/`:
- `agents/github-morning-reporter.md` - Already in project
- `skills/version-bump/SKILL.md` - Already in project
- No existing commands directory

---

## Phase 0: Documentation Discovery (Complete)

### Sources Consulted
1. `/Users/alexnewman/.claude/commands/make-plan.md` (62 lines)
2. `/Users/alexnewman/.claude/commands/do.md` (39 lines)
3. `/Users/alexnewman/.claude/commands/anti-pattern-czar.md` (122 lines)
4. `/Users/alexnewman/.claude/settings.json` (36 lines)
5. `.claude/skills/CLAUDE.md` (30 lines)
6. `.claude/agents/github-morning-reporter.md` (102 lines)

### Allowed APIs/Patterns
- **Commands**: `.claude/commands/*.md` files with `#$ARGUMENTS` placeholder for user input
- **Skills**: `.claude/skills/<name>/SKILL.md` with YAML frontmatter (name, description)
- **Agents**: `.claude/agents/*.md` with YAML frontmatter (name, description, model)

### Anti-Patterns to Avoid
- Skills require YAML frontmatter; commands do not
- Commands use `#$ARGUMENTS` for input; skills/agents receive prompts differently
- Don't create separate agent files for role descriptions - the Task tool handles routing

---

## Phase 1: Create Commands Directory

### What to Implement
1. Create `.claude/commands/` directory
2. Copy `make-plan.md` from `~/.claude/commands/make-plan.md`
3. Copy `do.md` from `~/.claude/commands/do.md`
4. Copy `anti-pattern-czar.md` from `~/.claude/commands/anti-pattern-czar.md`

### Documentation References
- Pattern: `~/.claude/commands/*.md` (source files)
- Existing example: `.claude/skills/version-bump/SKILL.md` for claude-mem project tools

### Verification Checklist
```bash
# Verify files exist
ls -la .claude/commands/

# Verify content matches source
diff ~/.claude/commands/make-plan.md .claude/commands/make-plan.md
diff ~/.claude/commands/do.md .claude/commands/do.md
diff ~/.claude/commands/anti-pattern-czar.md .claude/commands/anti-pattern-czar.md

# Verify #$ARGUMENTS placeholder exists
grep '\$ARGUMENTS' .claude/commands/*.md
```

### Anti-Pattern Guards
- Do NOT add YAML frontmatter to commands (they don't need it)
- Do NOT modify the source content (copy verbatim)

---

## Phase 2: Create CLAUDE.md Documentation

### What to Implement
Create `.claude/commands/CLAUDE.md` documenting the commands directory (following pattern from `.claude/skills/CLAUDE.md`)

### Content Template
```markdown
# Project-Level Commands

This directory contains slash commands **for developing and maintaining the claude-mem project itself**.

## Commands in This Directory

### /make-plan
Orchestrator for creating LLM-friendly implementation plans in phases. Deploys subagents for documentation discovery and fact gathering.

**Usage**: `/make-plan <task description>`

### /do
Orchestrator for executing plans via subagents. Deploys specialized subagents for implementation, verification, and code quality review.

**Usage**: `/do <plan-file-path or inline plan>`

### /anti-pattern-czar
Interactive workflow for detecting and fixing error handling anti-patterns using the automated scanner.

**Usage**: `/anti-pattern-czar`

## Adding New Commands

Commands are markdown files with `#$ARGUMENTS` placeholder for user input.
```

### Verification Checklist
```bash
# Verify file exists
cat .claude/commands/CLAUDE.md
```

---

## Phase 3: Update Settings (if needed)

### What to Implement
Check if `.claude/settings.json` needs any permission updates for the new commands.

### Verification Checklist
```bash
# Check current settings
cat .claude/settings.json

# Verify commands work by listing them
# (After Claude Code restart, commands should appear in slash-command list)
```

### Anti-Pattern Guards
- Do NOT add skill permissions for commands (they're different)
- Commands don't require explicit permissions

---

## Phase 4: Final Verification

### Verification Checklist
1. All three command files exist in `.claude/commands/`
2. Content matches source files exactly (byte-for-byte if possible)
3. CLAUDE.md documentation exists
4. Git status shows new files ready for commit

```bash
# Full verification
ls -la .claude/commands/
wc -l .claude/commands/*.md
git status
```

### Commit Message Template
```
feat: add /make-plan, /do, and /anti-pattern-czar workflow commands

Add project-level orchestration commands for claude-mem development:
- /make-plan: Create LLM-friendly implementation plans in phases
- /do: Execute plans via coordinated subagents
- /anti-pattern-czar: Detect and fix error handling anti-patterns

These commands enable structured, agent-driven development workflows.
```

---

## Summary

**Files to Create**:
1. `.claude/commands/make-plan.md` (copy from ~/.claude/commands/)
2. `.claude/commands/do.md` (copy from ~/.claude/commands/)
3. `.claude/commands/anti-pattern-czar.md` (copy from ~/.claude/commands/)
4. `.claude/commands/CLAUDE.md` (new documentation)

**No Agent Files Needed**: The "agents" referenced in make-plan.md and do.md are role descriptions, not separate files. The Task tool's built-in subagent types handle execution.

**Confidence**: High - analysis complete with full source file reads.
