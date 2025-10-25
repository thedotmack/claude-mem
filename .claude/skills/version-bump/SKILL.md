---
name: version-bump
description: Manage semantic version updates for claude-mem project. Handles patch, minor, and major version increments following semantic versioning. Updates package.json, marketplace.json, and CLAUDE.md consistently.
---

# Version Bump Skill

IMPORTANT: This skill manages semantic versioning across the claude-mem project. YOU MUST update all three version-tracked files consistently.

## Quick Reference

**Files requiring updates:**
1. `package.json` (line 3)
2. `.claude-plugin/marketplace.json` (line 13)
3. `CLAUDE.md` (version history section)

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
- CLAUDE.md: Add v4.2.9 entry

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

**Update CLAUDE.md:**
Add entry at top of Version History section following the template below.

### 6. Verify Consistency
```bash
# Check all versions match
grep -n '"version"' package.json .claude-plugin/marketplace.json
# Should show same version in both files
```

### 7. Test
```bash
# Verify the plugin loads correctly
npm run build
# Or whatever build command is appropriate
```

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
     Update all three files
     CLAUDE.md: Focus on the fix and impact
```

**Scenario 2: New MCP tool added**
```
User: "Added web search MCP integration"
You: Determine → MINOR (new feature)
     Calculate → 4.2.8 → 4.3.0
     Update all three files
     CLAUDE.md: Describe feature and usage
```

**Scenario 3: Database schema redesign**
```
User: "Rewrote storage layer, old data needs migration"
You: Determine → MAJOR (breaking change)
     Calculate → 4.2.8 → 5.0.0
     Update all three files
     CLAUDE.md: Include migration steps
```

## Error Prevention

**ALWAYS verify:**
- [ ] All three files have matching version numbers
- [ ] CLAUDE.md entry matches version type (patch/minor/major)
- [ ] Breaking changes are clearly marked with ⚠️
- [ ] File references use format: `path/to/file.ts:line_number`
- [ ] CLAUDE.md entry is added at TOP of version history

**NEVER:**
- Update only one or two files
- Skip the verification step
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

# Verify consistency
diff <(jq -r .version package.json) <(jq -r .version .claude-plugin/marketplace.json)
```