---
name: troubleshoot
description: Diagnose and fix claude-mem installation issues. Checks PM2 worker status, database integrity, service health, dependencies, and provides automated fixes for common problems.
---

# Claude-Mem Troubleshooting Skill

Diagnose and resolve installation and operational issues with the claude-mem plugin.

## When to Use This Skill

**Invoke this skill when:**
- Memory not persisting after `/clear`
- Viewer UI empty or not loading
- Worker service not running
- Database missing or corrupted
- Port conflicts
- Missing dependencies
- "Nothing is remembered" complaints
- Search results empty when they shouldn't be

**Do NOT invoke** for feature requests or usage questions (use regular documentation for that).

## Quick Decision Guide

Once the skill is loaded, choose the appropriate operation:

**What's the problem?**

- "Nothing is being remembered" → [operations/common-issues.md](operations/common-issues.md#nothing-remembered)
- "Viewer is empty" → [operations/common-issues.md](operations/common-issues.md#viewer-empty)
- "Worker won't start" → [operations/common-issues.md](operations/common-issues.md#worker-not-starting)
- "Want to run full diagnostics" → [operations/diagnostics.md](operations/diagnostics.md)
- "Need automated fix" → [operations/automated-fixes.md](operations/automated-fixes.md)

## Available Operations

Choose the appropriate operation file for detailed instructions:

### Diagnostic Workflows
1. **[Full System Diagnostics](operations/diagnostics.md)** - Comprehensive step-by-step diagnostic workflow
2. **[Worker Diagnostics](operations/worker.md)** - PM2 worker-specific troubleshooting
3. **[Database Diagnostics](operations/database.md)** - Database integrity and data checks

### Issue Resolution
4. **[Common Issues](operations/common-issues.md)** - Quick fixes for frequently encountered problems
5. **[Automated Fixes](operations/automated-fixes.md)** - One-command fix sequences

### Reference
6. **[Quick Commands](operations/reference.md)** - Essential commands for troubleshooting

## Quick Start

**Fast automated fix (try this first):**
```bash
cd ~/.claude/plugins/marketplaces/thedotmack/ && \
pm2 delete claude-mem-worker 2>/dev/null; \
npm install && \
node_modules/.bin/pm2 start ecosystem.config.cjs && \
sleep 3 && \
curl -s http://127.0.0.1:37777/health
```

Expected output: `{"status":"ok"}`

If that doesn't work, proceed to detailed diagnostics.

## Response Format

When troubleshooting:
1. **Identify the symptom** - What's the user reporting?
2. **Choose operation file** - Use the decision guide above
3. **Follow steps systematically** - Don't skip diagnostic steps
4. **Report findings** - Tell user what you found and what was fixed
5. **Verify resolution** - Confirm the issue is resolved

## Technical Notes

- **Worker port:** Default 37777 (configurable via `CLAUDE_MEM_WORKER_PORT`)
- **Database location:** `~/.claude-mem/claude-mem.db`
- **Plugin location:** `~/.claude/plugins/marketplaces/thedotmack/`
- **PM2 process name:** `claude-mem-worker`

## Error Reporting

If troubleshooting doesn't resolve the issue, collect diagnostic data and direct user to:
https://github.com/thedotmack/claude-mem/issues

See [operations/diagnostics.md](operations/diagnostics.md#reporting-issues) for details on what to collect.
