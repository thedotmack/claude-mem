# Project-Level Skills

This directory contains skills **for developing and maintaining the claude-mem project itself**, not skills that are released as part of the plugin.

## Distinction

**Project Skills** (`.claude/skills/`):
- Used by developers working on claude-mem
- Not included in the plugin distribution
- Project-specific workflows (version bumps, release management, etc.)
- Not synced to `~/.claude/plugins/marketplaces/thedotmack/`

**Plugin Skills** (`plugin/skills/`):
- Released as part of the claude-mem plugin
- Available to all users who install the plugin
- General-purpose memory search functionality
- Synced to user installations via `npm run sync-marketplace`

## Skills in This Directory

### version-bump
Manages semantic versioning for the claude-mem project itself. Handles updating all three version files (package.json, marketplace.json, plugin.json), creating git tags, and GitHub releases.

**Usage**: Only for claude-mem maintainers releasing new versions.

## Adding New Skills

**For claude-mem development** → Add to `.claude/skills/`
**For end users** → Add to `plugin/skills/` (gets distributed with plugin)