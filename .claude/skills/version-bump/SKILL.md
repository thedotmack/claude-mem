---
name: version-bump
description: Manage semantic version updates for claude-mem project. Handles patch, minor, and major version increments following semantic versioning. Updates package.json, marketplace.json, plugin.json, and CLAUDE.md consistently. Creates git tags.
---

# Version Bump Skill

IMPORTANT: This skill manages semantic versioning across the claude-mem project. YOU MUST update all FOUR version-tracked files consistently and create a git tag.

## Quick Reference

**Files requiring updates:**
1. `package.json` (line 3)
2. `.claude-plugin/marketplace.json` (line 13)
3. `plugin/.claude-plugin/plugin.json` (line 3)
4. `CLAUDE.md` (version history section)

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
- CLAUDE.md: Add v4.2.9 entry
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
Add entry at top of Version History section following the template below.

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
# Or whatever build command is appropriate
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
# Extract release notes from CLAUDE.md for the current version
gh release create vX.Y.Z --title "vX.Y.Z" --notes "[Paste relevant section from CLAUDE.md]"

# Or generate notes automatically from commits
gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes
```

**IMPORTANT**: Always create the GitHub release immediately after pushing the tag. This makes the release discoverable to users and triggers any automated workflows.

## CLAUDE.md Templates

### PATCH Version Template
```markdown
### v4.2.9
**Breaking Changes**: None (patch version)

**Fixes**:
- [Specific bug fixed with file reference: src/db/query.ts:45]
- [Impact: what this fixes for users]

**Technical Details**:
- Modified: [file paths with line numbers]
- Root cause: [brief explanation]
```

### MINOR Version Template
```markdown
### v4.3.0
**Breaking Changes**: None (minor version)

**Features**:
- [Feature name and user benefit]
- [How to use: command or API example]

**Improvements**:
- [Enhancement description]

**Technical Details**:
- New files: [paths]
- Modified: [paths with line numbers]
- Dependencies: [any new dependencies added]
```

### MAJOR Version Template
```markdown
### v5.0.0
**Breaking Changes**:
⚠️ [Change 1: what breaks and why]
⚠️ [Change 2: what breaks and why]

**Migration Guide**:
1. [Step-by-step instructions]
2. [Code examples showing old vs new]
3. [Data migration commands if needed]

**Features**:
- [New capabilities enabled by breaking changes]

**Technical Details**:
- Architectural changes: [high-level overview]
- Modified: [key files with line numbers]
- Removed: [deprecated APIs or features]
```

## Common Scenarios

**Scenario 1: Bug fix after testing**
```
User: "Fixed the memory leak in the search function"
You: Determine → PATCH
     Calculate → 4.2.8 → 4.2.9
     Update all four files
     Build and commit
     Create git tag v4.2.9
     Push commit and tags
     Create GitHub release v4.2.9
     CLAUDE.md: Focus on the fix and impact
```

**Scenario 2: New MCP tool added**
```
User: "Added web search MCP integration"
You: Determine → MINOR (new feature)
     Calculate → 4.2.8 → 4.3.0
     Update all four files
     Build and commit
     Create git tag v4.3.0
     Push commit and tags
     Create GitHub release v4.3.0
     CLAUDE.md: Describe feature and usage
```

**Scenario 3: Database schema redesign**
```
User: "Rewrote storage layer, old data needs migration"
You: Determine → MAJOR (breaking change)
     Calculate → 4.2.8 → 5.0.0
     Update all four files
     Build and commit
     Create git tag v5.0.0
     Push commit and tags
     Create GitHub release v5.0.0
     CLAUDE.md: Include migration steps
```

## Error Prevention

**ALWAYS verify:**
- [ ] All FOUR files have matching version numbers (package.json, marketplace.json, plugin.json, CLAUDE.md)
- [ ] Git tag created with format vX.Y.Z
- [ ] GitHub release created from the tag
- [ ] CLAUDE.md entry matches version type (patch/minor/major)
- [ ] Breaking changes are clearly marked with ⚠️
- [ ] File references use format: `path/to/file.ts:line_number`
- [ ] CLAUDE.md entry is added at TOP of version history
- [ ] Commit and tags pushed to remote

**NEVER:**
- Update only one, two, or three files - ALL FOUR must be updated
- Skip the verification step
- Forget to create git tag
- Forget to create GitHub release
- Forget to ask user if version type is unclear
- Use vague descriptions in CLAUDE.md

## Best Practices

1. **Be explicit about breaking changes** - Users need clear migration paths[(2)](https://docs.claude.com/en/docs/claude-code/plugins-reference#plugin-manifest-schema)
2. **Include file references** - Makes debugging easier later[(1)](https://www.anthropic.com/engineering/claude-code-best-practices)
3. **Test after bumping** - Ensure version displays correctly[(3)](https://www.anthropic.com/engineering/claude-code-best-practices)
4. **Keep CLAUDE.md concise** - Focus on user impact, not implementation minutiae[(1)](https://www.anthropic.com/engineering/claude-code-best-practices)
5. **Use consistent formatting** - Follow existing CLAUDE.md style[(1)](https://www.anthropic.com/engineering/claude-code-best-practices)

## Reference Commands

```bash
# View current version
cat package.json | grep version

# Check version history
head -50 CLAUDE.md | grep "^###"

# Verify consistency across all version files
grep '"version"' package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json

# View git tags
git tag -l -n1
```