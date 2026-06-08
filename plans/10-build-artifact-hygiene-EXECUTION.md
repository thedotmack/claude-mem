# plan-10 EXECUTION — Wave 0: Runtime Dependency Closure + Clean-Room CI Smoke

> **Master:** #2783 · **Anchor child:** #2730 (`Cannot find module 'zod/v3'`) · **Design doc:** `plans/10-build-artifact-hygiene.md`
> **Format:** make-plan phased plan, executable with `/do`. Each phase has What-to-implement / Doc references / Verification / Anti-pattern guards.
> **Scope of THIS plan:** the runtime-dependency-completeness slice of plan-10 (the thing that blocks every other Wave). The broader plan-10 children (#2584 better-auth bloat, #2570 bundle-size canary, #2538 typecheck-red, #2537 CLAUDE.md tarball leak) are **separate slices** — see "Deferred plan-10 scope" at the end.

---

## Phase 0 — Documentation Discovery (facts, decisions, allowed APIs)

This phase is **already complete** (4 discovery subagents, read-only). Consolidated below. A `/do` Implementation subagent must READ these files before touching anything; do not re-derive.

### Ground truth (file:line)

**Dependency declaration**
- Root `package.json:125-147` — 21 runtime deps incl. `zod@^4.4.3` (line 145).
- `plugin/package.json` — the **runtime manifest** the worker/Stop-hook install resolves; **27 deps** incl. `zod@^4.3.6`. **It is generated** by `scripts/build-hooks.js:202-249` (zod at line 209). **Never hand-edit `plugin/package.json`** — edit the generator.
- Version skew: root `^4.4.3` vs plugin `^4.3.6` (`build-hooks.js:209`).

**Why zod is required at runtime (not bundled)**
- `scripts/build-hooks.js:274-292` worker `external` array includes `'zod'` (line 277). Also external in server-beta (`:343`) and context-generator (`:448`). esbuild `external: ['zod']` matches all subpaths.
- The `require("zod/v3")` / `zod/v4` / `zod/v4-mini` literals are **transitive** (from bundled `@modelcontextprotocol/sdk` / `@anthropic-ai/claude-agent-sdk`); no first-party source imports `zod/v3`. They appear in the built bundle `plugin/scripts/worker-service.cjs` (~line 950, minified).
- The MCP bundle (`build-hooks.js:421-428`) intentionally **bundles** zod and has a guard failing the build if `require('zod...')` leaks — because Claude Desktop launches it with no plugin `node_modules`. **Do not break that guard.**

**How node_modules is materialized**
- Install: `src/npx-cli/install/setup-runtime.ts:370` → `bun install --ignore-scripts` in the cache dir (`~/.claude/plugins/cache/thedotmack/claude-mem/<version>/plugin`, `paths.ts:47-49`). **No lockfile, no `--frozen-lockfile`** → unpinned, resolution-time-dependent.
- Marketplace fallback: `install.ts:598` → `npm install --omit=dev --ignore-scripts` (`npm-install-helper.ts:53-69`).
- Post-install guard `verifyCriticalModules` (`setup-runtime.ts:221-236`): checks only `existsSync(node_modules/<dep>)` (lines 227-228). **Does not** assert subpath resolution or version.

**Why it RECURS on auto-update**
- claude-mem has no self-updater. Claude Code refreshes plugin files; the Setup hook `plugin/scripts/version-check.js:60-66` only **prints a hint** (`run: npx claude-mem@latest install`). No `bun install` runs against the new manifest → stale/missing `node_modules/zod` persists until a manual reinstall.

**Publish surface**
- Root `package.json:43-58` `files` allowlist ships `plugin/package.json` but **no `node_modules`, no lockfile**.
- `.npmignore` **excludes** `plugin/node_modules/` and **`plugin/bun.lock`**.
- `prepublishOnly` (`package.json:113`): `npm run build && node scripts/check-postinstall-allowlist.js` — existing precedent for a CI-time dependency guard.

**CI / test harness**
- `.github/workflows/ci.yml` — PR gate, job `build` (lines 9-47): checkout → setup-node 20 → setup-bun → `npm install --no-audit --no-fund` (line 30) → `npm run typecheck` → `npm run build` → `bun test`. Comment at `ci.yml:25-28` documents that the lockfile is gitignored so `npm ci`/cache can't be used. Second job `server-runtime-e2e-docker` (49-78) does **not** gate `build`.
- `.github/workflows/npm-publish.yml` — tag-triggered (`v*`, lines 3-6). Single `publish` job (8-21): `npm install --ignore-scripts` (17) → `npm run build` (18) → `npm publish` (19), `NODE_AUTH_TOKEN` (20-21). **No `needs:`.**
- Test runner: **`bun test`** (`package.json:104`); config `bunfig.toml` (`[test] smol=true`). Convention example: `tests/json-utils.test.ts` (imports from `bun:test`, temp-dir setup/teardown). No `npm pack` / clean-room test exists anywhere.

### Decision gate — ✅ RESOLVED 2026-06-04: **Approach A (ship `plugin/bun.lock`)** confirmed by maintainer.

`/do` should implement **Approach A** below and must NOT re-prompt. Approach B is retained only as documentation of the rejected alternative.

The repo **deliberately gitignores lockfiles** (`.gitignore:19-20`, `ci.yml:25-28`). Two ways to make the runtime closure deterministic:

- **Approach A (CHOSEN): commit & ship a `plugin/bun.lock`, install with `--frozen-lockfile`.** Carries the full transitive closure; matches the master's "enforce a boundary on what we ship" and the requested goal. Cost: reverses the gitignore policy *scoped to the plugin lockfile only*.
- **Approach B (fallback): exact-pin versions in the generated `plugin/package.json`** (no `^`), no lockfile. Respects the no-lockfile policy; deterministic for top-level deps (enough for the literal zod/v3 bug) but does **not** pin transitive deps. Weaker "full closure" guarantee.

**This plan implements Approach A.** If the maintainer rejects reversing the lockfile policy, switch Phase 1 to Approach B (the generator edit at `build-hooks.js:209` becomes exact-version emission and Phases 2-5 are unchanged). **Do not proceed past Phase 1 design without this confirmed.**

### Allowed APIs / tools (cite when used)
- `bun install --frozen-lockfile --ignore-scripts` (Bun CLI) — pinned install.
- `bun install` in `plugin/` to (re)generate `plugin/bun.lock`.
- `require.resolve(specifier, { paths })` (Node) — subpath resolution assertion.
- `npm pack` + `npm install <tarball> --prefix <tmp>` (npm CLI) — clean-room install.
- `bun test`, `bun:test` (`describe/it/expect`) — repo test convention.

### Anti-patterns to avoid (from discovery)
- ❌ Editing `plugin/package.json` directly — it is regenerated by `build-hooks.js:202-249`.
- ❌ Removing `'zod'` from the worker `external` list to "just bundle it" — diverges from the architecture, bloats `worker-service.cjs` against `WORKER_SERVICE_MAX_BYTES` (`build-hooks.js:322-329`), and doesn't generalize to other missing runtime deps. (Noted as a rejected alternative, not the fix.)
- ❌ Breaking the MCP no-external-zod guard (`build-hooks.js:421-428`).
- ❌ Using `npm ci` in CI (no lockfile for the root; and the plugin lockfile is bun's).
- ❌ Adding a `process.exit(1)` or a blocking reinstall on a hook path (`version-check.js`) — CLAUDE.md forbids it; auto-reinstall-on-update is out of scope (see Deferred).

---

## Phase 1 — Ship a deterministic runtime dependency closure (Approach A)

**What to implement**
1. Make the generated plugin manifest version-consistent: in `scripts/build-hooks.js:209`, align the generated `zod` range with root (`package.json:145` → `^4.4.3`). Keep all 27 deps; only fix the skew. Copy the existing generator object shape (lines 202-249) — do not restructure it.
2. Generate the lockfile as a build artifact: after `build-hooks.js` writes `plugin/package.json`, run `bun install` in `plugin/` to produce `plugin/bun.lock`. Add a build step (new script `scripts/gen-plugin-lockfile.cjs` invoked from the `build` script in `package.json:65`, AFTER `build-hooks.js`) — or extend `build-hooks.js` to shell out to `bun install --cwd plugin`. Follow the existing `execSync` pattern used in `scripts/sync-marketplace.cjs:138-162`.
3. Commit & ship the lockfile:
   - `.gitignore:19-20` — narrow the ignore so `plugin/bun.lock` is **tracked** (keep ignoring root `bun.lock`/`package-lock.json` if desired; un-ignore the plugin one).
   - `.npmignore` — **remove** the `plugin/bun.lock` exclusion.
   - `package.json:43-58` `files` — **add** `plugin/bun.lock` to the allowlist.
4. Install from the lockfile: `src/npx-cli/install/setup-runtime.ts:370` — change `bun install --ignore-scripts` → `bun install --frozen-lockfile --ignore-scripts`. Keep `--ignore-scripts`. (`copyPluginToCache` at `install.ts:574-581` already copies the whole `plugin/` tree recursively, so the committed `plugin/bun.lock` is carried into the cache dir automatically — verify, don't add new copy logic.)

**Documentation references**
- Generator object + zod line: `scripts/build-hooks.js:202-249` (zod `:209`).
- `execSync` install pattern to copy: `scripts/sync-marketplace.cjs:138-162`.
- Install command to edit: `src/npx-cli/install/setup-runtime.ts:370`.
- Recursive plugin copy (confirm lockfile is carried): `src/npx-cli/commands/install.ts:574-581`.
- Allowlist/ignore files: `package.json:43-58`, `.npmignore`, `.gitignore:19-20`.

**Verification checklist**
- [ ] `npm run build` produces a tracked `plugin/bun.lock` containing zod@4.4.x and all 27 deps.
- [ ] `git status` shows `plugin/bun.lock` as tracked (not ignored): `git check-ignore plugin/bun.lock` returns nothing.
- [ ] `npm pack` tarball contains `plugin/bun.lock` and `plugin/package.json`: `tar -tzf $(npm pack --silent) | grep -E 'plugin/(bun.lock|package.json)'`.
- [ ] In a temp copy of `plugin/`, `bun install --frozen-lockfile --ignore-scripts` succeeds with **no** "lockfile had changes" error (proves manifest⇄lockfile are in sync).
- [ ] After install, `require.resolve('zod/v3', { paths: ['<tmp>/node_modules'] })` resolves.
- [ ] Generated `plugin/package.json` zod range equals root (`grep '"zod"' plugin/package.json package.json`).

**Anti-pattern guards**
- ❌ Do not hand-edit `plugin/package.json` (regenerated).
- ❌ Do not drop `--ignore-scripts` (postinstall-hang lesson, `plans/04`).
- ❌ Do not commit the root `node_modules` or a root lockfile to "fix" this — scope is the plugin runtime closure.
- ❌ Do not change the worker `external` list.

---

## Phase 2 — Make a broken install fail LOUD at install time

**What to implement**
Strengthen `verifyCriticalModules` (`src/npx-cli/install/setup-runtime.ts:221-236`) so it asserts the dependency is actually **importable**, not merely a directory. For each critical dep, resolve it with `require.resolve(dep, { paths: [<cacheDir>/node_modules] })`; and for zod specifically, also assert the **subpaths the worker requires** resolve: `zod/v3`, `zod/v4`, `zod/v4-mini`. On failure, throw the existing loud install error (copy the error-emission pattern already used in that function / the installer error taxonomy from `plans/04`). The point: a partial/stale install fails `npx claude-mem install` immediately instead of surfacing later as a Stop-hook `Cannot find module`.

**Documentation references**
- Function to extend: `src/npx-cli/install/setup-runtime.ts:221-236` (current dir-existence check at 227-228).
- Exact subpaths to assert: derived from `plugin/scripts/worker-service.cjs` (`require("zod/v3"|"zod/v4"|"zod/v4-mini")`) — see Phase 0.
- Installer error-emission style: reuse the same throw/log this file already uses; cross-ref `plans/04-installer-transparency.md` taxonomy.

**Verification checklist**
- [ ] New unit test (`tests/cli/verify-critical-modules.test.ts`, `bun:test`, copy shape from `tests/json-utils.test.ts`): given a temp `node_modules` with `zod` present but `zod/v3` export missing/removed, `verifyCriticalModules` THROWS; given a complete zod v4, it passes.
- [ ] `bun test tests/cli/` green.
- [ ] Manual: delete `node_modules/zod/v3*` in a temp install → `verifyCriticalModules` fails with a clear message naming `zod/v3`.

**Anti-pattern guards**
- ❌ Do not assume `require.resolve` of the package root implies subpaths resolve — assert subpaths explicitly (that's the whole bug).
- ❌ Do not swallow the failure (no empty catch) — it must throw/exit non-zero on the install path (NOT a hook path).
- ❌ Do not hardcode a zod version; assert subpath resolution, which is version-agnostic.

---

## Phase 3 — Clean-room install + import smoke test (the regression backstop)

**What to implement**
A net-new script `scripts/smoke-clean-room.cjs` (model its `execSync`/temp-dir style on `scripts/sync-marketplace.cjs` + `tests/json-utils.test.ts` temp-dir handling) that, against a fresh temp dir:
1. **Plugin-runtime closure (the #2730 guard):** copy `plugin/` → tmp, `bun install --frozen-lockfile --ignore-scripts`, then assert `require.resolve` of `zod`, `zod/v3`, `zod/v4`, `zod/v4-mini` from `<tmp>/node_modules`; then spawn `bun <tmp>/scripts/worker-service.cjs` with a no-op/`--help`-style invocation and assert it does **not** print `Cannot find module`.
2. **npm-package completeness:** `npm pack`, install the tarball into a second temp dir (`npm install <tarball> --prefix <tmp2> --ignore-scripts`), then `node -e "require('<tmp2>/.../dist/npx-cli/index.js')"`-style load of the published `bin`/`main` entrypoints (`package.json:29-42`) to catch missing `dist` runtime deps.
3. Exit non-zero with a precise message on any missing module. Add an npm script `"smoke:clean-room": "node scripts/smoke-clean-room.cjs"` near the other scripts (`package.json:104-110`).

**Documentation references**
- Temp-dir + spawn conventions: `tests/json-utils.test.ts`, `scripts/sync-marketplace.cjs:138-173`.
- Published entrypoints to load: `package.json:29-42` (`bin`, `main`, `exports`).
- Subpaths to assert: Phase 0 (worker-service.cjs requires).
- Existing prepublish-guard precedent: `scripts/check-postinstall-allowlist.js`.

**Verification checklist**
- [ ] `npm run build && npm run smoke:clean-room` exits 0 on a healthy tree.
- [ ] Fault injection: temporarily remove `zod` from the generated manifest (or delete it from the tmp `node_modules`) → the script exits non-zero and names `zod/v3`. Revert.
- [ ] Script makes **no** network calls beyond the package installs and runs offline against the local registry cache where possible (note any unavoidable network in the script header).
- [ ] Runtime under ~2-3 min on CI (it does two installs).

**Anti-pattern guards**
- ❌ Do not run the smoke test against the repo's already-installed `node_modules` — it must use a fresh temp dir (the existing `tests/server/server-runtime-smoke.test.ts` runs in-tree and would NOT catch this class).
- ❌ Do not assert on minified symbol names inside `worker-service.cjs`; assert on module resolution + absence of `Cannot find module`.
- ❌ Do not leave temp dirs behind (clean up in a `finally`).

---

## Phase 4 — Wire into CI and gate publish

**What to implement**
1. **PR gate:** add a new job to `.github/workflows/ci.yml` (insert after the `build` job ends at line 47, before `server-runtime-e2e-docker:` at line 49). Copy the runner/setup boilerplate from the `build` job (lines 11-30: `runs-on: ubuntu-latest`, checkout@v4, setup-node@v4 node 20, setup-bun@v2, `npm install --no-audit --no-fund`). Steps: `npm run build` → `npm run smoke:clean-room`. Name it e.g. `clean-room-deps` ("clean-room dependency closure smoke").
2. **Frozen-lockfile drift check:** in the same job (or the `build` job), add a step that runs `bun install --frozen-lockfile --ignore-scripts` inside `plugin/` and fails if the lockfile is out of sync with the generated manifest (catches a contributor who changed deps but didn't regenerate the lockfile).
3. **Publish gate:** `.github/workflows/npm-publish.yml` is tag-triggered and independent of `ci.yml`, so the gate must live inside it. Insert `npm run smoke:clean-room` as a step **between** `npm run build` (line 18) and `npm publish` (line 19). (Alternatively split into a separate job and add `needs:` to `publish` — inline is simpler and sufficient.)

**Documentation references**
- PR-gate insertion point + boilerplate to copy: `.github/workflows/ci.yml:9-47`.
- Publish step to gate: `.github/workflows/npm-publish.yml:17-19`.
- Lockfile-is-gitignored caveat (now partially reversed for plugin): `ci.yml:25-28`.

**Verification checklist**
- [ ] `actionlint`/yaml parses (or GitHub "Actions" tab shows the new job on a draft PR).
- [ ] On a PR that intentionally breaks the closure (drop a dep in the generator), the `clean-room-deps` job FAILS.
- [ ] On a clean PR, `clean-room-deps` PASSES.
- [ ] The publish workflow contains the smoke step before `npm publish` (`grep -n 'smoke:clean-room' .github/workflows/npm-publish.yml`).
- [ ] The frozen-lockfile drift step fails when `plugin/package.json` is edited without regenerating `plugin/bun.lock`.

**Anti-pattern guards**
- ❌ Do not put the publish gate only in `ci.yml` — it does not run on tag pushes; the publish job would remain ungated.
- ❌ Do not add `cache: 'npm'` / `npm ci` (no root lockfile).
- ❌ Do not duplicate secrets handling; reuse the existing `NODE_AUTH_TOKEN`/`NPM_TOKEN` block.

---

## Phase 5 — Final verification

1. **Implementation matches docs:** re-read Phase 0 file:line anchors and confirm every edit landed where specified (`build-hooks.js:209`, `setup-runtime.ts:370`, `setup-runtime.ts:221-236`, `package.json files`, `.npmignore`, `.gitignore`, both workflow files, new script + npm script).
2. **Anti-pattern grep:**
   - `grep -n "bun install --ignore-scripts" src/npx-cli/install/setup-runtime.ts` → must now read `--frozen-lockfile --ignore-scripts`.
   - `grep -n "plugin/bun.lock" .npmignore` → must return nothing (un-excluded).
   - `git check-ignore plugin/bun.lock` → returns nothing (tracked).
   - confirm worker `external` still lists `'zod'` (`build-hooks.js:277`) and MCP guard intact (`:421-428`).
3. **Full suite:** `npm run typecheck && npm run build && bun test && npm run smoke:clean-room` all green.
4. **End-to-end repro of #2730:** in a throwaway dir, simulate the cache install path (`bun install --frozen-lockfile --ignore-scripts` against shipped `plugin/`), launch `worker-service.cjs` in a Stop-hook-style invocation, confirm **no** `Cannot find module 'zod/v3'`.
5. **Issue hygiene:** PR body `Closes #2783` (and references #2730). The clean-room job + frozen-lockfile drift check are the test-matrix cells this slice contributes to CI (per `plans/EXECUTION.md`).

---

## Deferred plan-10 scope (NOT this PR — separate slices)
- #2584 — `worker-service.cjs` bundles unused `better-auth` (~3.7MB); externalize/gate behind server runtime.
- #2570 — bundle-size canary in CI + cross-platform marketplace-sync.
- #2538 — fix the 24 typecheck-drift errors; make `npm run typecheck` a required gate.
- #2537 — `files`/`.npmignore` so maintainer `CLAUDE.md` files don't publish; assert tarball contents.

Each is its own `/make-plan` → `/do`. They share plan-10's "enforce a boundary on what we ship" architecture but ship independently after this Wave-0 slice unblocks the rest.

## Out-of-scope (other masters)
- Auto-**reinstall** of deps on update (vs. today's hint-only `version-check.js:65`) — lifecycle behavior, route to **plan-03 #2780**. This plan makes the install *deterministic and loud*; it does not change WHEN the install runs.
- Worker runtime crashes unrelated to dep resolution — **plan-03**.
