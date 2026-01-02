---
name: version-bump
description: Manage semantic version updates for claude-mem project. Handles patch, minor, and major version increments following semantic versioning. Updates package.json, marketplace.json, and plugin.json. Creates git tags and GitHub releases. Auto-generates CHANGELOG.md from releases.
---

# Version Bump Skill

**IMPORTANT:** You must first ultrathink and write detailed release notes before starting the version bump workflow.

## Version Types

- **PATCH** (x.y.Z): Bug fixes only
- **MINOR** (x.Y.0): New features, backward compatible
- **MAJOR** (X.0.0): Breaking changes

## Files to Update (ALL THREE)

1. `package.json` (line 3)
2. `.claude-plugin/marketplace.json` (line 13)
3. `plugin/.claude-plugin/plugin.json` (line 3)

## Workflow

```bash
# 1. Check current version
grep '"version"' package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json

# 2. Update all 3 files to new version (use Edit tool)

# 3. Verify consistency
grep '"version"' package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json

# 4. Build
npm run build

# 5. Commit version files
git add package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json
git commit -m "chore: bump version to X.Y.Z"

# 6. Create tag
git tag -a vX.Y.Z -m "Version X.Y.Z"

# 7. Push
git push origin main && git push origin vX.Y.Z

# 8. Create GitHub release (use your detailed release notes here)
gh release create vX.Y.Z --title "vX.Y.Z" --notes "RELEASE_NOTES_HERE"

# 9. Generate CHANGELOG.md from releases
gh api repos/thedotmack/claude-mem/releases --paginate | node -e "
const releases = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const lines = ['# Changelog', '', 'All notable changes to claude-mem.', ''];
releases.slice(0, 50).forEach(r => {
  const date = r.published_at.split('T')[0];
  lines.push('## [' + r.tag_name + '] - ' + date);
  lines.push('');
  if (r.body) lines.push(r.body.trim());
  lines.push('');
});
console.log(lines.join('\n'));
" > CHANGELOG.md

# 10. Commit CHANGELOG
git add CHANGELOG.md
git commit -m "docs: update CHANGELOG.md for vX.Y.Z"
git push origin main

# 11. Discord notification
npm run discord:notify vX.Y.Z
```

## Checklist

- [ ] Ultrathink + write detailed release notes
- [ ] All 3 files have matching version
- [ ] `npm run build` succeeds
- [ ] Git tag created (vX.Y.Z format)
- [ ] GitHub release created with detailed notes
- [ ] CHANGELOG.md updated
- [ ] Discord notification sent (if webhook configured)
