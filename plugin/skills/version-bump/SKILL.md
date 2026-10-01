---
name: version-bump
description: Automated semantic versioning and release workflow for Claude Code plugins. Handles version increments across package.json, marketplace.json, plugin.json manifests, build verification, git tagging, GitHub releases, and changelog generation. NPM publishing is the final human-required handoff because the maintainer raised npm security.
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
    - `plugin/.codex-plugin/plugin.json` — bundled Codex-plugin manifest
    - `openclaw/openclaw.plugin.json` — OpenClaw plugin manifest

    Verify coverage before editing: `git grep -l "\"version\": \"<OLD>\""` should list all eight. If a new manifest has been added since this doc was last updated, update this list.

## Workflow

1.  **Update**: Increment the version string in every path above. Do NOT touch `CHANGELOG.md` — it's regenerated.
2.  **Verify**: `git grep -n "\"version\": \"<NEW>\""` — confirm all eight files match. `git grep -n "\"version\": \"<OLD>\""` — should return zero hits.
3.  **Build and sync**: `npm run build-and-sync` to regenerate artifacts, sync the local marketplace copy, restart the worker, and clear the queue. Do not use plain `npm run build` for release validation because it can leave the local marketplace/worker out of sync.
4.  **Commit**: `git add -A && git commit -m "chore: bump version to X.Y.Z"`.
5.  **Tag**: `git tag -a vX.Y.Z -m "Version X.Y.Z"`.
6.  **Push**: `git push origin main && git push origin vX.Y.Z`.
7.  **GitHub release**: `gh release create vX.Y.Z --title "vX.Y.Z" --notes "RELEASE_NOTES"`.
8.  **Changelog**: Regenerate via the project's changelog script:
    ```bash
    npm run changelog:generate
    ```
    (Runs `node scripts/generate-changelog.js`, which pulls releases from the GitHub API and rewrites `CHANGELOG.md`.)
9.  **Sync changelog**: Commit and push the updated `CHANGELOG.md`.
10. **Pre-handoff audit**: Verify the release commit, tag, GitHub release, and
    changelog are pushed; confirm the release worktree has no pending tracked
    changes; and ensure its build dependencies are present because
    `prepublishOnly` rebuilds the package. If `npm view claude-mem@X.Y.Z version`
    already resolves, skip the handoff and continue with post-publish checks.
11. **Final human handoff — publish to npm.** Do not stop in the middle of the
    workflow for npm. Finish every agent-owned preparation above first, then
    make this the final human-required action.

    The human maintainer's credentials/2FA are required. The agent MUST NOT run
    `npm publish` (or `np` / `npm run release:*`, which also publish). Give the
    exact release-worktree path and this command as the only requested action:
    ```bash
    npm publish   # run by the HUMAN — prepublishOnly rebuilds the package
    ```
    Wait for confirmation. Do not ask the human to perform any other release
    step afterward.
12. **Post-publish verification and notification**: After confirmation, verify
    both the exact version and the latest dist-tag:
    ```bash
    npm view claude-mem@X.Y.Z version
    npm view claude-mem version
    ```
    If the publish build touched tracked artifacts, run `npm run build-and-sync`,
    review the result, and commit/push any legitimate changes. Then run the
    Discord notification from `~/Scripts/claude-mem/`, where the `.env` with
    webhook details lives:
    ```bash
    cd ~/Scripts/claude-mem/ && npm run discord:notify vX.Y.Z
    ```
    Do this only after npm verification, and even when the release worktree does
    not have a local `.env`.
13. **Finalize**: `git status` — working tree must be clean and everything must
    be pushed. Only automated verification, notification, and cleanup may occur
    after the final human handoff.

## Checklist

- [ ] All eight config files have matching versions
- [ ] `git grep` for old version returns zero hits
- [ ] `npm run build-and-sync` succeeded
- [ ] Git tag created and pushed
- [ ] GitHub release created with notes
- [ ] `CHANGELOG.md` updated and pushed
- [ ] Pre-handoff audit passed; no agent-owned release preparation remains
- [ ] **NPM publishing handed off as the final human-required action** (agent does NOT run it)
- [ ] Exact npm version and `latest` both verified after the human publishes
- [ ] Discord notification run from `~/Scripts/claude-mem/` only after npm verification
- [ ] `git status` shows clean tree
