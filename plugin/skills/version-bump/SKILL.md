---
name: version-bump
description: Maintainer release workflow for the thedotmack/claude-mem repository only. Handles version increments across package.json, marketplace.json, plugin.json manifests, build verification, git tagging, GitHub releases, and changelog generation. npm publishing is done by the tag-triggered GitHub Actions workflow through npm trusted publishing. Does not apply to any other repository or npm package.
---

# Version Bump & Release Workflow

**IMPORTANT:** Plan and write detailed release notes before starting.

Include the pending Unreleased section at the top of `docs/CHANGELOG.md` in the next GitHub release notes; remove that section after those notes are published, before regenerating the changelog.

**CRITICAL:** Commit EVERYTHING (including build artifacts). At the end of this workflow, NOTHING should be left uncommitted or unpushed. Run `git status` at the end to verify.

## Scope — check this first

This workflow is for **one repository and one npm package**: `thedotmack/claude-mem`,
published as `claude-mem`. It is not a general release recipe. Do not adapt any
step of it to another repository or package.

Before doing anything else, run:

```bash
git remote get-url origin   # must be github.com/thedotmack/claude-mem(.git)
node -p "require('./package.json').name"   # must print claude-mem
```

If either check fails, stop and tell the user this skill does not apply here.

## Preparation

1.  **Analyze**: Determine if the change is **PATCH** (bug fixes), **MINOR** (features), or **MAJOR** (breaking).
2.  **Environment**: The repository is `thedotmack/claude-mem`, confirmed by the scope check above.
3.  **Paths — every file that carries the version string**:
    - `package.json` — **the npm/npx-published version** (`npx claude-mem@X.Y.Z` resolves from this)
    - `plugin/package.json` — bundled plugin runtime deps
    - `.claude-plugin/marketplace.json` — version inside `plugins[0].version`
    - `.claude-plugin/plugin.json` — top-level Claude-plugin manifest
    - `plugin/.claude-plugin/plugin.json` — bundled Claude-plugin manifest
    - `.codex-plugin/plugin.json` — Codex-plugin manifest
    - `plugin/.codex-plugin/plugin.json` — bundled Codex-plugin manifest
    - `.qoder-plugin/plugin.json` — Qoder plugin manifest
    - `plugin/.qoder-plugin/plugin.json` — bundled Qoder plugin manifest
    - `openclaw/openclaw.plugin.json` — OpenClaw plugin manifest
    - `.grok-plugin/plugin.json` — Grok plugin manifest
    - `claude-mem-cursor/.cursor-plugin/plugin.json` — Cursor plugin manifest
    - `claude-mem-grok-bot/.cursor-plugin/plugin.json` — Grok Bot Cursor plugin manifest
    - `dsh/package.json` — bundled DSH plugin package
    - `README.md` — the version badge (`version-X.Y.Z-green`), not a `"version"` key

    Verify coverage before editing: `git grep -l "\"version\": \"<OLD>\""` should list the fourteen JSON files above, and `git grep -n "version-<OLD>-green"` the README badge. If a new manifest has been added since this doc was last updated, update this list.

## Workflow

1.  **Update**: Increment the version string in every path above. Published entries in `docs/CHANGELOG.md` are regenerated; only move pending Unreleased notes as described above.
2.  **Verify**: `git grep -n "\"version\": \"<NEW>\""` — confirm all fourteen JSON files match, and the README badge reads `version-<NEW>-green`. `git grep -n "\"version\": \"<OLD>\""` — should return zero hits.
3.  **Build and sync**: `npm run build-and-sync` to regenerate artifacts, sync the local marketplace copy, restart the worker, and clear the queue. Do not use plain `npm run build` for release validation because it can leave the local marketplace/worker out of sync.
4.  **Commit**: `git add -A && git commit -m "chore: bump version to X.Y.Z"`.
5.  **Tag**: `git tag -a vX.Y.Z -m "Version X.Y.Z"`.
6.  **Push**: `git push origin main && git push origin vX.Y.Z`.
7.  **GitHub release**: `gh release create vX.Y.Z --title "vX.Y.Z" --notes "RELEASE_NOTES"`.
8.  **Changelog**: Regenerate via the project's changelog script:
    ```bash
    npm run changelog:generate
    ```
    (Runs `node scripts/generate-changelog.js`, which pulls releases from the GitHub API and rewrites `docs/CHANGELOG.md`.)
