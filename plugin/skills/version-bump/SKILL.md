---
name: version-bump
description: Automated semantic versioning and release workflow for Claude Code plugins. Handles version increments across package.json, marketplace.json, plugin.json manifests, build verification, git tagging, GitHub releases, and changelog generation. Ends with the agent running npm publish itself using the maintainer's npm token.
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
    - `.grok-plugin/plugin.json` — Grok plugin manifest
    - `claude-mem-cursor/.cursor-plugin/plugin.json` — Cursor plugin manifest
    - `claude-mem-grok-bot/.cursor-plugin/plugin.json` — Grok Bot Cursor plugin manifest
    - `README.md` — the version badge (`version-X.Y.Z-green`), not a `"version"` key

    Verify coverage before editing: `git grep -l "\"version\": \"<OLD>\""` should list the eleven JSON files above, and `git grep -n "version-<OLD>-green"` the README badge. If a new manifest has been added since this doc was last updated, update this list.

## Workflow

1.  **Update**: Increment the version string in every path above. Do NOT touch `CHANGELOG.md` — it's regenerated.
2.  **Verify**: `git grep -n "\"version\": \"<NEW>\""` — confirm all eleven JSON files match, and the README badge reads `version-<NEW>-green`. `git grep -n "\"version\": \"<OLD>\""` — should return zero hits.
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
10. **Pre-publish audit**: Verify the release commit, tag, GitHub release, and
    changelog are pushed; confirm the release worktree has no pending tracked
    changes; and ensure its build dependencies are present because
    `prepublishOnly` rebuilds the package. If `npm view claude-mem@X.Y.Z version`
    already resolves, skip the publish and continue with post-publish checks.
11. **Publish to npm — the agent runs it.** The old "human handoff" rule is
    obsolete: the maintainer allows agents to publish. The token is a
    **30-day** granular npm token (read/write on `claude-mem` only, bypass 2FA)
    in the maintainer's Mac `~/.npmrc`; he issues a new one every month. It is
    deliberately NOT in any backup (grok-bot-backups excludes secrets), so do
    not go looking for it elsewhere. Publish from a clean worktree of the tag
    (inside the project's `.scratch/`) so uncommitted edits never ship:
    ```bash
    git worktree add --detach .scratch/release-X.Y.Z vX.Y.Z
    cd .scratch/release-X.Y.Z && npm install --ignore-scripts
    npm whoami                    # must print thedotmack; 401 = token expired
    npm publish --access public   # prepublishOnly rebuilds the package
    ```
    **If `npm whoami` fails, the monthly token has expired.** Finish every other
    step, then: open https://www.npmjs.com/settings/thedotmack/tokens/granular-access-tokens/new
    for the maintainer (`open <url>`), replace the token value in `~/.npmrc` with
    `PASTE_NEW_TOKEN_HERE`, and `open -e ~/.npmrc` so he can paste the new token
    there. Never ask for the token in chat. Re-run `npm whoami`, then publish.
    Do not wait on `.github/workflows/npm-publish.yml` — its `NPM_TOKEN` secret
    has failed every tag since v13.26.1 (`E404 ... PUT https://registry.npmjs.org/claude-mem`).
    The publish rebuild rewrites `plugin/scripts/*.cjs` with minifier-name churn
    only; discard it with the worktree (`git worktree remove --force`).
12. **Post-publish verification and notification**: After publishing, verify
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
    be pushed.

## Checklist

- [ ] All twelve version files (eleven JSON manifests and the README badge) have matching versions
- [ ] `git grep` for old version returns zero hits
- [ ] `npm run build-and-sync` succeeded
- [ ] Git tag created and pushed
- [ ] GitHub release created with notes
- [ ] `CHANGELOG.md` updated and pushed
- [ ] Pre-publish audit passed
- [ ] `npm whoami` succeeded and the agent ran `npm publish --access public`
- [ ] Exact npm version and `latest` both verified after publishing
- [ ] Discord notification run from `~/Scripts/claude-mem/` only after npm verification
- [ ] `git status` shows clean tree
