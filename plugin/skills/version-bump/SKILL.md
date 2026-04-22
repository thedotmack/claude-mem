---
name: claude-code-plugin-release
description: Automated semantic versioning and release workflow for Claude Code plugins. Handles version increments across package.json, marketplace.json, plugin.json manifests, npm publishing (so `npx claude-mem@X.Y.Z` resolves), build verification, git tagging, GitHub releases, and changelog generation.
---

# Version Bump & Release Workflow

**IMPORTANT:** Plan and write detailed release notes before starting.

**CRITICAL:** Commit EVERYTHING (including build artifacts). At the end of this workflow, NOTHING should be left uncommitted or unpushed. Run `git status` at the end to verify.

## Preparation

1.  **Analyze**: Determine if the change is **PATCH** (bug fixes), **MINOR** (features), or **MAJOR** (breaking).
2.  **Environment**: Identify repository owner/name from `git remote -v`.
3.  **Paths — every file that carries the version string**:
    - `package.json` — **the npm/npx-published version** (`npx claude-mem@X.Y.Z` resolves from this)
    - `plugin/package.json` — bundled plugin runtime deps
    - `.claude-plugin/marketplace.json` — version inside `plugins[0].version`
    - `.claude-plugin/plugin.json` — top-level Claude-plugin manifest
    - `plugin/.claude-plugin/plugin.json` — bundled Claude-plugin manifest
    - `.codex-plugin/plugin.json` — Codex-plugin manifest

    Verify coverage before editing: `git grep -l "\"version\": \"<OLD>\""` should list all six. If a new manifest has been added since this doc was last updated, update this list.

## Workflow

1.  **Update**: Increment the version string in every path above. Do NOT touch `CHANGELOG.md` — it's regenerated.
2.  **Verify**: `git grep -n "\"version\": \"<NEW>\""` — confirm all six files match. `git grep -n "\"version\": \"<OLD>\""` — should return zero hits.
3.  **Build**: `npm run build` to regenerate artifacts.
4.  **Commit**: `git add -A && git commit -m "chore: bump version to X.Y.Z"`.
5.  **Tag**: `git tag -a vX.Y.Z -m "Version X.Y.Z"`.
6.  **Push**: `git push origin main && git push origin vX.Y.Z`.
7.  **Publish to npm** (this is what makes `npx claude-mem@X.Y.Z` work):
    ```bash
    npm publish
    ```
    The `prepublishOnly` script re-runs `npm run build` automatically. Confirm publish succeeded:
    ```bash
    npm view claude-mem@X.Y.Z version   # should print X.Y.Z
    ```
    Alternative: `npm run release:patch` / `release:minor` / `release:major` invokes `np` and handles tag+push+publish in one shot — use ONLY if you skipped steps 4–6, otherwise `np` will error on the existing tag.
8.  **GitHub release**: `gh release create vX.Y.Z --title "vX.Y.Z" --notes "RELEASE_NOTES"`.
9.  **Changelog**: Regenerate via the GitHub API + script:
    ```bash
    gh api repos/{owner}/{repo}/releases --paginate | ./scripts/generate_changelog.js > CHANGELOG.md
    ```
10. **Sync changelog**: Commit and push the updated `CHANGELOG.md`.
11. **Notify**: `npm run discord:notify vX.Y.Z` if applicable.
12. **Finalize**: `git status` — working tree must be clean.

## Checklist

- [ ] All six config files have matching versions
- [ ] `git grep` for old version returns zero hits
- [ ] `npm run build` succeeded
- [ ] Git tag created and pushed
- [ ] **`npm publish` succeeded and `npm view claude-mem@X.Y.Z version` confirms it** (so `npx claude-mem@X.Y.Z` resolves)
- [ ] GitHub release created with notes
- [ ] `CHANGELOG.md` updated and pushed
- [ ] `git status` shows clean tree
