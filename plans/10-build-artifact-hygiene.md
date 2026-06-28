# [plan-10] Build / Bundle / CI Artifact Hygiene — enforce a boundary on what we ship

## Defect

There is no enforced discipline on the contents, size, or correctness of published artifacts, so dead weight and maintainer files leak into what users install, and `main` can ship with a broken typecheck. The worker bundler reaches past the plugin's declared dependency boundary and pulls in code that is never used; there is no CI guard to catch the resulting bloat; the published npm tarball ships maintainer `CLAUDE.md` files because there is no `files` allowlist; and `npm run typecheck` is red on `main`. Each is a symptom of the same missing contract: **the build must declare and enforce its boundaries — externals, size, tarball contents, and a green typecheck — in CI**.

## Children

- #2584 — `worker-service.cjs` bundles unused `better-auth` (94 OAuth URLs, ~3.7MB); bundler reaches past the dep boundary
- #2570 — no bundle-size guardrail in CI; bash-only marketplace-sync breaks on Windows (non-idempotent)
- #2538 — 24 pre-existing TypeScript errors block `npm run typecheck` on `main` (Express 5 / React 19 / logger union drift)
- #2537 — published npm tarball ships five `CLAUDE.md` files (no `files` allowlist / `.npmignore`)

## Fix sequence

1. **Externalize / treeshake:** mark `better-auth` (and any other server-only dep) external to the worker bundle, or gate it behind the server runtime so it never enters the worker artifact (#2584).
2. **Bundle-size canary in CI:** record a baseline and fail CI when the worker bundle grows past a threshold; port the marketplace-sync step to a cross-platform, idempotent script (#2570).
3. **Green typecheck gate:** fix the 24 drift errors (Express 5, React 19, logger union) and make `npm run typecheck` a required CI check so `main` can't go red again (#2538).
4. **Tarball allowlist:** add a `files` allowlist (and/or `.npmignore`) so only intended artifacts publish; assert tarball contents in CI (#2537).

## Test matrix

| Artifact | Check | Required behavior |
|---|---|---|
| `worker-service.cjs` | bundle size vs baseline | no `better-auth`; size under threshold or CI fails |
| Repo `main` | `npm run typecheck` | exit 0; required check |
| npm tarball | `npm pack` contents | only allowlisted files; no maintainer `CLAUDE.md` |
| Marketplace sync | run on Windows + POSIX | idempotent; succeeds on both |

The matrix lives in CI. An artifact-hygiene regression must fail CI before a user can install it.

## Recluster note (2026-06-04)

Issue #2730 (`Cannot find module 'zod/v3'`) is tracked **here**, not plan-04. Discovery
(see `plans/10-build-artifact-hygiene-EXECUTION.md` Phase 0) found the root cause is a
*shipped-artifact* defect — no lockfile is committed, zod is external to the worker bundle,
and the unpinned `bun install` plus an auto-update that never re-installs leave `node_modules/zod`
stale/missing. That is "what we ship," i.e. this master. The Wave-0 execution slice for #2730
lives in `plans/10-build-artifact-hygiene-EXECUTION.md`.

## Out of scope

- Missing-runtime-dependency-on-install (node_modules / zod not shipped) — **moved into this plan**
  (see Recluster note above); the original routing to plan-04 predated the no-lockfile root cause.
- WHEN the dependency install runs on auto-update (hint-only vs. auto-reinstall) → plan-03.
- Worker runtime crashes unrelated to dependency resolution → plan-03.
