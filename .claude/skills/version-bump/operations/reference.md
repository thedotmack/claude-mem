# Version Bump Reference

Quick reference for version bump commands and file locations.

## File Locations

### Version-Tracked Files (ALL FOUR)

1. **package.json**
   - Path: `package.json`
   - Line: 3
   - Format: `"version": "X.Y.Z",`

2. **marketplace.json**
   - Path: `.claude-plugin/marketplace.json`
   - Line: 13
   - Format: `"version": "X.Y.Z",`

3. **plugin.json**
   - Path: `plugin/.claude-plugin/plugin.json`
   - Line: 3
   - Format: `"version": "X.Y.Z",`

4. **CLAUDE.md**
   - Path: `CLAUDE.md`
   - Line: 9
   - Format: `**Current Version**: X.Y.Z`

## Essential Commands

### View Current Version

```bash
# From package.json
grep '"version"' package.json

# Extract just the version number
grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/'

# From all version files
grep '"version"' package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json
grep "Current Version" CLAUDE.md
```

### Verify Version Consistency

```bash
# Check all JSON files match
grep '"version"' package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json

# Should output identical version in all three:
# package.json:3:  "version": "5.3.0",
# .claude-plugin/marketplace.json:13:  "version": "5.3.0",
# plugin/.claude-plugin/plugin.json:3:  "version": "5.3.0",

# Check CLAUDE.md
grep "Current Version" CLAUDE.md
# Should output: **Current Version**: 5.3.0
```

### Git Commands

```bash
# View recent commits
git log --oneline -5

# View changes since last tag
LAST_TAG=$(git describe --tags --abbrev=0)
git log $LAST_TAG..HEAD --oneline
git diff $LAST_TAG..HEAD

# List all tags
git tag -l

# View tag details
git show vX.Y.Z

# List tags with messages
git tag -l -n1
```

### Build and Test

```bash
# Build plugin
npm run build

# Sync to marketplace
npm run sync-marketplace

# Run tests (if available)
npm test
```

### Commit and Tag

```bash
# Stage version files
git add package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json CLAUDE.md plugin/scripts/

# Commit
git commit -m "Release vX.Y.Z: [Description]"

# Create tag
git tag vX.Y.Z -m "Release vX.Y.Z: [Description]"

# Push
git push && git push --tags
```

### GitHub Release

```bash
# Create release
gh release create vX.Y.Z --title "vX.Y.Z" --notes "[Release notes]"

# Create with auto-generated notes
gh release create vX.Y.Z --title "vX.Y.Z" --generate-notes

# View release
gh release view vX.Y.Z

# List all releases
gh release list

# Delete release (if needed)
gh release delete vX.Y.Z
```

## Semantic Versioning Rules

### Version Format: MAJOR.MINOR.PATCH

**MAJOR (X.0.0):**
- Breaking changes
- Incompatible API changes
- Schema changes requiring migration
- Removes features

**MINOR (x.Y.0):**
- New features (backward compatible)
- New functionality
- Deprecations (but not removals)
- Resets PATCH to 0

**PATCH (x.y.Z):**
- Bug fixes
- Performance improvements
- Documentation fixes
- No new features

### Incrementing Rules

```
PATCH: 5.3.2 → 5.3.3
MINOR: 5.3.2 → 5.4.0 (resets patch)
MAJOR: 5.3.2 → 6.0.0 (resets minor and patch)
```

## Common Patterns

### Bug Fix Release

```bash
# Example: 5.3.0 → 5.3.1
# 1. Update all four files to 5.3.1
# 2. Build and test
npm run build
# 3. Commit and tag
git add package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json CLAUDE.md plugin/scripts/
git commit -m "Release v5.3.1: Fixed observer crash"
git tag v5.3.1 -m "Release v5.3.1: Fixed observer crash"
git push && git push --tags
# 4. Create release
gh release create v5.3.1 --title "v5.3.1" --notes "Fixed observer crash on empty content"
```

### Feature Release

```bash
# Example: 5.3.0 → 5.4.0
# 1. Update all four files to 5.4.0
# 2. Build and test
npm run build
# 3. Commit and tag
git add package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json CLAUDE.md plugin/scripts/
git commit -m "Release v5.4.0: Added dark mode support"
git tag v5.4.0 -m "Release v5.4.0: Added dark mode support"
git push && git push --tags
# 4. Create release
gh release create v5.4.0 --title "v5.4.0" --generate-notes
```

### Breaking Change Release

```bash
# Example: 5.3.0 → 6.0.0
# 1. Update all four files to 6.0.0
# 2. Build and test
npm run build
# 3. Commit and tag
git add package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json CLAUDE.md plugin/scripts/
git commit -m "Release v6.0.0: Storage layer redesign"
git tag v6.0.0 -m "Release v6.0.0: Storage layer redesign"
git push && git push --tags
# 4. Create release with warning
gh release create v6.0.0 --title "v6.0.0" --notes "⚠️ Breaking change: Storage layer redesigned. Migration required."
```

## Rollback Commands

### Delete Tag

```bash
# Delete local tag
git tag -d vX.Y.Z

# Delete remote tag
git push origin :refs/tags/vX.Y.Z
# Or: git push --delete origin vX.Y.Z
```

### Delete Release

```bash
# Delete GitHub release
gh release delete vX.Y.Z

# Confirm deletion
gh release delete vX.Y.Z --yes
```

### Revert Commit

```bash
# Revert last commit (creates new commit)
git revert HEAD

# Reset to previous commit (destructive)
git reset --hard HEAD~1
git push --force  # Dangerous! Only if not shared
```

## Error Prevention

### Pre-commit Checks

```bash
# Check all versions match before committing
V1=$(grep '"version"' package.json | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
V2=$(grep '"version"' .claude-plugin/marketplace.json | sed 's/.*"\([^"]*\)".*/\1/')
V3=$(grep '"version"' plugin/.claude-plugin/plugin.json | head -1 | sed 's/.*"\([^"]*\)".*/\1/')

if [ "$V1" = "$V2" ] && [ "$V2" = "$V3" ]; then
  echo "✓ All versions match: $V1"
else
  echo "✗ Version mismatch!"
  echo "  package.json: $V1"
  echo "  marketplace.json: $V2"
  echo "  plugin.json: $V3"
fi
```

### Pre-push Checks

```bash
# Check tag exists
git tag -l | grep vX.Y.Z || echo "Warning: Tag not created"

# Check build succeeds
npm run build || echo "Error: Build failed"

# Check no uncommitted changes
git status --porcelain | grep -q . && echo "Warning: Uncommitted changes"
```
