# Worker Executable Implementation Plan

## Context
Replace runtime Bun dependency for worker service by compiling to platform-specific executables at install-time.

**Key Insight**: smart-install.js has access to `src/services/worker-service.ts` because the entire repo is installed to `~/.claude/plugins/marketplaces/thedotmack/`

## Phase 1: Implement Executable Compilation in smart-install.js

**Goal**: Add `buildWorkerExecutable()` function that compiles worker from source at install-time

**Tasks**:
1. Read `scripts/smart-install.js` to understand current structure
2. Add `buildWorkerExecutable()` function that:
   - Detects platform (Windows/macOS/Linux) and architecture
   - Checks if executable already exists and is current version (via `.worker-binary-version` marker)
   - Compiles `src/services/worker-service.ts` using `bun build --compile`
   - Outputs to `plugin/scripts/worker-service` (or `.exe` on Windows)
   - Creates version marker file
3. Call `buildWorkerExecutable()` from main smart-install flow
4. Test compilation on current platform

**Platform targets**:
- Windows: `bun-windows-x64`
- macOS ARM: `bun-darwin-arm64`
- macOS Intel: `bun-darwin-x64`
- Linux: `bun-linux-x64`

**Output location**: `plugin/scripts/worker-service[.exe]`

**Source location**: `src/services/worker-service.ts`

## Phase 2: Update hooks.json Configuration

**Goal**: Make hooks reference compiled executable instead of `bun worker-service.cjs`

**Tasks**:
1. Read `plugin/hooks/hooks.json`
2. Find all references to worker service execution
3. Replace `bun plugin/scripts/worker-service.cjs` with `plugin/scripts/worker-service`
4. Remove `.cjs` references, let OS handle `.exe` suffix on Windows

## Phase 3: Update .gitignore

**Goal**: Ignore compiled executables

**Tasks**:
1. Add entries:
   - `plugin/scripts/worker-service`
   - `plugin/scripts/worker-service.exe`
   - `.worker-binary-version`

## Phase 4: Test End-to-End

**Goal**: Verify executable works in real scenario

**Tasks**:
1. Run `npm run build-and-sync` (local dev still uses .cjs, that's fine)
2. Manually trigger smart-install logic to test executable compilation
3. Verify executable starts and handles requests
4. Test restart/stop commands

## Phase 5: Clean Up (Optional)

**Goal**: Remove deprecated files if any

**Tasks**:
- Review if `plugin/scripts/worker-cli.js` is still needed (probably deprecated)
- Remove if confirmed unused

## Notes

- **DON'T touch build-hooks.js** - it's for local dev and can keep building .cjs
- smart-install.js does the install-time compilation
- Executables are platform-specific and built locally, never committed to git
