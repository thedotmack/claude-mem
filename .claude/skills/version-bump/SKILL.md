---
name: version-bump
description: Manage semantic version updates for claude-mem project. Handles patch, minor, and major version increments following semantic versioning. Updates package.json, marketplace.json, plugin.json, and CLAUDE.md version number (NOT version history). Creates git tags.
---

# Version Bump Skill

IMPORTANT: This skill manages semantic versioning across the claude-mem project. YOU MUST update all FOUR version-tracked files consistently and create a git tag.

## Quick Reference

**Files requiring updates:**
1. `package.json` (line 3)
2. `.claude-plugin/marketplace.json` (line 13)
3. `plugin/.claude-plugin/plugin.json` (line 3)
4. `CLAUDE.md` (line 9 ONLY - version number, NOT version history)

**Semantic versioning:**
- PATCH (x.y.Z): Bugfixes only
- MINOR (x.Y.0): New features, backward compatible
- MAJOR (X.0.0): Breaking changes

## Workflow

When invoked, follow this process:

### 1. Analyze Changes
First, understand what changed:
```bash
git log --oneline -5
git diff HEAD~1
```

### 2. Determine Version Type
Ask yourself:
- Breaking changes? → MAJOR
- New features? → MINOR
- Bugfixes only? → PATCH

If unclear, ASK THE USER explicitly.

### 3. Calculate New Version
From current version in `package.json`:
```bash
grep '"version"' package.json
```

Apply semantic versioning rules:
- Patch: increment Z (4.2.8 → 4.2.9)
- Minor: increment Y, reset Z (4.2.8 → 4.3.0)
- Major: increment X, reset Y and Z (4.2.8 → 5.0.0)

### 4. Preview Changes
BEFORE making changes, show the user:
```
Current version: 4.2.8
New version: 4.2.9 (PATCH)
Reason: Fixed database query bug

Files to update:
- package.json: "version": "4.2.9"
- marketplace.json: "version": "4.2.9"
- plugin.json: "version": "4.2.9"
- CLAUDE.md line 9: "**Current Version**: 4.2.9" (version number ONLY)
- Git tag: v4.2.9

Proceed? (yes/no)
```

### 5. Update Files

**Update package.json:**
```json
{
  "name": "claude-mem",
  "version": "4.2.9",
  ...
}
```

**Update .claude-plugin/marketplace.json:**
```json
{
  "name": "claude-mem",
  "version": "4.2.9",
  ...
}
```

**Update plugin/.claude-plugin/plugin.json:**
```json
{
  "name": "claude-mem",
  "version": "4.2.9",
  ...
}
```

**Update CLAUDE.md:**
ONLY update line 9 with the version number:
```markdown
**Current Version**: 4.2.9
```

**CRITICAL**: DO NOT add version history entries to CLAUDE.md. Version history is managed separately outside this skill.

### 6. Verify Consistency
```bash
# Check all versions match
grep -n '"version"' package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json
# Should show same version in all three files
```

### 7. Test
```bash
# Verify the plugin loads correctly
npm run build
```

### 8. Commit and Tag
```bash
# Stage all version files
git add package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json CLAUDE.md plugin/scripts/

# Commit with descriptive message
git commit -m "Release vX.Y.Z: [Brief description]"

# Create annotated git tag
git tag vX.Y.Z -m "Release vX.Y.Z: [Brief description]"

# Push commit and tags
git push && git push --tags
```

### 9. Create GitHub Release
```bash
# Create GitHub release from the tag
gh release create vX.Y.Z --title "vX.Y.Z" --notes "[Brief release notes]"

# Or generate notes automatically from commits
gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes
```

**IMPORTANT**: Always create the GitHub release immediately after pushing the tag. This makes the release discoverable to users and triggers any automated workflows.

## Common Scenarios

**Scenario 1: Bug fix after testing**
```
User: "Fixed the memory leak in the search function"
You: Determine → PATCH
     Calculate → 4.2.8 → 4.2.9
     Update all four files (version numbers only)
     Build and commit
     Create git tag v4.2.9
     Push commit and tags
     Create GitHub release v4.2.9
```

**Scenario 2: New MCP tool added**
```
User: "Added web search MCP integration"
You: Determine → MINOR (new feature)
     Calculate → 4.2.8 → 4.3.0
     Update all four files (version numbers only)
     Build and commit
     Create git tag v4.3.0
     Push commit and tags
     Create GitHub release v4.3.0
```

**Scenario 3: Database schema redesign**
```
User: "Rewrote storage layer, old data needs migration"
You: Determine → MAJOR (breaking change)
     Calculate → 4.2.8 → 5.0.0
     Update all four files (version numbers only)
     Build and commit
     Create git tag v5.0.0
     Push commit and tags
     Create GitHub release v5.0.0
```

## Error Prevention

**ALWAYS verify:**
- [ ] All FOUR files have matching version numbers (package.json, marketplace.json, plugin.json, CLAUDE.md)
- [ ] Git tag created with format vX.Y.Z
- [ ] GitHub release created from the tag
- [ ] CLAUDE.md: ONLY updated line 9 (version number), did NOT touch version history
- [ ] Commit and tags pushed to remote

**NEVER:**
- Update only one, two, or three files - ALL FOUR must be updated
- Skip the verification step
- Forget to create git tag
- Forget to create GitHub release
- Forget to ask user if version type is unclear
- Add version history entries to CLAUDE.md (that's managed separately)

## Reference Commands

```bash
# View current version
cat package.json | grep version

# Verify consistency across all version files
grep '"version"' package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json

# View git tags
git tag -l -n1
```
