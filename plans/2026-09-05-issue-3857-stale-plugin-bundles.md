# Issue #3857 — v13.24.0 ships the 13.23.1 bundle (stale committed artifacts)

**Created:** 2026-09-05
**Issue:** https://github.com/thedotmack/claude-mem/issues/3857
**Key comment:** https://github.com/thedotmack/claude-mem/issues/3857#issuecomment-5529605799
**Severity:** P0 — every marketplace user on 13.24.0 is in a kill/respawn loop; observations are not being written.
**Repo:** `/workspace/claude-mem` (thedotmack/claude-mem), `main` @ `be44b6c8`

**Execution model:** Phase 1 is the must-ship hotfix and lands alone. Phases 2–4 are hardening and land after, in order, one commit/PR per phase. Every phase re-verifies against a *pristine* tree (see Phase 0.5 — the working tree lies).

---

## Phase 0: Consolidated Discovery — Ground Truth

*Discovery performed 2026-09-05 by direct inspection plus two fact-extraction subagents. Executors: trust these refs but re-read the cited lines before editing — line numbers drift.*

### 0.1 What is actually wrong

`plugin/scripts/*.cjs` are **committed build artifacts** (`git ls-files plugin/scripts/` lists all five `.cjs`; `.gitignore` ignores only the compiled binary `plugin/scripts/claude-mem`). The Claude Code marketplace installs from the repo — `.claude-plugin/marketplace.json:13` has `"source": "./plugin"` — so whatever is committed is what marketplace users execute.

The release commit that bumped to 13.24.0 never rebuilt them:

```
$ git show --stat 85ccd626    # "chore: bump version to 13.24.0", Cursor Agent, 2026-09-03
12 files changed — manifests + CHANGELOG only. Zero plugin/scripts/ files.

$ git log --oneline -3 -- plugin/scripts/worker-service.cjs
89ca057a chore: bump version to 13.23.1   <-- last actual rebuild
263d8c00 chore: bump version to 13.23.0
```

Its commit message says it plainly: *"Catch GitHub up to the already-published npm 13.24.0."* npm was published first (from a machine where `prepublishOnly` → `npm run build` ran, `package.json:109`), then git was retro-bumped by hand. Every prior bump commit back through 13.15.x *did* carry the rebuilt bundles; 13.24.0 is the first that did not.

### 0.2 The runtime failure loop — exact code path

| Step | Location | Behavior |
|---|---|---|
| Hook entry | `src/shared/worker-utils.ts:454` `ensureWorkerRunning()` | called once per hook event, via `ensureWorkerAliveOnce()` (`:626-632`) from `executeWithWorkerFallback` (`:848`) |
| Resolve script + expected version | `worker-utils.ts:462` `resolveWorkerScript()` → `:303-323` | highest-version candidate wins (`selectWorkerScript` `:325-336`) |
| Compare | `worker-utils.ts:476` → `checkVersionMatch()` `src/services/infrastructure/HealthMonitor.ts:173-182` | `pluginVersion` = resolved candidate's version (13.24.0); `workerVersion` = `/api/health` (`Server.ts:217,228` ← `BUILT_IN_VERSION` `:62-65`, the baked constant, 13.23.1) |
| Mismatch → SIGKILL | `worker-utils.ts:492-536` | logs `"Worker version mismatch — killing stale worker"`, then `killProcessTree(pid, {signalMode:'immediate'})` at `:528`, then `waitForWorkerPortClosed()` at `:536` (5s budget, `:407`) |
| Respawn | `worker-utils.ts:571` | lazy-spawns *the same stale file* → reports 13.23.1 again |
| Post-readiness warn | `worker-utils.ts:426-434` `warnIfVersionStillMismatched()`, called at `:486-488` **and** `:618-622` | **warn only** — logs `"…not recycling again in this hook invocation (one recycle per hook event)"` and returns |

**Where "expected version" actually comes from** — this is not `plugin/.claude-plugin/plugin.json`. Nothing in the recycle path reads `plugin.json`. `resolveWorkerScript()` ranks three candidate sources (`:303-323`):

1. **the cache directory's own name** — `cacheWorkerScriptCandidates()` `:249-276`, `version: path.basename(versionDir)`, i.e. `~/.claude/plugins/cache/thedotmack/claude-mem/<version>/`. This is the one that fires for the reporter, and it is why their `/api/health` showed `workerPath=.../claude-mem/13.24.0/scripts/worker-service.cjs` with `version=13.23.1` — the directory says 13.24.0, the bytes inside say 13.23.1.
2. marketplace `package.json` — `:314`, `MARKETPLACE_ROOT` = `~/.claude/plugins/marketplaces/thedotmack` (`src/shared/paths.ts:45`)
3. cwd `package.json` — `:318`

The build keeps all of these in lockstep with the baked constant, so the distinction does not change the failure loop — but it does determine where a Phase 4 guard must key itself.

