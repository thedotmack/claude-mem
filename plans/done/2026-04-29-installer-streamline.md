# Installer Streamline — Eliminate 30s Silent Dead Air

**Goal:** Move all heavy install work (Bun/uv install, `bun install` in plugin cache) into the `npx claude-mem install` flow with a visible spinner. Make hooks runtime-only — never installers.

**Net effect:**
- `smart-install.js` runs in normal Claude Code lifecycle: 3 → 0 (or 1 via `npx claude-mem repair` after `claude plugin update`)
- 30s silent dead air → visible spinner during `npx`
- `npx claude-mem repair` becomes the canonical recovery entry point
- ~420 lines of code deleted (smart-install.js × 2 + tests + docs)

**Out of scope:** `bun-runner.js` deletion (independent rework with Windows/stdin verification needs — ship later).

---

## Phase 0 — Documentation Discovery (already complete)

These facts came from a discovery agent + direct file reads. Each implementation phase below cites them by line number; do not re-derive.

### Allowed APIs / patterns to copy

| Item | Location | What to copy |
|---|---|---|
| NPX command dispatcher | `src/npx-cli/index.ts:39–141` | Manual `switch (command)` on `process.argv.slice(2)`. Each case dynamic-imports its handler. |
| `install` case (template for `repair`) | `src/npx-cli/index.ts:46–52` | `const { runInstallCommand } = await import('./commands/install.js'); await runInstallCommand({ ide: ideValue });` |
| Plugin cache dir helper | `src/npx-cli/utils/paths.ts:32–34` | `pluginCacheDirectory(version)` → `~/.claude/plugins/cache/thedotmack/claude-mem/{version}/` |
| `.install-version` marker readers | `src/services/context/ContextBuilder.ts:36,45` and `src/services/worker/BranchManager.ts:173,228` | These read/delete the marker. Marker schema (`{ version, bun, uv, installedAt }`) MUST be preserved. |
| `clack` task pattern | `src/npx-cli/commands/install.ts:604–664` | `runTasks([{ title, task: async (message) => { … return 'Done OK' } }])` |

### Anti-patterns / API methods that DO NOT exist (avoid inventing)

- There is no existing `version-check.js` helper in `plugin/scripts/`. Phase 4 must create it.
- `package.json#files` already globs `plugin/scripts/*.js` (line 50), so deleting `plugin/scripts/smart-install.js` requires no `package.json` change.
- `scripts/smart-install.js` and `plugin/scripts/smart-install.js` are **both source files** kept in sync manually — there is no build step that copies one to the other. Both must be deleted in Phase 5.
- `runSmartInstall()` (install.ts:325–345) shells `node smart-install.js`. After Phase 1 you can call the new module directly — do NOT shell out.
- The `claude plugin install` exec at install.ts:113 has **only one caller** in the entire repo. Safe to remove.

### File inventory used by this plan

| File | Lines | Disposition |
|---|---|---|
| `src/npx-cli/commands/install.ts` | 761 | Edited heavily (Phase 2) |
| `src/npx-cli/index.ts` | 147 | One case added (Phase 3) |
| `plugin/hooks/hooks.json` | 93 | Setup hook command rewritten, SessionStart smart-install entry deleted (Phase 4) |
| `scripts/smart-install.js` | 264 | DELETED (Phase 5) |
| `plugin/scripts/smart-install.js` | ≈264 | DELETED (Phase 5) |
| `tests/smart-install.test.ts` | 310 | DELETED (Phase 5) |
| `tests/plugin-scripts-line-endings.test.ts` | 33 | One array entry removed (Phase 5) |
| `plugin/scripts/version-check.js` | NEW | CREATED (Phase 4) |
| `src/npx-cli/install/setup-runtime.ts` | NEW | CREATED (Phase 1) |
| Docs (`docs/public/*.mdx`, `docs/architecture-overview.md`) | misc | Light edit (Phase 6) |

---

## Phase 1 — Create `src/npx-cli/install/setup-runtime.ts`

**What to implement:** Port the smart-install.js logic to a TypeScript module that takes a target directory parameter (so it can install into the plugin cache dir, not just the marketplace dir). Three exported functions plus internal helpers.

