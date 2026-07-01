# Ship cmem-sdk — Release Plan

Status: implementation plan
Date: 2026-06-07
Branch: `mutual-aardvark`
Implements release of: `plans/2026-05-25-cmem-sdk-and-server-rename.md` (all 9 phases built + audited, verdict SHIP)

## Goal

Get the already-built, already-verified cmem-sdk **published and merged to main**.
The code is feature-complete (62/62 SDK tests green in audit, 2094 full-suite passing,
build + typecheck + import-guard all pass). What remains is purely **release
mechanics**: commit the audit cleanup, rebase onto a moved main, get CI green, merge,
then cut version **13.5.0** via the `/version-bump` skill off main.

## Locked decisions (from user, 2026-06-07)

1. **Version: MINOR → `13.5.0`.** New public `claude-mem/sdk` export is additive;
   server-beta→server rename preserves back-compat (audit obs 2533/2534).
2. **Publish: via the `/claude-mem:version-bump` skill, run off `main`.** Do NOT
   `npm publish` by hand and do NOT push a tag manually — the skill drives manifests,
   build-and-sync, commit, tag, push, npm publish, changelog, and GitHub release.
   (`npm-publish.yml` auto-publishes on `v*` tag push; the skill's tag push is what
   triggers it. Avoid pushing a tag twice.)
3. **Reconcile: REBASE `mutual-aardvark` onto `origin/main`** (not merge).
4. **Tests: a live Postgres IS available.** Run the full SDK suite green locally
   before relying on CI. uvx/chroma also required for the 5 Chroma-backed tests.

## Current state (verified in Phase 0)

- **Branch:** 30 ahead, **11 behind** `origin/main`. No PR exists yet.
- **Uncommitted audit cleanup** (must be committed before rebase):
  - `package.json` — runtime deps trimmed 22→5 (`pg`, `zod`, `@modelcontextprotocol/sdk`,
    `better-auth`, `@better-auth/api-key`); rest moved to devDependencies; `//dependencies-note` added.
  - `src/sdk/index.ts` — stale "Phase N stub" comments rewritten (doc-only).
  - 8 modified `tests/sdk/*.test.ts` — migrated to the new isolation helper.
  - `tests/sdk/pg-isolation.ts` — **untracked** new helper (libpq `search_path` in pool URL).
- **Rebase conflicts expected** (~7 files): driven by the `server-beta→server` rename
  vs. ongoing main work. Split into two kinds:
  - **Source conflicts** (hand-resolve): `package.json`,
    `src/server/runtime/create-server-service.ts`.
  - **Build-artifact conflicts** (do NOT hand-merge — regenerate via build):
    `plugin/scripts/context-generator.cjs`, `plugin/scripts/mcp-server.cjs`,
    `plugin/scripts/server-service.cjs`, `plugin/scripts/worker-service.cjs`,
    `plugin/ui/viewer-bundle.js`.
- **CI** (`.github/workflows/`): `ci.yml` runs on PR + push-to-main (typecheck, build w/
  bundle-size guardrails, Bun tests, server-runtime e2e in Docker+Postgres+Valkey).
  `npm-publish.yml` publishes on `v*` tag push. `windows.yml` build-only on PR.

---

## Phase 0: Documentation Discovery — COMPLETE

Consolidated findings (sources: `package.json`, `tsup.config.ts`,
`scripts/check-sdk-bundle.cjs`, `scripts/generate-changelog.js`, `.github/workflows/*`,
the version-bump SKILL.md, `git`/`gh` state).

### Allowed APIs / commands (cited)

| Need | Command / location | Source |
|---|---|---|
| Build (full, incl. SDK + guard) | `npm run build` = sync-manifests → build-hooks → build:sdk → check:sdk-bundle | `package.json:65` |
| Build + test + local marketplace sync | `npm run build-and-sync` | `package.json:68` |
| Typecheck | `npm run typecheck` (`tsc --noEmit` ×2) | `package.json:103` |
| SDK bundle import guard | `node scripts/check-sdk-bundle.cjs` (forbidden: express, bullmq, ioredis, better-auth, react, bun:sqlite, @anthropic-ai/claude-agent-sdk) | `scripts/check-sdk-bundle.cjs:22-30` |
| Changelog (auto) | `npm run changelog:generate` (reads `gh release` data) | `package.json:75`, `scripts/generate-changelog.js` |
| Version bump skill | `/claude-mem:version-bump` | skill SKILL.md |

