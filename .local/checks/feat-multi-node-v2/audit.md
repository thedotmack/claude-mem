# feat/multi-node-v2 audit

Date: 2026-04-10
Mode: read-only code audit, local artifact only

## Git state

- Branch: `feat/multi-node-v2`
- Tracking: `upstream/main`
- Ahead of upstream/main: 1 commit
- HEAD: `0ab04776 feat: multi-node network mode — shared instance, security, provenance tracking`
- Remote branch: no `origin/feat/multi-node-v2` found via `git ls-remote`
- Working tree at audit time:
  - `plugin/scripts/proxy-service.cjs` modified
  - `plugin/scripts/worker-service.cjs` modified
- Those two changes were produced by `npm run build`; diff is generated artifact metadata, mainly embedded commit SHA changing from `1caaa3b7` to `0ab04776`.

## Remotes

- `origin`: `git@github.com:Regis-RCR/claude-mem.git`
- `upstream`: `git@github.com:thedotmack/claude-mem.git`
- `git fetch --all --prune` completed successfully.
- `upstream/main` is currently `cde4faae docs: update CHANGELOG.md for v12.1.0`.

## Validation run

Full suite:

- Command: `bun test`
- Result: failed
- Summary: 1281 pass, 3 skip, 183 fail, 34 errors, 1467 tests across 92 files
- Signal quality: low for this environment because many failures are caused by sandbox restrictions on ports and writes under `~/.claude-mem` / `~/Library/LaunchAgents`.

Targeted multi-node suite, run outside sandbox:

- Command:
  `bun test tests/infrastructure/offline-buffer.test.ts tests/proxy/proxy-server.test.ts tests/server/auth-middleware.test.ts tests/server/client-registry.test.ts tests/shared/node-identity.test.ts tests/shared/buffered-post-request.test.ts tests/services/server-mode-startup.test.ts tests/integration/multi-machine-e2e.test.ts tests/sqlite/migration-24-provenance.test.ts tests/sqlite/observation-provenance.test.ts`
- Result: failed
- Summary: 115 pass, 2 fail, 117 tests across 10 files
- Passing areas:
  - `ProxyServer`
  - `ClientRegistry`
  - auth middleware
  - node identity unit tests
  - buffered post request
  - server mode startup
  - SQLite provenance migration
  - observation provenance storage
  - offline buffer

## Real blocker found

Two failures remain in `tests/integration/multi-machine-e2e.test.ts`:

- `Multi-machine E2E > Proxy -> Server forwarding > should forward POST with auth and node headers to the server`
- `Multi-machine E2E > Auth header injection > should add X-Claude-Mem-Node header to every forwarded request`

Both failures have the same symptom:

- Expected node header: `e2e-node`
- Received node header: `test-node`

Likely cause: `src/shared/node-identity.ts` caches node identity in module state. Earlier tests set `CLAUDE_MEM_NODE_NAME=test-node`; the multi-machine E2E test then sets `e2e-node`, but does not clear the cache before constructing `ProxyServer`.

## Suggested next steps

1. Clear node identity cache in tests that mutate `CLAUDE_MEM_NODE_NAME`.
   - Existing exported helper: `clearNodeNameCache()`.
   - Candidate files: `tests/proxy/proxy-server.test.ts`, `tests/shared/buffered-post-request.test.ts`, `tests/integration/multi-machine-e2e.test.ts`, possibly `tests/shared/node-identity.test.ts`.

2. Re-run the targeted multi-node suite outside sandbox.
   - Goal: get 117/117 passing.

3. Decide whether generated bundles should be committed.
   - Current dirty files only reflect build-generated embedded commit SHA.
   - If bundles are committed, a follow-up commit changes the SHA again, so this needs a deliberate policy.

4. Publish branch to fork before upstream PR.
   - Current branch tracks `upstream/main`, not `origin/feat/multi-node-v2`.
   - No remote `origin/feat/multi-node-v2` was found.
   - Recommended push target: `origin feat/multi-node-v2`.

5. Open upstream PR from `Regis-RCR:feat/multi-node-v2` to `thedotmack:main` only after targeted tests pass and the generated-artifact policy is settled.