**File to create:** `src/npx-cli/install/setup-runtime.ts`

**API surface (these names are used by Phase 2 and Phase 3 — do not rename):**

```ts
export async function ensureBun(): Promise<{ bunPath: string; version: string }>;
export async function ensureUv(): Promise<{ uvPath: string; version: string }>;
export async function installPluginDependencies(targetDir: string, bunPath: string): Promise<void>;
export function readInstallMarker(targetDir: string): { version: string; bun?: string; uv?: string; installedAt?: string } | null;
export function writeInstallMarker(targetDir: string, version: string, bunVersion: string, uvVersion: string): void;
export function isInstallCurrent(targetDir: string, expectedVersion: string): boolean;
```

**Reference implementation to port from:** `scripts/smart-install.js:1–264`. Map old → new:

| smart-install.js | setup-runtime.ts |
|---|---|
| `getBunPath()` / `isBunInstalled()` / `installBun()` (lines 42–152) | private helpers consumed by `ensureBun()` |
| `getUvPath()` / `isUvInstalled()` / `installUv()` (lines 77–194) | private helpers consumed by `ensureUv()` |
| `needsInstall()` (lines 196–205) | `isInstallCurrent()` + `readInstallMarker()` |
| `installDeps()` (lines 207–226) | `installPluginDependencies(targetDir, bunPath)` — accepts target dir as parameter |
| `verifyCriticalModules()` (lines 228–246) | private helper called inside `installPluginDependencies` |
| `MARKER` constant (line 32) | derive inside each function: `join(targetDir, '.install-version')` |
| Top-level `try { … }` (lines 248–264) | DELETE — caller orchestrates |

**Key behavioral differences from smart-install.js:**
- All functions take `targetDir` as a parameter (was a top-level `ROOT` constant).
- `ensureBun()` / `ensureUv()` return their version strings rather than logging — caller decides what to display.
- All functions throw on failure with descriptive `Error.message`. The `clack` `runTasks` wrapper in Phase 2 catches and renders.
- `console.error` calls in install/uninstall paths become structured: throw a single `Error` with the manual install instructions in the message body.
- Marker schema is preserved exactly (`{ version, bun, uv, installedAt }`) so existing readers in `ContextBuilder.ts:36` and `BranchManager.ts:173,228` continue to work.

