# Target 3755 proof report

## Base anchor

Command: git show origin/main:plugin/scripts/version-check.js | Select-Object -Index (57..62)

Observed base behavior: origin/main is 866a0ca3b34cddd8aa4c5fba72b9ad2b3a5621fe, and the early guard returns when node_modules exists without checking declared dependencies. The focused regression suite is skipped on this Windows host, so the base-fails/head-passes subprocess comparison is not reached locally.

## Required proof matrix

| Surface | Command run | Observed result | Base/head |
| --- | --- | --- | --- |
| Partial install recovery | `bun test tests/plugin-version-check-ensure-deps.test.ts` | `0 pass` / `6 skip` / `0 fail`; `(skip) version-check Setup-phase ensurePluginDependencies (gh #2649) > repairs an existing partial node_modules tree` | base: `Existing directory causes zero install attempts and the package remains absent.`; head: `Incomplete closure invokes install and repairs it.`; blocked locally because Unix-only fake-bun subprocess tests skip on Windows |
| Complete tree skip | `bun test tests/plugin-version-check-ensure-deps.test.ts` | `0 pass` / `6 skip` / `0 fail`; `(skip) version-check Setup-phase ensurePluginDependencies (gh #2649) > skips install when every declared package has a readable manifest` | base: `Existing directory skips install.`; head: `Complete manifests still skip and preserve diagnostics.`; blocked locally because the suite skips on Windows |
| Failed install cleanup | `bun test tests/plugin-version-check-ensure-deps.test.ts` | `0 pass` / `6 skip` / `0 fail`; `(skip) version-check Setup-phase ensurePluginDependencies (gh #2649) > cleans up partial node_modules after a failed install so next Setup can retry (gh #2650 review)` | base: `Failed partial install uses existing cleanup.`; head: `Same failure arm removes the partial directory.`; blocked locally because the suite skips on Windows |
| Manifest fail-open | `bun test tests/plugin-version-check-ensure-deps.test.ts` | `0 pass` / `6 skip` / `0 fail`; `(skip) version-check Setup-phase ensurePluginDependencies (gh #2649) > fails open for an invalid plugin manifest` | base: `Existing directory with invalid manifest does not throw.`; head: `Same base existence behavior, with no escape or install loop.`; blocked locally because the suite skips on Windows |
| Post-install recheck | `bun test tests/plugin-version-check-ensure-deps.test.ts` | `0 pass` / `6 skip` / `0 fail`; `(skip) version-check Setup-phase ensurePluginDependencies (gh #2649) > reports incomplete output once when install exits successfully without repairing it` | base: `No recheck exists.`; head: `Incomplete success emits a named diagnostic without a loop.`; blocked locally because the suite skips on Windows |

## Focused validation

Command: bun test tests/plugin-version-check.test.ts

bun test v1.3.14 (0d9b296a)
4 pass
0 fail
11 expect() calls
Ran 4 tests across 1 file. [262.00ms]

Command: npm run typecheck

> claude-mem@13.16.1 typecheck
> tsc --noEmit && tsc --noEmit -p src/ui/viewer/tsconfig.json

Command: npm run build

✅ All build targets compiled successfully!
⚠️  worker-service.cjs is 2992.63 KB (advisory budget 2900 KB). If this jumped unexpectedly, check whether a server-only dependency leaked into the worker bundle (see #2584).

Command: npm run lint:hook-io

hook-io discipline: OK (handlers + adapters are pure)

Command: npm run lint:spawn-env

spawn-env discipline: OK (all env-bearing spawns sanitize process.env)

Command: npm run strip-comments:check

Changed:   413 (check mode, no writes)
Unchanged: 508
Skipped:   136
Bytes:     4870787 -> 3854311 (-1016476, -20.9%)

Status: baseline failure, not caused by the target files; check mode reports 413 repository comment differences.

Command: git diff --check

Observed output: no output, exit status 0.

## Reality gate

Plugin dependency materialization remains not reached locally because the focused fake-bun test suite skips on Windows. The implementation claims presence of readable installed package manifests only; it does not claim version or integrity correctness.
