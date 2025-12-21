---
name: version-bump
description: Manage semantic version updates for claude-mem project. Handles patch, minor, and major version increments following semantic versioning. Updates package.json, marketplace.json, and plugin.json. Creates git tags and GitHub releases. Auto-generates CHANGELOG.md from releases.
---

# Version Bump Skill

Manage semantic versioning across the claude-mem project with consistent updates to all version-tracked files.

## Quick Reference

**Files requiring updates (ALL THREE):**
1. `package.json` (line 3)
2. `.claude-plugin/marketplace.json` (line 13)
3. `plugin/.claude-plugin/plugin.json` (line 3)

**Semantic versioning:**
- **PATCH** (x.y.Z): Bugfixes only
- **MINOR** (x.Y.0): New features, backward compatible
- **MAJOR** (X.0.0): Breaking changes

## Quick Decision Guide

**What changed?**
- "Fixed a bug" → PATCH (5.3.0 → 5.3.1)
- "Added new feature" → MINOR (5.3.0 → 5.4.0)
- "Breaking change" → MAJOR (5.3.0 → 6.0.0)

**If unclear, ASK THE USER explicitly.**

## Standard Workflow

See [operations/workflow.md](operations/workflow.md) for detailed step-by-step process.

**Quick version:**
1. Determine version type (PATCH/MINOR/MAJOR)
2. Calculate new version from current
3. Preview changes to user
4. Update ALL THREE files
5. Verify consistency
6. Build and test
7. Commit and create git tag
8. Push and create GitHub release
9. Generate CHANGELOG.md from releases and commit
10. Post Discord notification

## Common Scenarios

See [operations/scenarios.md](operations/scenarios.md) for examples:
- Bug fix releases
- New feature releases
- Breaking change releases

## Critical Rules

**ALWAYS:**
- Update ALL THREE files with matching version numbers
- Create git tag with format `vX.Y.Z`
- Create GitHub release from the tag
- Generate CHANGELOG.md from releases after creating release
- Post Discord notification after release
- Ask user if version type is unclear

**NEVER:**
- Update only one or two files
- Skip the verification step
- Forget to create git tag or GitHub release

## Verification Checklist

Before considering the task complete:
- [ ] All THREE files have matching version numbers
- [ ] `npm run build` succeeds
- [ ] Git commit created with all version files
- [ ] Git tag created (format: vX.Y.Z)
- [ ] Commit and tags pushed to remote
- [ ] GitHub release created from the tag
- [ ] CHANGELOG.md generated and committed
- [ ] Discord notification sent

## Reference Commands

```bash
# View current version
grep '"version"' package.json

# Verify consistency across all version files
grep '"version"' package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json

# View git tags
git tag -l -n1

# Check what will be committed
git status
git diff package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json
```

For more commands, see [operations/reference.md](operations/reference.md).