**Verification checklist:**
- [ ] `bun build src/npx-cli/install/setup-runtime.ts --target=node` succeeds (or whatever the project's TS check command is — confirm via `package.json#scripts`)
- [ ] Marker file format is byte-identical to smart-install.js output (write a marker, diff against a marker written by the old code)
- [ ] `grep -rn "ROOT" src/npx-cli/install/setup-runtime.ts` returns nothing — no top-level constants

**Anti-pattern guards:**
- ❌ Do not invent a `bunInstall.ts` or `uvInstall.ts` split — keep all three in one file. They share helper code (paths, version probing).
- ❌ Do not import from `plugin/scripts/smart-install.js` — it gets deleted in Phase 5.
- ❌ Do not change the marker schema. Existing readers depend on `{ version }` field.

---

## Phase 2 — Rework `src/npx-cli/commands/install.ts`

**What to implement:** Drop `needsManualInstall` gating (always run copy/register/enable for every IDE), add a new unconditional "Setting up runtime" task before `setupIDEs`, neuter the claude-code `execSync` shell-out, delete `runSmartInstall()`, and add a `runRepairCommand()` export.

**File to edit:** `src/npx-cli/commands/install.ts`

### Edit 2A — Add import for setup-runtime (top of file, after other imports)

Insert after line 10 (after the `ensureWorkerStarted` import):

```ts
import {
  ensureBun,
  ensureUv,
  installPluginDependencies,
  writeInstallMarker,
  isInstallCurrent,
} from '../install/setup-runtime.js';
```

### Edit 2B — Delete `runSmartInstall()` function

**Delete lines 325–345** (the entire `function runSmartInstall(): boolean { … }` block).

### Edit 2C — Drop `needsManualInstall` gating, ungate the runTasks block

**Line 589** currently reads:
```ts
const needsManualInstall = selectedIDEs.some((id) => id !== 'claude-code');
```
**Delete line 589.** Update line 593's `if (needsManualInstall) {` to just `{` (or unwrap the block — preferred). The `runTasks` block at lines 604–664 now runs unconditionally.

**Within that runTasks block:** delete the "Setting up Bun and uv" task entry (lines 656–663). Replace its slot with the new "Setting up runtime" task (Edit 2D).

### Edit 2D — Insert "Setting up runtime" task

Replace the deleted "Setting up Bun and uv" task (lines 656–663) with:

```ts
{
  title: 'Setting up runtime (first install can take ~30s)',
  task: async (message) => {
    message('Checking Bun…');
    const { version: bunVersion } = await ensureBun();
    message('Checking uv…');
    const { version: uvVersion } = await ensureUv();
    const cacheDir = pluginCacheDirectory(version);
    if (!isInstallCurrent(cacheDir, version)) {
      message('Installing plugin dependencies…');
      const { bunPath } = await ensureBun();
      await installPluginDependencies(cacheDir, bunPath);
      writeInstallMarker(cacheDir, version, bunVersion, uvVersion);
    }
    return `Runtime ready (Bun ${bunVersion}, uv ${uvVersion}) ${pc.green('OK')}`;
  },
},
```

Place this AFTER the "Installing dependencies" (npm install) task — same ordering position the deleted task occupied.

### Edit 2E — Neuter the claude-code shell-out in `setupIDEs`

**Lines 110–123 currently:**
```ts
case 'claude-code': {
  try {
    execSync(
      'claude plugin marketplace add thedotmack/claude-mem && claude plugin install claude-mem',
      { stdio: 'inherit' },
    );
    log.success('Claude Code: plugin installed via CLI.');
  } catch (error: unknown) {
    console.error('[install] Claude Code plugin install error:', …);
    log.error('Claude Code: plugin install failed. Is `claude` CLI on your PATH?');
    failedIDEs.push(ideId);
  }
  break;
}
```

**Replace with:**
```ts
case 'claude-code': {
  log.success('Claude Code: plugin registered (cache + settings written by npx).');
  break;
}
```

The cache dir, marketplace registration, plugin registration, and `enabledPlugins` flag have all been written by the (now ungated) runTasks block before `setupIDEs` is called. `claude plugin install` was duplicating that work and triggering the silent Setup hook — both reasons to drop it.

### Edit 2F — Add `runRepairCommand()` export

After `runInstallCommand()` (after line 761), append:

```ts
export async function runRepairCommand(): Promise<void> {
  const version = readPluginVersion();
  const cacheDir = pluginCacheDirectory(version);

  if (isInteractive) {
    p.intro(pc.bgCyan(pc.black(' claude-mem repair ')));
  } else {
    console.log('claude-mem repair');
  }
  log.info(`Version: ${pc.cyan(version)}`);

  await runTasks([
    {
      title: 'Setting up runtime',
      task: async (message) => {
        message('Checking Bun…');
        const { version: bunVersion } = await ensureBun();
        message('Checking uv…');
        const { version: uvVersion } = await ensureUv();
        message('Reinstalling plugin dependencies…');
        const { bunPath } = await ensureBun();
        await installPluginDependencies(cacheDir, bunPath);
        writeInstallMarker(cacheDir, version, bunVersion, uvVersion);
        return `Runtime ready (Bun ${bunVersion}, uv ${uvVersion}) ${pc.green('OK')}`;
      },
    },
  ]);

  if (isInteractive) {
    p.outro(pc.green('claude-mem repair complete.'));
  } else {
    console.log('claude-mem repair complete.');
  }
}
```

`runRepairCommand` always runs the install (no `isInstallCurrent` short-circuit) — the user invoked `repair` because something is wrong, so don't gate on the marker.

**Verification checklist:**
- [ ] `grep -n "needsManualInstall" src/npx-cli/commands/install.ts` returns nothing
- [ ] `grep -n "runSmartInstall" src/npx-cli/commands/install.ts` returns nothing
- [ ] `grep -n "claude plugin install" src/npx-cli/commands/install.ts` returns nothing
- [ ] `grep -n "claude plugin marketplace add" src/npx-cli/commands/install.ts` returns nothing
- [ ] `runRepairCommand` is exported and TypeScript compiles
- [ ] `runInstallCommand` still exports the same `InstallOptions` shape (Phase 3 needs it untouched)

**Anti-pattern guards:**
- ❌ Do not delete `runNpmInstallInMarketplace()` — it's still needed for the marketplace dir copy step (other IDEs use that dir).
- ❌ Do not delete `copyPluginToMarketplace()` — non-claude-code IDEs read from `marketplaceDirectory()`.
- ❌ Do not delete the `if (alreadyInstalled)` overwrite-confirm block (lines 538–562) — user-facing UX preserved.

---

## Phase 3 — Wire `npx claude-mem repair`

**What to implement:** Add a `repair` case to the npx-cli command dispatcher.

**File to edit:** `src/npx-cli/index.ts`

### Edit 3A — Add `repair` case

In the `switch` block (lines 39–141), copy the `install` case pattern from lines 46–52 and adapt:

```ts
case 'repair': {
  const { runRepairCommand } = await import('./commands/install.js');
  await runRepairCommand();
  break;
}
```

Place it adjacent to the `install` case for discoverability.

### Edit 3B — Help text update (if applicable)

If `src/npx-cli/index.ts` has a help/usage block (look for `case 'help':` or default case), add `repair` to the list of commands with description: `Repair claude-mem runtime (re-runs Bun/uv setup and bun install in plugin cache).`

**Verification checklist:**
- [ ] `npx claude-mem repair --help` (after build) shows the command
- [ ] `npx claude-mem repair` runs `runRepairCommand` end to end on a corrupted cache (delete `.install-version` then run; should reinstall)
- [ ] Help/usage output (if it exists) lists `repair`

**Anti-pattern guards:**
- ❌ Do not add CLI flag parsing for `repair` (no flags needed).
- ❌ Do not duplicate the `runRepairCommand` body in `index.ts` — dynamic import only.

---

## Phase 4 — Strip smart-install from hooks; add `version-check.js`

**What to implement:** Replace the Setup hook's `node smart-install.js` call with a fast version-marker check. Delete the SessionStart smart-install hook entry entirely.

### Edit 4A — Create `plugin/scripts/version-check.js`

**File to create:** `plugin/scripts/version-check.js` (new)

```js
#!/usr/bin/env node
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

function resolveRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (existsSync(join(root, 'package.json'))) return root;
  }
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const candidate = dirname(scriptDir);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  } catch {}
  return null;
}

const ROOT = resolveRoot();
if (!ROOT) process.exit(0);

try {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  const markerPath = join(ROOT, '.install-version');
  if (!existsSync(markerPath)) {
    console.error('claude-mem: runtime not yet set up — run: npx claude-mem repair');
    process.exit(0);
  }
  const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
  if (marker.version !== pkg.version) {
    console.error(`claude-mem: upgraded to v${pkg.version} — run: npx claude-mem repair`);
  }
} catch {
  console.error('claude-mem: install marker unreadable — run: npx claude-mem repair');
}
process.exit(0);
```

**Behavior:**
- Sub-100ms (two synchronous file reads + JSON.parse + string compare).
- Always exits 0 (non-blocking) per the project's exit-code strategy in CLAUDE.md.
- Stderr message tells the user exactly what to run if a mismatch is detected.

### Edit 4B — Rewrite Setup hook command in `plugin/hooks/hooks.json`

**Lines 4–15** — replace the existing Setup hook command. Current command ends with `node "$_R/scripts/smart-install.js"`. Change it to `node "$_R/scripts/version-check.js"`. Everything before that (PATH export, `_R` resolution, cygpath) stays.

Concretely: the only change to line 11 is the trailing `smart-install.js` → `version-check.js`.

### Edit 4C — Delete SessionStart smart-install entry in `plugin/hooks/hooks.json`

**Lines 17–40** — the SessionStart hook array currently has THREE hook entries:
1. `node "$_R/scripts/smart-install.js"` (lines 21–26) — DELETE this entire entry
2. `node "$_R/scripts/bun-runner.js" "$_R/scripts/worker-service.cjs" start` (lines 27–32) — KEEP
3. `node "$_R/scripts/bun-runner.js" "$_R/scripts/worker-service.cjs" hook claude-code context` (lines 33–38) — KEEP

After edit, the SessionStart `hooks` array has 2 entries instead of 3.

**Verification checklist:**
- [ ] `cat plugin/hooks/hooks.json | jq '.hooks.Setup[0].hooks[0].command' | grep version-check.js` succeeds
- [ ] `cat plugin/hooks/hooks.json | jq '.hooks.SessionStart[0].hooks | length'` returns `2`
- [ ] `grep -c "smart-install" plugin/hooks/hooks.json` returns `0`
- [ ] `node plugin/scripts/version-check.js` exits 0 in <500ms (time it)
- [ ] On a fresh checkout (no `.install-version` marker), version-check stderr says "run: npx claude-mem repair"

**Anti-pattern guards:**
- ❌ Do not change the exit code from 0 — Windows Terminal tab management depends on it (CLAUDE.md exit-code strategy).
- ❌ Do not call out to Bun in version-check.js — Node-only, since this runs before we know Bun exists.
- ❌ Do not add fancy logic (semver compare, partial recovery). String equality is correct: any version mismatch warrants a repair.

---

## Phase 5 — Delete dead code

**What to implement:** Delete smart-install source files and update tests.

### Edit 5A — Delete files

```
rm scripts/smart-install.js
rm plugin/scripts/smart-install.js
rm tests/smart-install.test.ts
```

### Edit 5B — Trim `tests/plugin-scripts-line-endings.test.ts`

**Line 12 (the `SHEBANG_SCRIPTS` array):** remove the `'smart-install.js'` entry. Keep the rest of the array intact.

If the array becomes empty after the removal, also remove the entry — but per discovery report it has multiple entries, so just delete the one line.

### Edit 5C — Add new test for setup-runtime module (optional but recommended)

**File to create:** `tests/setup-runtime.test.ts`

Cover:
- `readInstallMarker` returns `null` for missing file
- `writeInstallMarker` produces a JSON object matching the smart-install.js schema (`{ version, bun, uv, installedAt }`)
- `isInstallCurrent` returns `false` for missing marker, `false` for version mismatch, `true` for match
- (Skip Bun/uv install integration tests — those need a sandbox and fall outside this PR's scope.)

If you skip this, document why in the PR description.

**Verification checklist:**
- [ ] `find . -name "smart-install*" -not -path "*/node_modules/*"` returns no results
- [ ] `grep -rn "smart-install" tests/` returns no results
- [ ] `npm test` (or whatever the project uses) passes
- [ ] If `tests/setup-runtime.test.ts` was added, it passes

**Anti-pattern guards:**
- ❌ Do not delete `tests/plugin-scripts-line-endings.test.ts` entirely — it tests other scripts too.
- ❌ Do not delete `tests/bun-runner.test.ts` — bun-runner.js stays in this PR.

---

## Phase 6 — Update docs

**What to implement:** Sweep documentation to reflect the new install flow.

### Edit 6A — `docs/architecture-overview.md:36`

Update reference to smart-install. New copy: "On first install, `npx claude-mem install` sets up Bun and uv globally and runs `bun install` in the plugin cache. The Setup hook then runs a sub-100ms version check on every Claude Code startup; if the plugin was upgraded externally, the user is prompted to run `npx claude-mem repair`."

### Edit 6B — `docs/public/configuration.mdx:139,163` and `docs/public/development.mdx:42`

Replace any mention of smart-install behavior with the version-check + repair model. Two-sentence patches; preserve surrounding context.

### Edit 6C — `docs/public/hooks-architecture.mdx` (11 references)

This is the largest doc change. Walk each reference (lines 77, 103, 119, 127, 432, 695–696, 703 per discovery report). Update text describing the Setup hook to say it runs `version-check.js` (sub-100ms) instead of `smart-install.js`. Update SessionStart description to reflect 2 entries (worker start + context fetch) instead of 3.

### Edit 6D — `docs/public/architecture/` references (lines 149, 193)

Same pattern — replace smart-install lifecycle description with the npx-installer + version-check model.

### Edit 6E — Skip CHANGELOG

CLAUDE.md says: "No need to edit the changelog ever, it's generated automatically." Don't touch it.

### Edit 6F — Skip historical incident-report backfills

The old `docs/reports/` archive was removed during later cleanup. Do not recreate it as part of this installer work.

**Verification checklist:**
- [ ] `grep -rn "smart-install" docs/public/` returns no results
- [ ] `grep -rn "smart-install" docs/architecture-overview.md` returns no results
- [ ] (Optional) Render docs locally via Mintlify dev server and visually scan the architecture page

**Anti-pattern guards:**
- ❌ Do not recreate the removed `docs/reports/` archive from this plan.
- ❌ Do not edit CHANGELOG.md.

---

## Phase 7 — Build, test, manual verify

**What to implement:** End-to-end validation. This phase is run by the implementer before opening the PR.

### Edit 7A — Build

```bash
npm run build-and-sync
```

This must succeed. If TypeScript fails on the new `setup-runtime.ts`, fix in place.

### Edit 7B — Test suite

```bash
npm test
```

Must be green. Likely failures to anticipate:
- `plugin-scripts-line-endings.test.ts` if the `'smart-install.js'` entry was missed in Phase 5
- Any test that imports from `scripts/smart-install.js` (discovery report says only `tests/smart-install.test.ts`, which Phase 5 deletes)

### Edit 7C — Manual fresh-install verification

1. On a clean machine (or after `rm -rf ~/.claude/plugins/marketplaces/thedotmack ~/.claude/plugins/cache/thedotmack ~/.claude-mem`):
   ```bash
   npx claude-mem install
   ```
   Confirm:
   - Spinner says "Setting up runtime (first install can take ~30s)"
   - No silent dead air
   - Worker starts at the end
2. Open Claude Code in any project. Confirm:
   - Setup hook fires fast (<200ms total)
   - SessionStart fires fast (no smart-install delay)
   - No "claude plugin install" output
3. Simulate a stale install:
   ```bash
   rm ~/.claude/plugins/cache/thedotmack/claude-mem/<version>/.install-version
   ```
   Open a new Claude Code session. Confirm version-check.js prints the "run: npx claude-mem repair" message to stderr.
4. Run repair:
   ```bash
   npx claude-mem repair
   ```
   Confirm spinner runs through Bun/uv check + bun install + marker write, then exits clean.

### Edit 7D — Commit and open PR

Per the PR creation flow in the user's outer task. Don't auto-merge; the user wants a review loop.

**Verification checklist:**
- [ ] `npm run build-and-sync` exits 0
- [ ] `npm test` exits 0
- [ ] Manual fresh install completes with visible spinner, no silent dead air
- [ ] Setup hook fires <200ms after rebuild
- [ ] `npx claude-mem repair` runs end-to-end

**Anti-pattern guards:**
- ❌ Do not skip the manual verification — the whole point of this PR is UX (eliminating dead air). Type checks won't catch a regression.
- ❌ Do not bump the version — version bump is handled separately by the version-bump skill.

---

## Summary of file changes

| Type | Path | Phase |
|---|---|---|
| Created | `src/npx-cli/install/setup-runtime.ts` | 1 |
| Edited | `src/npx-cli/commands/install.ts` | 2 |
| Edited | `src/npx-cli/index.ts` | 3 |
| Created | `plugin/scripts/version-check.js` | 4 |
| Edited | `plugin/hooks/hooks.json` | 4 |
| Deleted | `scripts/smart-install.js` | 5 |
| Deleted | `plugin/scripts/smart-install.js` | 5 |
| Deleted | `tests/smart-install.test.ts` | 5 |
| Edited | `tests/plugin-scripts-line-endings.test.ts` | 5 |
| Created | `tests/setup-runtime.test.ts` (optional) | 5 |
| Edited | `docs/architecture-overview.md` | 6 |
| Edited | `docs/public/configuration.mdx` | 6 |
| Edited | `docs/public/development.mdx` | 6 |
| Edited | `docs/public/hooks-architecture.mdx` | 6 |
| Edited | `docs/public/architecture/*.md` | 6 |

Estimated diff: **+250 / −500 lines** (net deletion).
