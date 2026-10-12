# Chroma on Windows — Process-Tree Ownership

Status: ready to execute
Target: ONE PR against `thedotmack/claude-mem:main`
Related plan masters: #3610 [plan-22] Chroma Sidecar Contract, #3602 [plan-14] Child Process Ownership, #3603 [plan-15] Worker Port & Liveness

## Problem (verified, not assumed)

Chroma **starts** on Windows today. The cmd.exe `>`/`<` argument mangling (#2954, #3121) is
already fixed on `main` — `ChromaMcpManager` spawns `uvx` directly with no shell wrapper.

What is broken is **process-tree ownership**. Chroma runs as a 4-deep native chain:

    worker → uvx.exe → uv.exe → python.exe → chroma-mcp

Windows has no POSIX process groups and Node's `process.kill(pid, 'SIGTERM')` force-terminates
exactly one PID. Every teardown path except one kills by PID, so the descendants survive. The
survivors then cause all three headline Windows bugs:

| Survivor effect | Issue | Symptom |
|---|---|---|
| Orphan inherits worker's listening socket | #3482 | port 37777 wedged, 834 health-check failures, hooks hard-block |
| `uv` killed mid-build, temp dirs never reaped | #3540 | `builds-v0/.tmp*` leak — 144.21 GB / 696 dirs measured |
| Foreign `VIRTUAL_ENV` inherited into uvx sandbox | #3552 | numpy ABI clash, semantic sync stops **silently** |

The correct fix already exists in the repo but is not shared:
`ChromaMcpManager.killProcessTree()` (`src/services/sync/ChromaMcpManager.ts:1039-1154`)
does POSIX descendant-walk + Windows `taskkill /PID n /T /F`. Nothing else uses it.

## Allowed APIs (verified against source — do not invent)

- `taskkill /PID <n> /T /F` via `execFileAsync` — **the** Windows tree-kill. Precedent: `ChromaMcpManager.ts:1044-1047`.
- `pgrep -P <pid>` for POSIX descendant walk. Precedent: `ChromaMcpManager.ts:1124-1154`.
- `process.platform === 'win32'` — the detection idiom used repo-wide.
- `path.join` / `pathToFileURL` / `fileURLToPath` — already the norm.
- `getSupervisor().registerProcess/unregisterProcess` — `src/supervisor/index.ts`, Chroma already registers as `'chroma-mcp'`.

**ANTI-PATTERNS — these do NOT exist, do not reach for them:**
- Windows Job Objects. Node exposes no Job Object API; adding one needs a native addon or FFI. Out of scope.
- `process.kill(pid, 'SIGTERM')` expecting graceful shutdown on Windows. It is always a hard terminate.
- Any new npm dependency. This PR must be dependency-free.
- `shell: true` or wrapping `uvx` in `cmd.exe`. That re-introduces #2954/#3121.

---

## Phase 1 — Extract the shared tree-kill helper

**Implement:** move the working implementation out of ChromaMcpManager into a shared module.

- Create `src/shared/kill-process-tree.ts` exporting `killProcessTree(pid, opts?)` and `collectDescendantPids(pid)`.
- COPY the body verbatim from `src/services/sync/ChromaMcpManager.ts:1039-1154`. Do not redesign it —
  it is battle-tested (POSIX: leaves-then-root SIGTERM, 500ms settle, re-collect, SIGKILL union;
  Windows: `taskkill /T /F`).
- Make `ChromaMcpManager` import the shared helper and delete its private copy.

**Verify:**
- `grep -n "killProcessTree" src/services/sync/ChromaMcpManager.ts` → import only, no local definition.
- `npm run build` clean.
- Chroma teardown behavior on macOS is unchanged (no regression in existing tests).

**Guard:** do not change the algorithm in this phase. Pure extraction, so the diff is reviewable.

---

## Phase 2 — Route every Windows kill site through the helper

**Implement:** replace single-PID kills with `killProcessTree`. Exact sites found by audit:

| File:line | Current | Why it fails on Windows |
|---|---|---|
| `src/supervisor/process-registry.ts:319` | `process.kill(record.pid, 'SIGTERM')` | cmd.exe wrapper dies, Claude child orphaned |
| `src/supervisor/process-registry.ts:353` | `process.kill(record.pid, 'SIGKILL')` | reaper kills 1 PID, then deletes registry anyway |
| `src/supervisor/process-registry.ts:482` | `proc.kill('SIGKILL')` | `.cmd` wrapper only |
| `src/supervisor/process-registry.ts:770` | `process.kill(record.pid, 'SIGTERM')` | dup-SDK cleanup orphans descendant |
| `src/supervisor/shutdown.ts:186` | `process.kill(pid, signal)` | root exits, survivor scan never reaches taskkill branch |
| `src/shared/worker-utils.ts:514` | `process.kill(stalePidInfo.pid, 'SIGKILL')` | **highest value** — version recycle leaves whole uvx→chroma chain alive holding the socket |
| `src/server/runtime/ServerService.ts:363` | `process.kill(existing.pid, 'SIGTERM')` | skips DB/queue/HTTP cleanup handlers |

`worker-utils.ts:514` is the direct cause of #3482 — fix it even if the phase is otherwise trimmed.

**Verify:**
- `grep -rn "process\.kill(" src/ | grep -v kill-process-tree.ts` → every remaining hit is POSIX-only or intentional; justify each in the PR body.
- `npm run build` clean; existing supervisor tests green.

---

## Phase 3 — Stop the uv build-dir leak

**Implement:** tree-killing `uv` mid-build is what orphans `builds-v0/.tmp*` (#3540).

- In the Chroma teardown path, attempt graceful exit first and only escalate to `taskkill /T /F`
  after a grace period. Reuse the existing 500ms settle idiom rather than inventing a new timer scheme.
- Add a stale-temp sweep for the uv cache `builds-v0` dir, gated to entries older than a
  conservative threshold, run at Chroma start (not shutdown — shutdown may be a hard kill).
- Read `src/shared/uvx-bin-dirs.ts` for how uv dirs are located. Do NOT hardcode a path.

**Verify:**
- Sweep is a no-op when the dir is absent (fresh install must not crash).
- Sweep never deletes a dir belonging to a live `uv` PID.

**Guard:** no recursive delete of anything outside the resolved uv cache dir. Assert the resolved
path is under the uv cache root before unlinking.

---

## Phase 4 — Sanitize the uvx child environment

**Implement:** `uvx --python 3.13` must not inherit a foreign Python (#3552).

- Strip `VIRTUAL_ENV`, `PYTHONHOME`, `PYTHONPATH`, `CONDA_PREFIX`, `CONDA_DEFAULT_ENV` from the env
  passed to the Chroma child.
- Apply at the single point where the child env is built — see `getUvxPreflightEnv` /
  `effectiveUvxEnv` (`ChromaMcpManager.ts` and `src/services/worker/dependency-preflight.ts:75`).
  These are two parallel implementations; sanitize both or unify them (DRY — prefer unify).

**Verify:**
- Unit test asserting the built env object has none of those keys, given a polluted `process.env`.

---

## Phase 5 — Make Windows CI actually prove it (THE deliverable)

This is why these bugs keep shipping: `.github/workflows/windows.yml` is **build-only**
(`runs-on: windows-2022`, steps = install → build → one Bun resolver test). It never spawns Chroma.
Without this phase the PR is unverifiable — we are on macOS and cannot test Windows locally.

**Implement:** add a Windows job that:
1. Installs uv on the runner (PowerShell installer, same as `setup-runtime.ts:200`).
2. Spawns the real chroma-mcp via the production code path.
3. Round-trips one document: create collection → add → query → assert the result comes back.
4. Shuts the worker down.
5. **Asserts zero orphans**: no `chroma-mcp`, `uv.exe`, or `python.exe` descendants remain
   (`tasklist` / `Get-CimInstance Win32_Process` filtered by parent chain).
6. **Asserts no temp leak**: `builds-v0/.tmp*` count did not grow.

Steps 5 and 6 are the regression gates — they are the whole point.

**Verify:** the job must FAIL on `main` (proving it catches the bug) and PASS with phases 1-4 applied.
Demonstrate this in the PR description. If it passes on `main`, the test is wrong — fix the test.

---

## Phase 6 — PR + babysit

- Branch `fix/chroma-windows-process-tree` off current `main`.
- PR body must state: root cause, the 7 kill sites, the CI proof (fails-on-main / passes-with-fix),
  and which community PRs this supersedes or overlaps.
- **Overlap disclosure (verified via `gh`):** `ChromaMcpManager.ts` is edited by 4 open PRs —
  #3541 (uv grace period), #3567 (env sanitization), #3286 (Job Object), #3292 (broad recovery).
  None reference each other. This PR covers the #3541 and #3567 ground with a shared helper instead
  of four independent edits. Credit them explicitly in the PR body.
  Related open: #3309 (socket inheritance, currently CONFLICTING/DIRTY), #3416 (port rebind),
  #3529 (windowsHide), #3321 (where.exe PATH).
- Babysit: watch CI, address review comments, re-run until green and mergeable.

## Out of scope (state plainly in the PR, do not silently drop)

- Bash-only hooks on native Windows (`plugin/hooks/hooks.json` `"shell": "bash"`) — belongs to plan-master #3605.
- `tree-sitter.exe` lookup miss (`src/services/smart-file-read/parser.ts:362`) — real MAJOR bug, separate PR.
- `~\` tilde expansion (`src/shared/paths.ts:32`) — real MAJOR bug, separate PR.
- Case-sensitive path containment checks (P5, P6); `/dev/null` vs `NUL` (P3, P4) — MINOR.
- Reconciling the other 31 open Windows/Chroma PRs.
