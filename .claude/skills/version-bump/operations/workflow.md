# Detailed Version Bump Workflow

Step-by-step process for bumping versions in the claude-mem project.

## Step 1: Analyze Changes

First, understand what changed:

```bash
# View recent commits
git log --oneline -5

# See what changed in last commit
git diff HEAD~1

# Or see all changes since last tag
LAST_TAG=$(git describe --tags --abbrev=0)
git log $LAST_TAG..HEAD --oneline
git diff $LAST_TAG..HEAD
```

## Step 2: Determine Version Type

Ask yourself:
- **Breaking changes?** → MAJOR
- **New features?** → MINOR
- **Bugfixes only?** → PATCH

**If unclear, ASK THE USER explicitly.**

### Decision Matrix

| Change Type | Version Bump | Example |
|------------|--------------|---------|
| Bug fix | PATCH | 4.2.8 → 4.2.9 |
| New feature (backward compatible) | MINOR | 4.2.8 → 4.3.0 |
| Breaking change | MAJOR | 4.2.8 → 5.0.0 |
| Multiple features | MINOR | 4.2.8 → 4.3.0 |
| Feature + breaking change | MAJOR | 4.2.8 → 5.0.0 |

## Step 3: Calculate New Version

From current version in `package.json`:

```bash
grep '"version"' package.json
```

Apply semantic versioning rules:
- **Patch:** increment Z (4.2.8 → 4.2.9)
- **Minor:** increment Y, reset Z (4.2.8 → 4.3.0)
- **Major:** increment X, reset Y and Z (4.2.8 → 5.0.0)

## Step 4: Preview Changes

**BEFORE making changes, show the user:**

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

Wait for user confirmation before proceeding.

## Step 5: Update Files

### Update package.json

File: `package.json`

```json
{
  "name": "claude-mem",
  "version": "4.2.9",
  ...
}
```

Update line 3 with new version.

### Update marketplace.json

File: `.claude-plugin/marketplace.json`

```json
{
  "name": "claude-mem",
  "version": "4.2.9",
  ...
}
```

Update line 13 with new version.

### Update plugin.json

File: `plugin/.claude-plugin/plugin.json`

```json
{
  "name": "claude-mem",
  "version": "4.2.9",
  ...
}
```

Update line 3 with new version.

### Update CLAUDE.md

File: `CLAUDE.md`

**ONLY update line 9 with the version number:**

```markdown
**Current Version**: 4.2.9
```

**CRITICAL:** DO NOT add version history entries to CLAUDE.md. Version history is managed separately outside this skill.

## Step 6: Verify Consistency

```bash
# Check all versions match
grep -n '"version"' package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json

# Should show same version in all three files:
# package.json:3:  "version": "4.2.9",
# .claude-plugin/marketplace.json:13:  "version": "4.2.9",
# plugin/.claude-plugin/plugin.json:3:  "version": "4.2.9",
```

All three must match exactly.

## Step 7: Test

```bash
# Verify the plugin loads correctly
npm run build
```

Build must succeed before proceeding.

## Step 8: Commit and Tag

```bash
# Stage all version files
git add package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json CLAUDE.md plugin/scripts/

# Commit with descriptive message
git commit -m "Release vX.Y.Z: [Brief description]

[Optional detailed description]

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"

# Create annotated git tag
git tag vX.Y.Z -m "Release vX.Y.Z: [Brief description]"

# Push commit and tags
git push && git push --tags
```

Replace `X.Y.Z` with actual version (e.g., `4.2.9`).

## Step 9: Create GitHub Release

```bash
# Create GitHub release from the tag
gh release create vX.Y.Z --title "vX.Y.Z" --notes "[Brief release notes]"

# Or generate notes automatically from commits
gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes
```

**IMPORTANT:** Always create the GitHub release immediately after pushing the tag. This makes the release discoverable to users and triggers any automated workflows.

## Step 10: Generate CHANGELOG

After creating the GitHub release, regenerate CHANGELOG.md from all releases:

```bash
# Generate CHANGELOG.md from all GitHub releases
npm run changelog:generate

# Review the generated changelog
git diff CHANGELOG.md

# Commit and push the updated changelog
git add CHANGELOG.md
git commit -m "Update CHANGELOG.md for vX.Y.Z release"
git push
```

**Why this step:**
- CHANGELOG.md is auto-generated from GitHub releases
- Keeps the changelog in sync with release notes
- No manual editing required
- Single source of truth: GitHub releases

## Verification

After completing all steps, verify:

```bash
# Check git tag created
git tag -l | grep vX.Y.Z

# Check remote has tag
git ls-remote --tags origin | grep vX.Y.Z

# Check GitHub release exists
gh release view vX.Y.Z

# Verify versions match
grep '"version"' package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json
```

All checks should pass.

## Rollback (If Needed)

If you made a mistake:

```bash
# Delete local tag
git tag -d vX.Y.Z

# Delete remote tag (if already pushed)
git push origin :refs/tags/vX.Y.Z

# Delete GitHub release (if created)
gh release delete vX.Y.Z

# Revert commits if needed
git revert HEAD
```

Then restart the workflow with correct version.
