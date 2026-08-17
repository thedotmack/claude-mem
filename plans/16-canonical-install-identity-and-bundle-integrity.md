# [plan-16] Canonical Install Identity & Bundle Integrity — one resolvable, dependency-complete plugin root, and recycles that cannot kill a working worker

> **Tracker:** #3604 · **Design doc:** `plans/16-canonical-install-identity-and-bundle-integrity.md` · **Series:** plan-14 #3602 · plan-15 #3603 · plan-16 #3604 · plan-17 #3605 · plan-18 #3606 · plan-19 #3607 · plan-20 #3608 · plan-21 #3609 · plan-22 #3610 · plan-23 #3611

## Defect

There is no single answer to "which copy of claude-mem is installed and runnable". Hooks, the supervisor's successor spawn, `npx claude-mem` (install/repair/doctor/status), the SDK subprocess, and the marketplace auto-updater each resolve the plugin root independently, and none of them verifies the copy has its runtime dependencies:

- The hook prelude picks the newest **mtime** under `~/.claude/plugins/cache/thedotmack/claude-mem/[0-9]*/` (`ls -dt … | head -1`), accepts 1-byte gutted stubs and `.orphaned_at` dirs, and falls back to `~/.claude/plugins/marketplaces/thedotmack/plugin/` — a checkout that never has `node_modules`. `resolveWorkerScriptPath()`/`resolveSuccessorScript()` repeat the same mtime sort in code (fixed on the hook side by #3371 in 13.12.x; still present in successor resolution per #3216/#3565).
- `worker-service.cjs` externalizes `zod`, `shell-quote`, `tree-sitter-*`, `ajv*`, `better-auth`, and (13.9.x) `../sqlite/{SessionStore,observations/files}.js`; the bundle requires modules the build never emits and a `node_modules` the plugin update / marketplace pull never installs (`Cannot find module 'zod/v3'`, `Cannot find module '../sqlite/observations/files.js'`). `tree-sitter-cli`'s binary is fetched by an install script suppressed by `--ignore-scripts`; the Windows resolver checks an extensionless path; grammars declare conflicting `tree-sitter` peer majors (`ERESOLVE`); npm 12 rejects the `--allow-scripts` CLI flag the installer passes.
- The version-mismatch recycle compares the *marketplace manifest* version to the worker's `/api/health` version and kills the incumbent **before** a successor exists, then lazy-spawns from whichever path the resolver returns — often the marketplace copy or an older cache dir — and waits for a plugin-version match a fresh worker can never report when the manifest is stale. Result: unbounded recycle loops (86–449/hour) that feed plan-14's leak and plan-15's ghost ports, and a healthy worker replaced by a guaranteed-to-fail one.
- `doctor` checks marketplace `node_modules`, `repair` installs into the version cache, `status` reports "not installed" beside a healthy worker; `.orphaned_at` is honored by hook shells but not by the running daemon; stale cache versions are never GC'd; the marketplace has no root `.claude-plugin/marketplace.json`.
- The shipped bundle set is not audited: DEP0190 (`args` + `shell:true`) survives in `dist/npx-cli`, `shell-quote` and sync-hub transitive deps carry known CVEs, an agent-directive template ships in `plugin/modes/`, and Windows CI is red for reasons unrelated to the PR under test.

## Children

- #2831 — worker-service.cjs has external zod requires — breaks when node_modules missing
- #2910 — smart_search/smart_outline/smart_unfold return 0 symbols on clean Windows install — tree-sitter-cli binary never downloaded (--ignore-scripts), extensionless existsSync
- #2922 — Shared Windows CI noise (tree-sitter-css node-gyp on hosted runner)
- #2941 — DEP0190 still reproducible on 13.6.1: args + shell in the npx-cli bundle
- #2952 — shell-quote 1.8.3 has CVE-2026-9277 — recommend upgrade
- #2964 — tracking: plugin runtime deps missing in distributed bundles — zod external, tree-sitter-cli not downloaded, hooks crash
- #2974 — tracking: shared Windows CI noise — tree-sitter-css node-gyp rebuild fails on GitHub hosted runner
- #3004 — marketplace.json location not compatible with Claude Code plugin discovery
- #3035 — ERESOLVE peer-dependency conflict: tree-sitter version mismatch on install
- #3054 — Add CLAUDE_MEM_WORKER_SCRIPT_PATH to pin the worker bundle
- #3056 — SettingsDefaultsManager loadFromFile tests fail on a dev machine running claude-mem (ambient env leaks)
- #3072 — Native tree-sitter grammars fail under bun on Windows — worker always launched with bun, whose Node-API is incomplete
- #3091 — v13.9.1: observation → Chroma vector sync fails on every observation (missing `../sqlite/observations/files.js`)
- #3100 — [Windows] version-mismatch worker self-kill + port zombie chain (13.9.x)
- #3107 — Chroma vector sync broken on 13.9.x: worker-service.cjs requires ../sqlite/*.js which the build never emits
- #3117 — doctor's required 'Marketplace deps' check cannot be cured by its own hint — repair installs only to the version cache
- #3126 — Backfill crashes on missing module '../sqlite/observations/files.js'; search query param ignored
- #3134 — Linux: worker path resolves to different on-disk copies across invocation contexts → two concurrent daemons; stale cache versions never GC'd
- #3152 — smart_search/smart_outline broken for all languages — tree-sitter-cli binary never installed
- #3155 — hooks.json plugin-root resolution can select a gutted stub or fall back to the marketplace copy during an auto-update window
- #3253 — new install claude-mem @ 13.11.0 raises "allowScripts" error
- #3392 — CI: 'typecheck · build · test · bundle-size' job flakes (order-dependent mocks, CORS port collision)
- #3424 — Fresh install broken: marketplace cache-miss on load, then subscription-auth fails for worker compression spawn
- #3438 — Make the 'no agent directives in shipped files' rule structural — law-study-CLAUDE.md still ships
- #3456 — .orphaned_at is a hook-only filter — running daemon and chroma-mcp keep going, defeating the manual disable path
- #3478 — osv-scanner: 2 High-severity transitive vulnerabilities in workers/sync-hub/bun.lock
- #3534 — observations never compress; `doctor`/`status` report "not installed" right after a successful install
- #3545 — plugin update does not install declared dependencies — worker fails with Cannot find module 'zod/v3'
- #3565 — Version-mismatch recycle respawns the worker from `marketplaces/…/plugin/`, which never has `node_modules` — guaranteed respawn failure

Related PRs to evaluate/rebase: #3371 (semver resolver, merged), #3095 (tree-sitter runtime provisioning, community-edge only), #3146 (inline `parseFileList`), #2887 (bundle zod, community-edge only), #3055 (`CLAUDE_MEM_WORKER_SCRIPT_PATH`), #2918, #2710, #2597, #2531, #3066, #2945, #2598, #1677, #2699.

## Fix sequence

1. **One resolver, three consumers.** `resolvePluginRoot()` (shared TS, compiled into the hook prelude via `hook-shell-template.ts`, `worker-utils.ts`, and `npx-cli`) returns the highest **semver** cache dir that (a) has a `worker-service.cjs` above a size floor, (b) has no `.orphaned_at`, (c) has `node_modules/zod/v3` (or whatever the bundle's external manifest lists), honoring `CLAUDE_MEM_WORKER_SCRIPT_PATH` first. The marketplace checkout is **never** a spawn target. `installed_plugins.json` `installPath` is preferred when present.
2. **Bundle owes nothing to the filesystem it can't see.** Inline every pure-JS external (zod, shell-quote, ajv, `sqlite/observations/files`); ship `plugin/sqlite/` for anything that must stay external; add a build-time guard that scans `plugin/scripts/*.cjs` for `require("../…")`/external ids and fails unless the target is in the tarball. `npm pack --dry-run` diff is asserted in CI.
3. **Dependencies materialize with the copy.** Plugin update / first hook / `repair` run `bun install --production` (or vendored `node_modules`) inside the version dir with an `.install-version` marker written **after** success; tree-sitter-cli binary is fetched by an explicit non-lifecycle step with `.exe` resolution on Windows; grammars aligned to one `tree-sitter` major or moved behind an optional step; `allowScripts` declared in `package.json`/`.npmrc`, never as a CLI flag. New version dirs are published atomically (temp + rename).
4. **Recycle only into a proven successor.** Version comparison is semver-strict-newer against the *resolved installed root*, not the marketplace manifest; the successor is spawned first on a probe port, must answer `/api/health` with its own token, then the incumbent is asked to hand off (plan-15 handoff); failure keeps the incumbent and opens a per-boot circuit breaker (max 3 recycles/hour, logged). `.orphaned_at` is checked by the daemon at boot and each supervisor tick → graceful shutdown.
5. **doctor / status / repair agree.** All three use `resolvePluginRoot()`; `doctor` reports the resolved root, its version, and its dependency completeness; `repair` fixes *that* root; "not installed" is only reported when the resolver returns nothing. Marketplace registration writes `.claude-plugin/marketplace.json` at the root the host discovers.
6. **GC and audit.** On successful upgrade, remove cache dirs older than the previous version (keep N=2); CI runs `osv-scanner` on all lockfiles, `check-spawn-env-discipline.cjs` against `dist/` (DEP0190), and a packaging lint that fails on tracked `*CLAUDE.md` outside an allowlist. Windows CI pinned to a runner with a working toolchain (or native grammar build skipped) so it is trustworthy; the flaky mock/port tests (#3392, #3056) are isolated so the matrix can be gated on green.

## Test matrix

| Host | Install path | Scenario | Required behavior |
|---|---|---|---|
| macOS / Linux / Windows | marketplace | `claude plugin update` N → N+1 mid-session | hooks resolve N+1 only after its deps exist; incumbent N keeps serving until successor healthy; zero recycles logged after handoff |
| all | marketplace | manifest version ≠ cache version (stale manifest) | no recycle; `doctor` explains the skew |
| all | marketplace | cache dir with `.orphaned_at` / 1-byte stub / no `node_modules` | never selected; daemon from an orphaned dir shuts itself down |
| all | `npx claude-mem install` (npm 10/11/12, Node 20/22/24/26) | fresh install | exit 0; `doctor` green; `smart_search` returns symbols on a `.ts` file |
| Windows | Bun worker | tree-sitter grammars | either load under Node or degrade per-language with a WARN, never `0 symbols` silently |
| all | tarball | `npm pack` | every `require()` target in `plugin/scripts/*.cjs` resolves inside the tarball |
| all | repo | CI | osv-scanner clean, DEP0190 lint clean, packaging lint clean, Windows job green on an empty PR |

The matrix lives in CI (`tests/infrastructure/plugin-distribution.test.ts`, a fresh-install Docker job per Node/npm version, and the Windows job). A regression must fail CI before a user can file.

## Out of scope

What happens to children of the killed incumbent (plan-14) and how the port is handed over/reclaimed (plan-15). Hook shell prelude cost and fail-open semantics (plan-17).