### Version manifests that bump in lockstep (7) — current `13.4.0`

`package.json:3` · `plugin/package.json:3` · `.claude-plugin/marketplace.json:13` ·
`.claude-plugin/plugin.json:3` · `plugin/.claude-plugin/plugin.json:3` ·
`.codex-plugin/plugin.json:3` · `openclaw/openclaw.plugin.json:6`
(The version-bump skill edits all 7. Verify with `git grep -n '"version": "13.5.0"'` = 7 hits, `'"version": "13.4.0"'` = 0.)

### Build output contract (verified present)

`tsup.config.ts` entry `['src/index.ts','src/sdk/index.ts']`, `dts:true`, `outDir:dist`,
`clean:false`, external `['pg','@anthropic-ai/sdk',/^node:/]`. Emits
`dist/sdk/index.js` + `dist/sdk/index.d.ts`. `exports["./sdk"]` →
`./dist/sdk/index.js` (+ types). `files[]` ships `dist`.

### Test preconditions

`export CLAUDE_MEM_TEST_POSTGRES_URL=postgres://…` (fallback
`CLAUDE_MEM_SERVER_DATABASE_URL`). `uvx` on PATH for the 5 Chroma tests
(capture/generate/search/close + create-cmem-client uses PG only). Helper:
`tests/sdk/pg-isolation.ts` pins `search_path` via libpq `options` in the pool URL.

### Anti-patterns to avoid (do NOT)

