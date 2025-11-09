# Common Version Bump Scenarios

Real-world examples of version bumps with decision rationale.

## Scenario 1: Bug Fix After Testing

**User request:**
> "Fixed the memory leak in the search function"

**Analysis:**
- What changed: Bug fix
- Breaking changes: No
- New features: No
- **Decision: PATCH**

**Workflow:**
```
Current: 4.2.8
New: 4.2.9 (PATCH)

Steps:
1. Update all four files to 4.2.9
2. npm run build
3. git commit -m "Release v4.2.9: Fixed memory leak in search"
4. git tag v4.2.9 -m "Release v4.2.9: Fixed memory leak in search"
5. git push && git push --tags
6. gh release create v4.2.9 --title "v4.2.9" --notes "Fixed memory leak in search function"
```

## Scenario 2: New Feature Added

**User request:**
> "Added web search MCP integration"

**Analysis:**
- What changed: New feature (MCP integration)
- Breaking changes: No
- Backward compatible: Yes
- **Decision: MINOR**

**Workflow:**
```
Current: 4.2.8
New: 4.3.0 (MINOR - reset patch to 0)

Steps:
1. Update all four files to 4.3.0
2. npm run build
3. git commit -m "Release v4.3.0: Added web search MCP integration"
4. git tag v4.3.0 -m "Release v4.3.0: Added web search MCP integration"
5. git push && git push --tags
6. gh release create v4.3.0 --title "v4.3.0" --generate-notes
```

## Scenario 3: Database Schema Redesign

**User request:**
> "Rewrote storage layer, old data needs migration"

**Analysis:**
- What changed: Storage layer rewrite
- Breaking changes: Yes (requires migration)
- Backward compatible: No
- **Decision: MAJOR**

**Workflow:**
```
Current: 4.2.8
New: 5.0.0 (MAJOR - reset minor and patch to 0)

Steps:
1. Update all four files to 5.0.0
2. npm run build
3. git commit -m "Release v5.0.0: Storage layer redesign with migration required"
4. git tag v5.0.0 -m "Release v5.0.0: Storage layer redesign"
5. git push && git push --tags
6. gh release create v5.0.0 --title "v5.0.0" --notes "⚠️ Breaking change: Storage layer redesigned. Migration required."
```

## Scenario 4: Multiple Small Bug Fixes

**User request:**
> "Fixed three bugs: observer crash, viewer pagination, and date formatting"

**Analysis:**
- What changed: Multiple bug fixes
- Breaking changes: No
- New features: No
- **Decision: PATCH** (one patch covers all fixes)

**Workflow:**
```
Current: 4.2.8
New: 4.2.9 (PATCH)

Steps:
1. Update all four files to 4.2.9
2. npm run build
3. git commit -m "Release v4.2.9: Multiple bug fixes

- Fixed observer crash on empty content
- Fixed viewer pagination edge case
- Fixed date formatting in timeline"
4. git tag v4.2.9 -m "Release v4.2.9: Multiple bug fixes"
5. git push && git push --tags
6. gh release create v4.2.9 --title "v4.2.9" --generate-notes
```

## Scenario 5: Feature + Bug Fix

**User request:**
> "Added dark mode support and fixed the viewer crash bug"

**Analysis:**
- What changed: New feature + bug fix
- Breaking changes: No
- **Decision: MINOR** (feature trumps bug fix)

**Workflow:**
```
Current: 5.1.0
New: 5.2.0 (MINOR)

Steps:
1. Update all four files to 5.2.0
2. npm run build
3. git commit -m "Release v5.2.0: Dark mode support + bug fixes

Features:
- Added dark mode toggle to viewer UI

Bug fixes:
- Fixed viewer crash on empty database"
4. git tag v5.2.0 -m "Release v5.2.0: Dark mode support"
5. git push && git push --tags
6. gh release create v5.2.0 --title "v5.2.0" --generate-notes
```

## Scenario 6: Documentation Only

**User request:**
> "Updated README with new installation instructions"

**Analysis:**
- What changed: Documentation only
- Breaking changes: No
- Code changes: No
- **Decision: PATCH** (or skip version bump if no code changes)

**Workflow:**
```
Option 1: PATCH (if you want to tag doc improvements)
Current: 4.2.8
New: 4.2.9

Option 2: No version bump (documentation-only changes don't require versioning)
Just commit without bumping version
```

**Recommendation:** Skip version bump for documentation-only changes unless it's a significant documentation overhaul.

## Scenario 7: Configuration Change

**User request:**
> "Changed default observation count from 50 to 30"

**Analysis:**
- What changed: Default configuration
- Breaking changes: Yes (behavior changes)
- Users might notice different context size
- **Decision: MINOR or MAJOR** (ask user)

**Workflow:**
```
Ask user:
"This changes default behavior (context size). Users will see different results.
Is this:
- MINOR (acceptable behavior change): 4.2.8 → 4.3.0
- MAJOR (breaking change): 4.2.8 → 5.0.0

Which should I use?"
```

## Scenario 8: Dependency Update

**User request:**
> "Updated Claude SDK from 1.2.0 to 1.3.0"

**Analysis:**
- What changed: Dependency version
- Breaking changes: Depends on SDK changes
- **Decision: Ask user or check SDK changelog**

**Workflow:**
```
1. Check SDK changelog for breaking changes
2. If SDK has breaking changes → MAJOR
3. If SDK adds features → MINOR
4. If SDK only fixes bugs → PATCH

Typical: PATCH (unless SDK breaks compatibility)
```

## Decision Tree

```
Is there a breaking change?
├─ Yes → MAJOR (X.0.0)
└─ No
   ├─ Is there a new feature?
   │  ├─ Yes → MINOR (x.Y.0)
   │  └─ No
   │     ├─ Is there a bug fix?
   │     │  ├─ Yes → PATCH (x.y.Z)
   │     │  └─ No → Don't bump version (docs only, etc.)
   │     └─ Configuration change? → Ask user (MINOR or MAJOR)
   └─ Multiple changes? → Use highest level (MAJOR > MINOR > PATCH)
```
