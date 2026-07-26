# Plan: Three Long-Lived Release Branches (stable / core-dev / community-edge)

Owner: solo maintainer (thedotmack). Repo: github.com/thedotmack/claude-mem.
Goal: turn the three plan PRs into three permanent release lines, document the
strategy in one place, and give clone/run instructions for the non-stable lines.

## The three lines (source of truth)

| Line            | Branch           | For                                          | Published to npm? |
|-----------------|------------------|----------------------------------------------|-------------------|
| Stable          | `main`           | Everyone. The `npx claude-mem` install.      | Yes (only line)   |
| Core Dev        | `core-dev`       | Maintainer + testers wanting root-cause fixes | No — run from source |
| Community Edge  | `community-edge` | Bleeding edge, integrated community PRs       | No — run from source |

Flow (simplest, low-ceremony): all three start from `main`. `main` merges
**forward** into `core-dev` and `community-edge` to keep them current. Validated
fixes are promoted **back down** toward `main` via normal PRs. No gates, no
required reviewers — solo maintainer discretion.

## Facts (verified 2026-07-05)

- PR #3141 `plan/stable-working-build` @ `f6c7f51` — base `main`. STABLE landing.
- PR #3143 `plan/root-cause-holistic-fixes` @ `c81acee` — becomes `core-dev`.
- PR #3142 `plan/community-bleeding-edge` @ `a20d1ac` — becomes `community-edge`.
- No `core-dev` / `community-edge` branches exist on origin yet.
- Docs: `docs/public/*.mdx`, nav in `docs/public/docs.json` ("Configuration & Development" group at line 79).
- README contributing section: README.md ~line 374.
- Non-stable run path = clone + `git checkout <branch>` + `npm install` + `npm run build-and-sync`.

## Decision needed before execution (Phase 1)

The two source PRs #3143 and #3142 exist to merge their content into `main`. But
we are NOT merging them into `main` — their content becomes the permanent
`core-dev` / `community-edge` branches instead. So after the branches are pushed,
those two PRs are redundant.

**Recommended:** create the branches from the PR heads, then **close #3143 and
#3142** with a comment: "Promoted to long-lived branch `core-dev` /
`community-edge`; this is now a permanent release line, not a merge-to-main."
Keep #3141 open (or merge it) as the stable landing.

Confirm before Phase 1 runs the close.

---

## Phase 1 — Create & publish the branches

1. Create `core-dev` from PR #3143 head:
   `git branch core-dev c81acee39a771848bd30ee26e3c52ec26d713cd1`
   `git push origin core-dev`
2. Create `community-edge` from PR #3142 head:
   `git branch community-edge a20d1ac44144d4749acfd68faceda2794f3187f0`
   `git push origin community-edge`
3. (Per decision above) close #3143 and #3142 with the redirect comment.

**Verify:** `git ls-remote --heads origin | grep -E 'core-dev|community-edge'`
shows both refs at the expected SHAs.

## Phase 2 — Author the branch-strategy doc

Create `docs/public/branches.mdx`. Contents (copy this structure, don't invent):

- Frontmatter: `title: "Release Branches"`, description one-liner.
- Section "The three lines": the table above (stable/core-dev/community-edge, who
  it's for, npm-published yes/no).
- Section "How changes flow": `main` forward-merges into the two edge lines to
  stay current; validated fixes promote back to `main` via PR. One diagram/line,
  no policy ceremony.
- Section "Which one should I use?": Stable for normal use; core-dev to test
  root-cause reliability fixes early; community-edge for the newest community
  integrations (least stable).
- Section "Run a non-stable line locally":
  ```bash
  git clone https://github.com/thedotmack/claude-mem.git
  cd claude-mem
  git checkout core-dev          # or: community-edge
  npm install
  npm run build-and-sync         # builds + syncs to local marketplace + restarts worker
  ```
  Note: only `main` is published to npm, so `npx claude-mem@latest` always = stable.
  To go back to stable: `git checkout main && npm run build-and-sync`.
- Section "Releasing" (maintainer): releases (`npm run release`, tags, publish)
  happen from `main` only. Edge lines are source-run and never published.

**Verify:** file exists, frontmatter valid, no invented npm scripts (only real
ones: `build-and-sync`, `release`, `release:patch|minor|major`).

## Phase 3 — Wire up nav + README

1. `docs/public/docs.json`: add `"branches"` to the "Configuration & Development"
   group pages array (after `"development"`). Keep JSON valid.
2. `README.md` contributing section (~line 374): add a short line pointing to the
   Release Branches doc — "claude-mem ships from three branches: `main` (stable),
   `core-dev`, `community-edge`. See [Release Branches](https://docs.claude-mem.ai/branches)."

**Verify:** `node -e "JSON.parse(require('fs').readFileSync('docs/public/docs.json','utf8'))"`
exits clean. README renders the link.

## Phase 4 — Final verification

- Both branches pushed at correct SHAs (`git ls-remote`).
- `docs.json` parses.
- `branches.mdx` present and in nav.
- README updated.
- (If decided) #3143 and #3142 closed with redirect comments; #3141 status unchanged.
- Do NOT edit CHANGELOG (auto-generated).