- Do NOT `npm publish` manually or `git tag`/`git push` a tag by hand — the
  version-bump skill owns that (decision #2).
- Do NOT hand-merge the 5 build-artifact conflicts — regenerate with `npm run build`.
- Do NOT promote any dep back into `dependencies` without re-running
  `check-sdk-bundle` + the dep scan (see `//dependencies-note` in package.json).
- Do NOT run the version bump on the `mutual-aardvark` branch — run `/version-bump`
  **on main after the merge** (decision #2).

---

## Phase 1: Commit the audit cleanup on `mutual-aardvark`

**What to implement:** turn the uncommitted audit work into one clean commit so the
rebase has a stable base. No code logic changes — this is the May 29 audit output.

Tasks:
1. Confirm the working tree matches the expected audit cleanup (the 9 modified files +
   untracked `tests/sdk/pg-isolation.ts` listed in "Current state"). If anything
   unexpected appears, stop and report.
2. Run the local verification gate (Postgres available, decision #4):
   ```bash
   export CLAUDE_MEM_TEST_POSTGRES_URL="postgres://…/cmem_test"   # your test DB
   which uvx                                                       # must resolve
   npm run typecheck
   npm run build            # includes check:sdk-bundle — must print "dist/sdk/index.js is clean"
   npm test -- tests/sdk    # or the repo's test runner scoped to tests/sdk
   ```
3. Stage and commit (include the untracked helper):
   ```bash
   git add package.json src/sdk/index.ts tests/sdk/
   git commit -m "chore(sdk): finalize cmem-sdk audit cleanup — dep reclassification, pg-isolation test harness, stale-comment removal"
   ```

**Verification checklist:**
- [ ] `git status` clean (no modified, no untracked under `tests/sdk/`).
- [ ] `npm run typecheck` exits 0.
- [ ] `npm run build` prints `check-sdk-bundle: dist/sdk/index.js is clean`.
- [ ] Full `tests/sdk` suite green (0 skips for the DB/Chroma tests, since PG + uvx present).
- [ ] `git grep -n "Phase 5 stub\|Phase 6 stub\|not implemented yet" src/sdk/index.ts` → 0 hits.

**Anti-pattern guards:** don't reorder/squash the existing 30 commits here; this is a
single additive commit. Don't `git add -A` blindly — only the audit files.

---

## Phase 2: Rebase `mutual-aardvark` onto `origin/main`

**What to implement:** replay this branch's commits on top of the 11 new main commits
(decision #3), resolving the rename conflicts.

Tasks:
1. `git fetch origin && git rebase origin/main`
2. For each conflict, resolve by class:
   - **Source — hand-resolve, keep the rename:**
     - `package.json` — keep the audit dep split (5 runtime deps + `//dependencies-note`)
       AND any new deps/scripts main added. Re-verify the `exports["./sdk"]` and `files`
       entries survive.
     - `src/server/runtime/create-server-service.ts` — keep `server` naming (the rename);
       fold in any main-side logic changes.
   - **Build artifacts — DO NOT edit by hand, take either side then regenerate:**
     `plugin/scripts/{context-generator,mcp-server,server-service,worker-service}.cjs`,
     `plugin/ui/viewer-bundle.js`. Resolve with `git checkout --theirs` (or ours) just to
     unblock, then `npm run build` / `npm run build-and-sync` regenerates them correctly.
3. After the rebase completes: `npm run build` (regenerates all bundles from reconciled
   source) and re-run the Phase 1 verification gate.
4. Re-run `git grep -in 'serverbeta\|server-beta'` across **code identifiers** — expect
   only intentional back-compat references (settings-key aliases, legacy job-name
   handling per audit obs 2534), not new ones reintroduced by main.

**Verification checklist:**
- [ ] Rebase finishes with no remaining conflict markers (`git grep -n '<<<<<<<'` = 0).
- [ ] `npm run typecheck` + `npm run build` + `tests/sdk` all green post-rebase.
- [ ] `dist/sdk/index.js` import guard still clean.
- [ ] `git log --oneline origin/main..HEAD` shows the branch commits replayed cleanly atop main.
- [ ] No accidental re-introduction of `server-beta` naming beyond the documented back-compat surface.

**Anti-pattern guards:** never resolve a `.cjs`/`viewer-bundle.js` conflict by manually
editing minified output — always regenerate. Don't drop main's 11 commits' changes while
resolving (read each hunk; keep both sides' intent).

---

## Phase 3: Open PR and drive CI green

**What to implement:** force-push the rebased branch, open the PR, get all checks green.

Tasks:
1. `git push --force-with-lease origin mutual-aardvark`
2. Open the PR against `main`:
   ```bash
   gh pr create --base main --head mutual-aardvark \
     --title "feat(sdk): ship cmem-sdk (claude-mem/sdk export) + server runtime rename" \
     --body "<summary of the 9-phase build + audit verdict SHIP + dep reclassification>"
   ```
   Body should reference `plans/2026-05-25-cmem-sdk-and-server-rename.md` and the audit
   (62/62 SDK tests, 2094 full-suite, import guard clean).
3. Watch CI: `gh pr checks --watch`. The gates are typecheck, build (bundle-size
   guardrails), Bun tests, and the Docker+Postgres+Valkey server-runtime e2e (`ci.yml`),
   plus Windows build (`windows.yml`).
4. If a check fails, fix on the branch and push; re-run the local gate first.
   (Optional: the `/claude-mem:babysit` skill can monitor the PR until green.)

**Verification checklist:**
- [ ] PR exists and targets `main`.
- [ ] `gh pr checks` all green (ci.yml + windows.yml).
- [ ] No bundle-size guardrail regression flagged.
- [ ] PR description links the plan + audit.

**Anti-pattern guards:** don't merge with a red or pending required check. Don't disable
the e2e gate to "save time."

---

## Phase 4: Merge to main

**What to implement:** land the branch on main so the release can be cut from there.

Tasks:
1. Merge the PR (squash vs merge-commit per repo norm — recent history shows merge
   commits for PRs, e.g. `84636894`; default to the repo's standard merge button).
2. Locally sync main:
   ```bash
   git checkout main && git pull origin main
   ```
3. Sanity re-verify on main: `npm run build && npm run typecheck` (fast confidence check
   that the merged main builds before bumping).

**Verification checklist:**
- [ ] PR shows merged; branch commits present in `git log origin/main`.
- [ ] `dist/sdk/index.js` + `dist/sdk/index.d.ts` build on main; guard clean.
- [ ] `git status` on main clean.

**Anti-pattern guards:** do not start the version bump until main contains the merge.

---

## Phase 5: Cut release 13.5.0 via `/version-bump` (on main)

**What to implement:** invoke the version-bump skill to drive the full release. This is
decision #2 — the skill owns manifests, build, commit, tag, push, publish, changelog,
GitHub release.

Tasks:
1. On `main`, run the skill: `/claude-mem:version-bump` and select **minor → 13.5.0**.
2. The skill performs (confirm each as it goes):
   - Edit all **7** version manifests to `13.5.0`.
   - `npm run build-and-sync` (build + bundle guard + local marketplace sync).
   - Commit `chore: bump version to 13.5.0`.
   - Tag `v13.5.0` and `git push origin main && git push origin v13.5.0`.
   - Tag push triggers `npm-publish.yml` → npm publish (let CI publish; do not also
     `npm publish` locally).
   - `gh release create v13.5.0` + `npm run changelog:generate` + commit/push CHANGELOG.
3. Provide release notes highlighting the **new `claude-mem/sdk` export** (in-process
   capture→compress→semantic-search, no worker) and the server-beta→server rename
   (back-compat preserved).

**Verification checklist:**
- [ ] `git grep -n '"version": "13.5.0"'` → 7 hits; `'"version": "13.4.0"'` → 0.
- [ ] `npm-publish.yml` run for tag `v13.5.0` succeeded.
- [ ] `npm view claude-mem@13.5.0 version` → `13.5.0`.
- [ ] GitHub release `v13.5.0` exists; `CHANGELOG.md` updated and pushed.
- [ ] Working tree on main clean.

**Anti-pattern guards:** do NOT manually `npm publish` (avoid double-publish with
`npm-publish.yml`). Do NOT bump only `package.json` — all 7 manifests or the marketplace/
plugin installs drift. Do not run the skill on `mutual-aardvark`.

---

## Phase 6: Final verification — prove it shipped

**What to implement:** confirm a real consumer can install and use `claude-mem/sdk`, and
that docs are live.

Tasks:
1. **Scratch consumer install** (prod-only, mirrors a real SDK consumer):
   ```bash
   mkdir /tmp/cmem-sdk-smoke && cd /tmp/cmem-sdk-smoke && npm init -y
   npm install claude-mem@13.5.0
   node -e "import('claude-mem/sdk').then(m => console.log('exports:', Object.keys(m)))"
   ```
   Expect `createCmemClient` (+ exported types) present; no install of express/bullmq/
   ioredis/react in the tree (`npm ls bullmq` → absent).
2. **Run the plain-Node example** `examples/sdk-node/` against the test Postgres + uvx
   (per its README) — confirm it prints generated observations + search hits with **no
   worker process** running (this is the headline requirement from the original plan,
   Phase 9 gate #5).
3. **Docs:** confirm `docs/public/sdk.mdx` is in the published nav (`docs.json`) and the
   Mintlify site auto-deployed from the main push (https://docs.claude-mem.ai/sdk).
4. Clean up the scratch dir.

**Verification checklist:**
- [ ] `import('claude-mem/sdk')` resolves from a fresh prod-only install of `@13.5.0`.
- [ ] Heavy deps absent from the consumer tree (dep reclassification holds in the wild).
- [ ] `examples/sdk-node` runs end-to-end (capture→compress→search) with no worker.
- [ ] SDK docs page live at docs.claude-mem.ai.
- [ ] `npm view claude-mem dist-tags.latest` = `13.5.0`.

**Anti-pattern guards:** don't declare "shipped" off a local build — verify against the
**published** `@13.5.0` from the registry. Don't skip the no-worker example; it's the
defining claim of the SDK.

---

## One-glance ship sequence

1. **Phase 1** — commit audit cleanup on branch; local gate green (PG + uvx).
2. **Phase 2** — rebase onto origin/main; hand-resolve source, regenerate artifacts; re-verify.
3. **Phase 3** — force-push, open PR, CI green (Docker e2e + Windows).
4. **Phase 4** — merge to main; sync local main.
5. **Phase 5** — `/version-bump` minor → 13.5.0 (7 manifests, tag → CI publish, changelog, GH release).
6. **Phase 6** — prod-only scratch install of `@13.5.0`, run no-worker example, confirm docs live.