**Why the guard cannot break the loop.** The "at most once" property is the *control flow itself* — `ensureWorkerRunning()` has no loop back to `checkVersionMatch`, and `aliveCache` (`:626`, a module global) memoizes one call per process. `warnIfVersionStillMismatched` only logs. The only state involved is the function-local `expectedPluginVersion` (`:468`). **There is no `recycledThisEvent` flag, no env var, and no on-disk guard** — nothing survives the hook process. So the next hook event re-enters at `:476` with identical inputs and kills again. The reporter measured 38 cycles in ~10 minutes; each pays a full teardown, up to a 5s port-close wait (`:407`), a cold spawn, and a readiness wait. Every SIGKILL is uncatchable and takes the in-flight observer generator with it (`Claude Code process terminated by signal SIGKILL`), which is why nothing gets stored.

Same constant also gates restart verification: `src/services/restart-verify.ts:97-101` polls `/api/health` until `version === expectedVersion` (the caller's own baked constant, explicitly "never package.json read from disk"), so CLI restarts also report failure while the mismatch stands.

### 0.3 How the version gets baked in

esbuild `define`, not a generated constants file. There is **no `src/version.ts`**; `grep -rn "13\.24\.0\|13\.23\.1" src/ --include=*.ts` returns zero hits.

```js
scripts/build-hooks.js:242-243
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
  const version = packageJson.version;

scripts/build-hooks.js:247
  const hooksDir = 'plugin/scripts';

// per bundle:
  define: { '__DEFAULT_PACKAGE_VERSION__': `"${version}"`, … }
  // lines 350 (worker), 418 (sqlite), 443 (server-service),
  //       498 (mcp-server), 546 (context-generator), 572 (transcript-watcher), 615 (npx-cli)
```

Consumers declare it bare with a dev fallback, e.g. `src/services/worker-service.ts:36-37`, `src/servers/mcp-server.ts:2-3`, `src/services/server/Server.ts:62-64` (`BUILT_IN_VERSION`), `src/services/telemetry/common.ts:10-12`, `src/server/routes/v1/ServerV1Routes.ts:20-22`.

Entry → output map (`scripts/build-hooks.js:10-33` sources; `:327, 435, 467, 541, 563` outfiles):

| Bundle | Source | Output |
|---|---|---|
| worker-service | `src/services/worker-service.ts` | `plugin/scripts/worker-service.cjs` |
| server-service | `src/server/runtime/ServerService.ts` | `plugin/scripts/server-service.cjs` |
| mcp-server | `src/servers/mcp-server.ts` | `plugin/scripts/mcp-server.cjs` |
| context-generator | `src/services/context-generator.ts` | `plugin/scripts/context-generator.cjs` |
| transcript-watcher | `src/services/transcripts/transcript-watcher-entry.ts` | `plugin/scripts/transcript-watcher.cjs` |

`context-generator.cjs` embeds **no** version string (nothing in its import graph references the define). Its absence from the diff is expected, not a partial build.

### 0.4 Build commands (verified from `package.json:57-114` — do not invent)

```
package.json:59   "build": "node scripts/sync-plugin-manifests.js && node scripts/build-hooks.js && node scripts/gen-plugin-lockfile.cjs"
package.json:60   "build-and-sync": "npm run build && npm run sync-marketplace && node scripts/restart-marketplace-worker.cjs"
package.json:61   "sync-marketplace": "node scripts/sync-marketplace.cjs"   # copies only, never builds
package.json:109  "prepublishOnly": "npm run build && node scripts/check-postinstall-allowlist.js"
```

- `node scripts/build-hooks.js` alone regenerates all five `.cjs`. It is the network-free path.
- `npm run build` is the correct superset — it also re-stamps the six manifests (`scripts/sync-plugin-manifests.js:113-117`) and `plugin/bun.lock` (`scripts/gen-plugin-lockfile.cjs:57-60`).
- **Prereqs:** `node_modules` installed (esbuild is a devDependency, `package.json:156`). No root lockfile is committed, so use `npm install --no-audit --no-fund` exactly as CI does. bun is needed only by `gen-plugin-lockfile.cjs`; uv is not needed for any build step.
- `build-hooks.js` hard-fails on: viewer build non-zero exit (`:308-318`), missing distribution files (`:711-715`), the Rule-A shell-template canonical check (`:743`), a `bun:*` require in `mcp-server.cjs` (`:514-518`), an external `zod` require (`:521-525`), and the worker bundle-size guardrail (`WORKER_SERVICE_MAX_BYTES`, #2584). A failure in any of these is a real signal, not noise.

### 0.5 ⚠ The working tree lies — read this before doing anything

`git status` on `main` shows four modified `.cjs`. **They are not a rebuild. Do not commit them.**

This is the single most likely way to get this fix wrong: *both* independent discovery passes run for this plan looked at that diff and concluded "the four modified files are already the fix, just commit them." Both were wrong. Proven three ways:

1. `node_modules` is absent from the checkout, so no esbuild build can have run.
2. Each worktree file is byte-identical to `HEAD` once the version string is normalized:
   ```sh
   for f in worker-service mcp-server server-service transcript-watcher; do
     git show HEAD:plugin/scripts/$f.cjs > /tmp/$f.head.cjs
     sed 's/13\.24\.0/13.23.1/g' plugin/scripts/$f.cjs > /tmp/$f.norm.cjs
     cmp -s /tmp/$f.head.cjs /tmp/$f.norm.cjs && echo "$f: version-string patch only"
   done
   # all four: version-string patch only
   ```
3. `plugin/scripts/worker-service.cjs` is 3,146,818 bytes — identical to `HEAD`, and 10,431 bytes smaller than the npm 13.24.0 tarball's copy (3,157,249, per the issue comment).

**This matters because `src/` really changed between v13.23.1 and HEAD** — 12 files, 704 insertions:

```
$ git diff --stat v13.23.1..HEAD -- src/
 src/npx-cli/cmem-memory-credentials.ts            | 213 +++
 src/npx-cli/commands/{ide-detection,install,runtime}.ts, index.ts, installer-provider-choice.ts
 src/sdk/prompts.ts                                |   2 +-   <-- observer <skip_summary> protocol change
 src/services/integrations/GrokBotInstaller.ts     | 276 +++
 src/services/sqlite/SessionStore.ts               |   7 +-
 src/services/sqlite/manual-session.ts             |  39 +
 src/services/worker/http/routes/MemoryRoutes.ts   |   7 +-
 src/services/worker/http/routes/SettingsRoutes.ts |   1 +
 12 files changed, 704 insertions(+), 28 deletions(-)
```

`src/sdk/prompts.ts` changed the observer's skip protocol from an empty response to `<skip_summary reason="noise" />`; `SessionStore.ts`, `manual-session.ts`, `MemoryRoutes.ts`, `SettingsRoutes.ts` are all inside the worker bundle. So the committed bundles are stale **in code**, not merely in a constant.

**Consequence:** the `sed` workaround in the issue body stops the kill loop but leaves users running 13.23.1 code that *claims* to be 13.24.0 — strictly worse than the honest mismatch, because it silences the only signal. Committing the four modified worktree files would ship that lie to every marketplace user. Phase 1 must be a real build.

### 0.6 Test state

`tests/infrastructure/version-consistency.test.ts` (130 lines) asserts:

| Lines | Assertion |
|---|---|
| 12-21 | root `package.json` version exists and is semver; captured as `rootVersion` |
| 23-29 | `plugin/package.json` matches |
| 31-37 | `plugin/.claude-plugin/plugin.json` matches |
| 39-51 | `.claude-plugin/marketplace.json` claude-mem entry matches |
| 53-65 | `claude-mem-cursor` and `claude-mem-grok-bot` `.cursor-plugin/plugin.json` match |
| 67-76 | `.cursor-plugin/marketplace.json` lists both cursor plugins |
| **77-92** | **`"${rootVersion}"` appears in `plugin/scripts/worker-service.cjs`** ← the red one |
| 94-104 | `mcp-server.cjs` exists and is non-empty (**does not check its version**) |
| 106-113 | semver format |
| 116-129 | `scripts/build-hooks.js` still contains the version-read + `__DEFAULT_PACKAGE_VERSION__` define wiring |

Two weaknesses, both confirmed by reading the file:

```ts
// tests/infrastructure/version-consistency.test.ts:80-83  — soft-pass
if (!existsSync(workerServicePath)) {
  console.log('⚠️  worker-service.cjs not found - run npm run build first');
  return;            // ← a missing artifact reads GREEN
}
// identical soft-pass at :97-100 for mcp-server.cjs
```

and it covers only `worker-service.cjs`. **It is the only test in the repo that asserts a built bundle's embedded version equals the manifest version** — `mcp-server.cjs` (1 occurrence), `server-service.cjs` (2) and `transcript-watcher.cjs` (1) have no version assertion anywhere in `tests/`, which is why their stale `13.23.1` is entirely invisible to the suite.

A third, latent weakness: `rootVersion` is a `let` in the `describe` closure (`:10`) assigned only inside the *first* `it` (`:20`). It works under Bun's sequential in-file execution, but under `.only`, a `-t` filter, or a bail on test 1 it is `undefined` and `:87` builds the regex `"undefined"`.

Related bundle tests that do **not** check versions (useful context, don't mistake them for coverage): `tests/plugin-scripts-line-endings.test.ts:9` (asserts LF on the `.cjs` — matches `.gitattributes:3`), `tests/infrastructure/plugin-distribution.test.ts` (file list + hook wiring), `tests/infrastructure/health-monitor.test.ts:268-330` (four `checkVersionMatch` unit tests), `tests/worker-script-resolution.test.ts` (resolver ranking).

**Verified reproduction (2026-09-05, this checkout):**

```
$ bun test tests/infrastructure/version-consistency.test.ts      # in the dirty working tree
  11 pass, 0 fail        ← FALSE GREEN, the sed patch masks it

$ mkdir -p /tmp/head-tree && git archive HEAD | tar -x -C /tmp/head-tree
$ cd /tmp/head-tree && bun test tests/infrastructure/version-consistency.test.ts
  ✗ Version Consistency > should have version injected into built worker-service.cjs
    expect(received).toBeTruthy()   Received: null
    at tests/infrastructure/version-consistency.test.ts:90:21
  10 pass, 1 fail
```

Always verify against a pristine extract, never the working tree.

### 0.7 Why CI never caught it

Every job that touches the bundles runs `npm run build` **before** testing, then discards the workspace:

- `.github/workflows/ci.yml:39` (build job), `:97`, `:221`
- `.github/workflows/windows.yml:39`, `:145`
- `.github/workflows/npm-publish.yml:22` → `:23` `smoke:clean-room` → `:24` `npm publish`

So CI always tests *freshly built* artifacts and is structurally blind to stale *committed* ones. `grep -rn "git diff\|--exit-code\|drift" .github/workflows/` returns exactly two hits, both the `plugin/bun.lock` frozen-lockfile check at `ci.yml:216-218` — which is the pattern to mirror:

```yaml
# .github/workflows/ci.yml:216-218  ← copy this shape
- name: Verify plugin lockfile is in sync (frozen-lockfile drift check)
  working-directory: plugin
  run: bun install --frozen-lockfile --ignore-scripts
```

This also explains the npm/git asymmetry: `prepublishOnly` rebuilds before packing, so the npm tarball is always correct; only repo/marketplace consumers get the stale bytes.

### 0.8 Allowed APIs (verified to exist — use these exact names)

| API | Location | Shape |
|---|---|---|
| `ensureWorkerRunning()` | `src/shared/worker-utils.ts:454` | `(): Promise<boolean>` |
| `resolveWorkerScript()` | `src/shared/worker-utils.ts:303-323` | `(): WorkerScriptCandidate \| null` → `{scriptPath, version}` |
| `selectWorkerScript(candidates)` | `src/shared/worker-utils.ts:325-336` | highest version wins; `null` version sorts last |
| `warnIfVersionStillMismatched(expected)` | `src/shared/worker-utils.ts:426-434` | module-private, warn-only |
| `checkVersionMatch(port, expectedVersion)` | `src/services/infrastructure/HealthMonitor.ts:173-182` | `{matches, pluginVersion, workerVersion}`; **fails open** when `workerVersion` is falsy or `pluginVersion === 'unknown'` |
| `verifyRestartedWorker(port, oldPid, expectedVersion, deadlineMs, opts?)` | `src/services/restart-verify.ts:~105` | polls `/api/health` for new pid AND matching version |
| `readOwnedWorkerPidInfo()` / `validateWorkerPidFile()` | `src/supervisor/index.js` | mocked in tests |
| `killProcessTree(pid, {signalMode})` | used at `worker-utils.ts:530` | `'immediate'` = SIGKILL, no grace |
| `writeJsonFileAtomic()` | `src/npx-cli/utils/paths.ts:124-205` | the ONLY atomic-write helper in the repo |

### 0.9 Anti-patterns (verified — do not do these)

- **Do not hand-edit or `sed` `plugin/scripts/*.cjs`.** They are esbuild output. The only legitimate way to change them is `npm run build`.
- **Do not commit the four currently-modified worktree files** (§0.5). Discard them.
- **Do not add a `src/version.ts`** or read `package.json` at worker runtime — the baked `__DEFAULT_PACKAGE_VERSION__` define is deliberate, and `restart-verify.ts:99-100` documents "never package.json read from disk".
- **Do not add a new CI grep** for the version. The test at `version-consistency.test.ts:77-92` already encodes it; wire *that* in rather than duplicating it (the issue comment makes this point explicitly).
- **Do not bump the version** as part of this fix. The manifests are already at 13.24.0; the artifacts must be made to match *that*, not moved to 13.25.0. A bump is a separate, later decision.
- There is no `prepack` script and no git hook that rebuilds on commit — do not assume one exists.
- `package-lock.json` and `bun.lock` are gitignored at the root — do not commit them. `plugin/bun.lock` *is* committed and is regenerated by `npm run build`.
- Tests are `bun test` (`bunfig.toml` preloads `tests/preload.ts`). Mock pattern for worker-utils: `mock.module()` + snapshot/restore, see `tests/shared/worker-utils-version-recycle.test.ts:1-60`.

---

## Phase 1 — HOTFIX: rebuild and commit the artifacts (must-ship, lands alone)

**Goal:** committed `plugin/scripts/*.cjs` are a genuine build of `main` at version 13.24.0, so marketplace users get code that matches its manifest.

### What to implement

1. Discard the fake diff — it is a `sed` patch, not a build (§0.5):
   ```sh
   git checkout -- plugin/scripts/
   git status --porcelain plugin/scripts/    # must be empty
   ```
2. Install build deps exactly as CI does (`ci.yml`, no committed root lockfile):
   ```sh
   npm install --no-audit --no-fund
   ```
3. Run the canonical build (`package.json:59`) — **not** `sed`, **not** `build-and-sync` (which would also restart your local worker and mirror to `~/.claude/plugins/marketplaces/`; harmless but out of scope for a repo commit):
   ```sh
   npm run build
   ```
4. Inspect the diff before staging. Expect it to be **large** — `src/` moved 704 lines since the last real build (§0.5), so this is not a 4-line version patch:
   ```sh
   git diff --stat plugin/ dist/ 2>/dev/null
   ```
5. Stage only what the build legitimately produces. `npm run build` also regenerates `plugin/package.json` and `plugin/bun.lock`; both are tracked and both belong in the commit if they changed.
   ```sh
   git add plugin/scripts plugin/sqlite plugin/package.json plugin/bun.lock plugin/ui
   git status   # review anything else the build touched before adding it
   ```
6. Commit with a message that names the root cause and the issue.

### Verification checklist

```sh
# 1. All four version-bearing bundles carry the manifest version, and none carries the old one.
V=$(node -p "require('./package.json').version")   # 13.24.0
for f in worker-service mcp-server server-service transcript-watcher; do
  echo "$f: $(grep -o "\"$V\"" plugin/scripts/$f.cjs | wc -l) hits of $V, \
$(grep -o '"13\.23\.1"' plugin/scripts/$f.cjs | wc -l) hits of 13.23.1"
done
# Expect: worker-service 4/0, mcp-server 1/0, server-service 2/0, transcript-watcher 1/0
# context-generator.cjs legitimately has 0 of either (§0.3) — do not "fix" it.

# 2. The bundle is a real build, not a constant swap: it must NOT be
#    byte-identical to HEAD~ once the version is normalized.
git show HEAD~1:plugin/scripts/worker-service.cjs > /tmp/prev.cjs
sed "s/$V/13.23.1/g" plugin/scripts/worker-service.cjs > /tmp/norm.cjs
cmp -s /tmp/prev.cjs /tmp/norm.cjs && echo "FAIL: version-string patch only" || echo "OK: genuine rebuild"

# 3. New src/ code actually reached the bundle (the observer skip protocol, §0.5).
grep -c 'skip_summary' plugin/scripts/worker-service.cjs   # expect >= 1

# 4. The test goes green against a PRISTINE extract of the commit, not the working tree.
rm -rf /tmp/verify-tree && mkdir -p /tmp/verify-tree
git archive HEAD | tar -x -C /tmp/verify-tree
(cd /tmp/verify-tree && bun test tests/infrastructure/version-consistency.test.ts)
# Expect: 11 pass, 0 fail

# 5. Line endings survived the rebuild (.gitattributes:3 pins eol=lf).
bun test tests/plugin-scripts-line-endings.test.ts

# 6. Full suite still green.
npm run typecheck
bun test tests
bun test openclaw
```

### Anti-pattern guards

- ✗ Do not `sed` the bundles. If `npm run build` fails, fix the build — a hand-patched artifact is the bug, not the fix.
- ✗ Do not run the verification in the dirty working tree; it produced a false green (§0.6).
- ✗ Do not bump the version to 13.25.0 to "force" a rebuild.
- ✗ Do not `git add -A` blindly — review what else the build touched (`dist/`, `openclaw/`, viewer output) and stage deliberately.

### Fallback if the build cannot run here

The npm tarball for 13.24.0 is a correct build (`prepublishOnly` rebuilt it, §0.7). `npm pack claude-mem@13.24.0` yields usable artifacts. Treat this as a **last resort** and say so in the PR: those bytes were built from the 13.24.0 publish tree, which may not equal `main` @ `be44b6c8`. Diff them against a local build before trusting them.

---

## Phase 2 — Make CI fail on stale committed artifacts

**Why second:** Phase 1 fixes today; this stops it recurring. Without it the next hand-made bump reproduces the outage.

### What to implement

1. In `.github/workflows/ci.yml`, in the `build` job, add a step that runs the version-consistency test **against the committed tree, before `npm run build` at line 39**. This is the check the issue comment asks for — the test already exists, so do not write a new grep:
   ```yaml
   # Runs BEFORE the build so it sees the COMMITTED artifacts. After
   # `npm run build` the workspace holds freshly built bundles and this
   # check is vacuous — which is exactly how #3857 shipped.
   - name: Verify committed plugin artifacts match the manifest version (#3857)
     run: bun test tests/infrastructure/version-consistency.test.ts
   ```
   Mirror the placement/comment style of the existing drift check at `ci.yml:216-218` (§0.7).
2. Add the complementary post-build drift check so a *code*-stale artifact (not just version-stale) is caught too — after `npm run build` at `ci.yml:39`:
   ```yaml
   - name: Verify committed bundles are up to date with src/ (#3857)
     run: git diff --exit-code -- plugin/scripts plugin/sqlite plugin/package.json
   ```
   **Verify this is viable before committing it.** esbuild output can vary across esbuild patch versions and absolute paths. Run the build twice locally and confirm `git diff --exit-code -- plugin/scripts` is clean on the second run. If it is not reproducible, ship only step 1 and open a follow-up issue for step 2 rather than landing a flaky gate.

### Verification checklist

```sh
# Prove the gate catches the real regression: revert one artifact and confirm red.
git checkout 89ca057a -- plugin/scripts/worker-service.cjs
bun test tests/infrastructure/version-consistency.test.ts   # expect 1 fail
git checkout HEAD -- plugin/scripts/worker-service.cjs
bun test tests/infrastructure/version-consistency.test.ts   # expect 11 pass

# Reproducibility probe for step 2 (run before committing it):
npm run build && git status --porcelain plugin/scripts
npm run build && git diff --exit-code -- plugin/scripts && echo "reproducible"
```

- Confirm on the PR that the new steps actually ran and passed in Actions.

### Anti-pattern guards

- ✗ Do not place the test step *after* `npm run build` — that is the exact blindness that let #3857 ship.
- ✗ Do not add a bespoke `grep -q "$(jq -r .version …)"` shell gate. The test file is the single source of this assertion.
- ✗ Do not land the `git diff --exit-code` step without proving build reproducibility first.

---

## Phase 3 — Close the test's soft-pass and widen its coverage

**Why third:** once Phase 2 wires the test into CI, its two weaknesses become CI weaknesses. The issue comment flags the soft-pass explicitly: *"it `console.log`s and returns (passing) when the artifact is missing, so a missing build reads green."*

### What to implement

All edits in `tests/infrastructure/version-consistency.test.ts`:

1. **Fail instead of soft-pass** — replace the early `return` at `:80-83`:
   ```ts
   // was:
   if (!existsSync(workerServicePath)) {
     console.log('⚠️  worker-service.cjs not found - run npm run build first');
     return;
   }
   // becomes:
   expect(existsSync(workerServicePath)).toBe(true);   // missing build must be RED (#3857)
   ```
   Apply the identical change to the `mcp-server.cjs` soft-pass at `:97-100`.
2. **Cover every version-bearing bundle.** Replace the single-file assertion with a loop over the three that embed the constant, asserting the expected occurrence count so a partial build is caught:
   ```ts
   for (const [file, minHits] of [
     ['plugin/scripts/worker-service.cjs', 4],
     ['plugin/scripts/mcp-server.cjs', 1],
     ['plugin/scripts/server-service.cjs', 2],
     ['plugin/scripts/transcript-watcher.cjs', 1],
   ] as const) { /* assert >= minHits of `"${rootVersion}"` */ }
   ```
   Deliberately exclude `plugin/scripts/context-generator.cjs` — it embeds no version by design (§0.3). Add a comment saying so, or a future executor will "fix" it.
3. **Assert the old version is gone**, which is what actually distinguishes a rebuild from a partial one:
   ```ts
   expect(content).not.toMatch(/"13\.\d+\.\d+"/ /* any version !== rootVersion */);
   ```
   Implement this as "no semver string literal other than `rootVersion` appears in the version-constant position" only if it can be made precise; a naive repo-wide semver scan will hit bundled dependency versions and produce false reds. **If it cannot be made precise, skip item 3** and note why in the PR — items 1 and 2 carry the phase.
4. **Fix the `rootVersion` ordering fragility** (§0.6): `rootVersion` is assigned only inside the first `it` (`:20`), so any filtered or `.only` run builds the regex `"undefined"` at `:87`. Read it once at module scope instead:
   ```ts
   const rootVersion: string = JSON.parse(
     readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')
   ).version;
   ```
   Keep the existing `it` at `:12-21` as the assertion that it is defined and semver-shaped.

### Verification checklist

```sh
# 1. Still green on the fixed tree.
bun test tests/infrastructure/version-consistency.test.ts        # expect all pass

# 2. Red when an artifact is missing (the soft-pass regression).
mv plugin/scripts/worker-service.cjs /tmp/ws.bak
bun test tests/infrastructure/version-consistency.test.ts        # expect FAIL, not a green console.log
mv /tmp/ws.bak plugin/scripts/worker-service.cjs

# 3. Red on a partial build (only worker rebuilt, others stale).
git checkout 89ca057a -- plugin/scripts/server-service.cjs
bun test tests/infrastructure/version-consistency.test.ts        # expect FAIL naming server-service
git checkout HEAD -- plugin/scripts/server-service.cjs

# 4. Red on the exact #3857 tree.
rm -rf /tmp/t && mkdir -p /tmp/t && git archive be44b6c8 | tar -x -C /tmp/t
cp tests/infrastructure/version-consistency.test.ts /tmp/t/tests/infrastructure/
(cd /tmp/t && bun test tests/infrastructure/version-consistency.test.ts)   # expect FAIL

bun test tests   # full suite still green
```

### Anti-pattern guards

- ✗ Do not assert a version string in `context-generator.cjs` — it has none by design and the assertion will be permanently red.
- ✗ Do not assert exact equality on occurrence counts (`=== 4`); esbuild inlining can legitimately change the count. Use `>=`.
- ✗ Do not delete the `Build Script Version Handling` describe block at `:116-129` — it guards the `__DEFAULT_PACKAGE_VERSION__` wiring itself.

---

## Phase 4 — Stop the recycle loop from being unbounded (defense in depth)

**Ship only if still wanted after Phases 1–3.** Packaging is the must-ship; this is the guard the issue's suggestion #2 and #3604 / plan-16 describe: *"recycles that cannot kill a working worker."* With Phases 1–3 landed, a version-stale bundle cannot reach `main` again — but a user with a half-updated cache dir can still hit the loop locally, and today it never self-limits.

### The precise gap

`warnIfVersionStillMismatched()` (`src/shared/worker-utils.ts:426-434`) logs and returns. The only state in play is the function-local `expectedPluginVersion` (`:468`) and the per-process `aliveCache` module global (`:626-632`) — both die with the hook process. So `ensureWorkerRunning()` re-enters the mismatch branch at `:476` on the very next event and SIGKILLs again. The reporter's log is literally the guard firing 38 times: it limits recycles *within* an event (which is what #3378 needed), never *across* events.

Two invariants to preserve:
- `checkVersionMatch` (`HealthMonitor.ts:173-182`) **fails open**: `matches: true` when `workerVersion` is falsy or `pluginVersion === 'unknown'`. A worker that cannot report a version must never be killed.
- The guard must key on the *resolved candidate's* version, which for a cache install is the **directory name** (`:249-276`), not a manifest file (§0.2).

### What to implement

1. Persist a small "recycle was already attempted and did not help" record, keyed on the evidence that proves killing again is futile: the resolved `scriptPath`, its size+mtime, the `pluginVersion`, and the `workerVersion` the freshly spawned worker reported. Write it where the PID file lives (`src/supervisor/`), using `writeJsonFileAtomic()` from `src/npx-cli/utils/paths.ts:124-205` — the only atomic-write helper in the repo. Do not invent a lockfile pattern; there is none in `src/`.
2. In `ensureWorkerRunning()` at the mismatch branch (`worker-utils.ts:490-492`), before the SIGKILL: if a record matches the *current* resolved script identity **and** the currently-observed `workerVersion`, log once at `warn` and return `true` (proceed with the hook against the running worker) instead of killing. A worker serving requests at the wrong version is strictly better than no worker plus a dead observer.
3. Invalidate the record whenever the resolved script's size/mtime changes, or `workerVersion` changes — an actual upgrade must recycle normally on the first event.
4. Keep `warnIfVersionStillMismatched` as the place that *writes* the record: it is already the exact point where "we spawned from the current path and it still reports the wrong version" is known (`:426-434`).

### Documentation references to copy from

- Recycle branch and its invariants (#3378, #3482 comments are load-bearing): `src/shared/worker-utils.ts:470-545`
- Fail-open version comparison: `src/services/infrastructure/HealthMonitor.ts:173-182`
- Atomic write: `src/npx-cli/utils/paths.ts:124-205`
- Test harness to copy verbatim — `mock.module()` for `infrastructure/index.js`, `supervisor/index.js`, `shared/spawn.js`, with snapshot/restore: `tests/shared/worker-utils-version-recycle.test.ts:1-60`. Its four existing cases are at `:142` (SIGKILL + lazy-spawn, never `POST /api/admin/restart`), `:157` (no kill when versions match), `:171` (returns false when the PID file cannot identify the owner), `:183` (ESRCH → still spawns). **None of them covers `warnIfVersionStillMismatched` or the "successor is still stale" loop** — that is the gap this phase fills.
- Resolver ranking, if the guard needs to hash script identity: `tests/worker-script-resolution.test.ts` (`compareVersionsDescending`, `cacheWorkerScriptCandidates`, `selectWorkerScript`) shows the temp-dir fixture style to copy.

### Verification checklist

- New test in `tests/shared/worker-utils-version-recycle.test.ts` (copy the existing mock scaffold):
  - mismatch + no prior record → SIGKILL happens exactly once, respawn happens (**existing behavior must not regress**)
  - mismatch + prior record for the same script identity and same `workerVersion` → **zero** `killProcessTree` calls, `ensureWorkerRunning()` returns `true`
  - prior record + `workerVersion` now different → recycles once (upgrade path still works)
  - prior record + script mtime/size changed → recycles once
  - `workerVersion === null` → no kill (fail-open preserved)
- ```sh
  bun test tests/shared/worker-utils-version-recycle.test.ts
  bun test tests/integration/worker-recycle-orphans.test.ts --timeout 600000   # the #3482 gate, ci.yml:161
  bun test tests && npm run typecheck
  ```
- Manual: with a deliberately mismatched bundle, run two consecutive hook events and confirm exactly one `"killing stale worker"` line, then a single `warn` and no further kills.

### Anti-pattern guards

- ✗ Do not weaken the #3378 invariant: never let the stale worker spawn its own replacement (no `POST /api/admin/restart` on this path). See the comment block at `worker-utils.ts:496-505`.
- ✗ Do not weaken the #3482 invariant: the kill stays `killProcessTree(..., {signalMode:'immediate'})`. See `worker-utils.ts:515-529`.
- ✗ Do not make `checkVersionMatch` fail *closed*.
- ✗ Do not gate the guard on a time window (`don't recycle again for N minutes`) — it must be keyed on script identity, or a genuine upgrade is delayed for no reason.
- ✗ Do not suppress the warning. The mismatch is still a bug; the guard only stops it from also destroying observers.

---

## Phase 5 — Final verification and release-process fix

### Verification

```sh
# Pristine-tree verification of everything (never the working tree, §0.6).
rm -rf /tmp/final && mkdir -p /tmp/final
git archive HEAD | tar -x -C /tmp/final
cd /tmp/final
npm install --no-audit --no-fund
npm run typecheck
bun test tests
bun test openclaw
bun test tests/infrastructure/version-consistency.test.ts     # 11+ pass, 0 fail

# Artifact-truth check.
V=$(node -p "require('./package.json').version")
grep -c "\"$V\"" plugin/scripts/worker-service.cjs   # >= 4
! grep -q '"13\.23\.1"' plugin/scripts/*.cjs && echo "no stale constants"

# Anti-pattern sweep.
grep -rn "sed .*13\.2" scripts/ .github/ || echo "no sed-patching of artifacts"
grep -rn "src/version" src/ || echo "no invented version module"
```

### Release-process fix (small, high leverage)

The root cause was a **manifest-only catch-up bump** (`85ccd626`) that skipped step 3 of the release skill. `plugin/skills/version-bump/SKILL.md:32` already mandates `npm run build-and-sync`, and `:10` already says *"Commit EVERYTHING (including build artifacts)"* — the instruction exists and was bypassed by a bump done from a Cursor agent branch that only edited manifests.

Add one explicit gate to the skill's pre-handoff checklist (`SKILL.md:83` area):

```
- [ ] `git show --stat HEAD` on the bump commit includes plugin/scripts/*.cjs.
      A bump commit with only manifests + CHANGELOG is the #3857 failure —
      it ships the previous release's code under the new version number.
```

Phase 2's CI gate is the enforcement; this is the human-readable reason.

### Success criteria

- [ ] `plugin/scripts/*.cjs` on `main` are a genuine build at the manifest version (Phase 1 checks 1–3 pass)
- [ ] `bun test tests/infrastructure/version-consistency.test.ts` green on a pristine extract of `main`
- [ ] CI fails if a future bump commit omits the rebuild (Phase 2, proven by the revert probe)
- [ ] The test is red — not green — when an artifact is missing (Phase 3)
- [ ] If Phase 4 shipped: a version mismatch produces at most one kill per script identity, never one per hook event
- [ ] Issue #3857 closed with the commit that rebuilt the artifacts, noting that the `sed` workaround in the issue body should be *undone* by reinstalling, since it masked stale code (§0.5)

---

## Open questions for the maintainer

1. **Does 13.24.0 need a re-release?** The npm tarball is correct, but marketplace users pulled the broken repo copy. Rebuilding on `main` fixes new installs; anyone already on 13.24.0 may need a cache-dir refresh. A 13.24.1 with the correct artifacts would force the update cleanly — but this plan deliberately does not bump (§0.9), so this is your call.
2. **Should `plugin/scripts/*.cjs` stay committed at all?** They are 5.7MB of generated output in git, and this class of bug is inherent to committing build products. A release-asset or build-on-install model would eliminate it, at the cost of requiring a build step at plugin install time. Out of scope here; worth its own plan.
3. **Phase 2 step 2 (`git diff --exit-code`) depends on esbuild build reproducibility**, which is untested. The npm 13.24.0 worker bundle is 3,157,249 bytes vs this checkout's 3,146,818 — some of that is the 704 lines of new `src/`, but dependency-version drift may also contribute. If builds are not byte-reproducible across machines, ship only Phase 2 step 1.
4. **Unverified second failure mode.** `src/shared/worker-utils.ts:227-229` states that `src/build/hook-shell-template.ts` embeds a *duplicate copy* of the candidate-ranking logic. If those two implementations have diverged, a hook could resolve a different script than `ensureWorkerRunning()` does — an independent source of version disagreement that this plan does not cover. Worth an explicit read during Phase 4; if they have diverged, it deserves its own issue.