9.  **Sync changelog**: Commit and push the updated `docs/CHANGELOG.md`.
10. **Pre-publish audit**: Verify the release commit, tag, GitHub release, and
    changelog are pushed, and the release worktree has no pending tracked changes.
11. **Publish to npm — the workflow does it.** Pushing the `vX.Y.Z` tag triggers
    `.github/workflows/npm-publish.yml`, which builds, runs the clean-room smoke
    and publishes through npm trusted publishing (GitHub OIDC), so it needs no
    npm token. Watch the run:
    ```bash
    gh run list --workflow npm-publish.yml --branch vX.Y.Z   # tag runs report the tag as their branch
    gh run watch <run-id> --exit-status
    ```
    **Do not run `npm publish` locally**, even if a local npm login works: the
    workflow is the only publish path, and only it attaches provenance.
    If the run fails, read the failing step with `gh run view <run-id> --log-failed`.
    A transient failure (network, registry outage) is re-run with
    `gh run rerun <run-id>`; a re-run builds the same tagged commit, so a fix in
    the code or workflow ships through a PR and the next patch release instead.
    Never move or recreate a pushed tag.
    The trusted publisher lives on npmjs.com → `claude-mem` → Settings →
    Trusted Publisher (GitHub Actions, `thedotmack/claude-mem`, `npm-publish.yml`,
    `npm publish` allowed). Renaming the workflow file breaks publishing until
    that entry is updated; changing it requires the maintainer's security key.
12. **Post-publish verification**: After publishing, verify
    both the exact version and the latest dist-tag:
    ```bash
    npm view claude-mem@X.Y.Z version
    npm view claude-mem dist-tags.latest
    npm view claude-mem@X.Y.Z dist.attestations --json   # provenance from the workflow
    ```
13. **Promote for auto-update**: `releases/promoted-release.json` on `main` names
    the version claude-mem's own updater moves installs to. Promote, hold and
    pull back control only that updater: installs where Claude Code's own
    auto-update for this marketplace is on follow `main` instead, so a bad
    release that reached `main` is fixed with a new patch release. Do this step
    only after npm verification.
    - **Promote:** these commands work from a detached release worktree and
      when `main` has moved since the release push:
      ```bash
      git pull --rebase origin main
      # set "promotedVersion" in releases/promoted-release.json to "X.Y.Z"
      bun test tests/infrastructure/promoted-release.test.ts
      git add releases/promoted-release.json
      git commit -m "chore: promote X.Y.Z for auto-update"
      git push origin HEAD:main
      ```
      If the push is rejected because `main` moved again (git reports
      `non-fast-forward` or `fetch first`), run `git pull --rebase origin main`
      and push again. Most installs update within about a day; a machine that
      is never quiet updates within about two days.
    - **Hold:** only when the owner asked to hold this release. Skip this step
      and say so in the release report.
    - **Pull back a bad release:** set `promotedVersion` to the last good
      version (find it with `git log -p -- releases/promoted-release.json`) and
      push it with the same commands. Installs below it still move up to it.
      Installs already on the bad version stay there until a newer version is
      promoted. Nothing is downgraded.
14. **Notification**: Post the release to X, only after npm verification:
    - Generate one image about the release with an available image-generation
      tool, drawn from the release notes.
    - In a browser that is already logged in to X (for example Claude in
      Chrome), open x.com and check the active account is `@Claude_Memory`.
      If no browser is logged in, or the account is a different one, skip the
      post and say so in the release report. Never sign in or switch accounts.
    - Post a short summary of the release with the version, the GitHub release
      URL and the image attached, then report the post's URL.
15. **Finalize**: `git status` — working tree must be clean and everything must
    be pushed.

## Checklist

- [ ] All fifteen version files (fourteen JSON manifests and the README badge) have matching versions
- [ ] `git grep` for old version returns zero hits
- [ ] `npm run build-and-sync` succeeded
- [ ] Git tag created and pushed
- [ ] GitHub release created with notes
- [ ] `docs/CHANGELOG.md` updated and pushed
- [ ] Pre-publish audit passed
- [ ] `Publish to npm` workflow run for the tag succeeded (no local `npm publish`)
- [ ] Exact npm version and `latest` both verified after publishing
- [ ] `releases/promoted-release.json` set to X.Y.Z and pushed to `main` after npm verification (or the owner's hold stated in the release report)
- [ ] Release posted to X as `@Claude_Memory` with a generated image after npm verification (or skipped because no browser was logged in as that account)
- [ ] `git status` shows clean tree
