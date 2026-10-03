# Test Baseline (untouched origin/main)

- Date: 2026-10-02
- Commit: `039c6160f0ff26e9fab37cae7f50b994ba68f7ff` (test(viewer): pin the system-dark fallback to the dark theme...)
  - While this baseline was running, another session committed `5284b4b5c` (docs(plans), touching only `plans/`) on `fix/hooks-exec-form-launcher`. No code changed, so the baseline also holds for `5284b4b5c`.
- Version: claude-mem 13.28.0
- Runtime: Bun 1.3.9, macOS arm64
- Raw logs: `.scratch/` (install.log, typecheck.log, build.log, build-modified-files.txt, test.log, test-rerun-failures.log)

## Commands

| Step | Command | Result |
|---|---|---|
| Install | `npm install --no-audit --no-fund` (matches CI; no committed lockfile) | PASS (713 packages) |
| Typecheck | `npm run typecheck` | PASS (exit 0) |
| Build | `npm run build` | PASS (exit 0) |
| Tests | `npm test` (= `bun test tests`) | FAIL (exit 1) |

## Build side effects

`npm run build` rewrote 19 tracked files; all restored with `git checkout --` before tests ran:

```
plugin/package.json
plugin/scripts/context-generator.cjs(.map)
plugin/scripts/mcp-server.cjs(.map)
plugin/scripts/server-service.cjs(.map)
plugin/scripts/transcript-watcher.cjs(.map)
plugin/scripts/worker-service.cjs(.map)
plugin/skills/how-it-works/onboarding-explainer.md
plugin/sqlite/SessionStore.js(.map)
plugin/sqlite/observations/files.js(.map)
plugin/ui/tv.html
plugin/ui/viewer-bundle.js
plugin/ui/viewer.html
```

## Test totals

- 6672 tests across 567 files, 361s
- **6637 pass / 2 fail / 33 skip / 1 unhandled error between tests**
- 31642 expect() calls

## Failing tests

1. `tests/worker/field-deadline-wire.test.ts`: "field deadline cancels real OpenRouter fetch and prevents retries"
   - `expect(disconnected).toBe(true)` received `false` (line 46)
   - **Fails every time**: it also fails when the file is run on its own.
2. `tests/cli/hook-stdout-flush.test.ts`: "hook stdout completes before graceful exit > Bun rejects a closed stdout pipe with a handled delivery error"
   - `spawn` threw `Failed to connect` (ENOENT) at line 77, followed by an unhandled error between tests: `expect(output.stderr).toBe('')` (line 154) received an EPIPE stack from `writeSync(3, "drain")` in the fixture.
   - **Flaky**: it passes when the file is run on its own (`bun test tests/cli/hook-stdout-flush.test.ts tests/worker/field-deadline-wire.test.ts` gives 7 pass / 1 fail, and the only failure is #1).

The 1 unhandled error comes from failing test #2. It is not a separate failure.
