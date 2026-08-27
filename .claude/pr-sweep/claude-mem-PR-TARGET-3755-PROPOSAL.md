## Summary

Setup currently treats any node_modules directory as a complete plugin install. An interrupted install can leave required packages missing, so every later Setup run skips repair and the worker cannot boot. The guard now checks the declared dependency closure before deciding to skip bun install, while retaining the existing failed-install cleanup.

Closes #3755

## Why

ensurePluginDependencies returns at the directory-existence check in plugin/scripts/version-check.js before it reads the plugin manifest or checks installed packages. The new file-local check derives package names from package.json, validates path segments, and requires a readable installed package manifest before skipping the install.

## Scope

This covers presence-level recovery for incomplete plugin installs. It does not validate dependency versions or integrity, alter install arguments, change hook commands, or change the separate worker version-mismatch and timeout paths.

## Risk

Complete installs still skip bun install; malformed manifests preserve the existing existence behavior. Only a declared dependency missing from the installed closure causes a retry, and existing failure cleanup remains authoritative. A successful install that remains incomplete emits one diagnostic and does not loop.

## Verification

- [ ] `bun test tests/plugin-version-check-ensure-deps.test.ts` — 6 skipped on Windows; implementation rows not reached
- [x] `bun test tests/plugin-version-check.test.ts` — 4 passing
- [x] `npm run typecheck` — passed
- [x] `npm run build` — all build targets compiled successfully; worker advisory size warning recorded in proof
- [x] `npm run lint:hook-io` — clean
- [x] `npm run lint:spawn-env` — clean
- [ ] `npm run strip-comments:check` — baseline reports 413 changed comments
- [x] `git diff --check` — clean

Closes #3755
