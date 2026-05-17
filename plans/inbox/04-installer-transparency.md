# Installer Failure Transparency — Cross-IDE Matrix

**Goal:** Stop the universal installer (`npx claude-mem install`) from silently swallowing real failures and falsely reporting "installed successfully" on all 12 IDEs. Convert every error-suppression site to a single `installerError(severity, ctx)` decision point driven by an explicit taxonomy. Make `tree-sitter` ERESOLVE conflicts and missing `uv` fail loudly with platform-specific remediation. Add a 12-IDE × 4-failure-mode validation matrix and CI postinstall regression guards inspired by the v12.6.2 `tree-sitter-swift` fix.

**Net effect:**
- "Installation Complete" is only printed when every ABORT-level dependency was satisfied. Partial outcomes get a yellow "Installation Partial" headline with a remediation block.
- `runNpmInstallInMarketplace()` runs strict first; `--legacy-peer-deps` is only applied on a confirmed `ERESOLVE` token, with the fallback announced loudly.
- Missing `uv` after auto-install attempt = ABORT with platform-specific instructions surfaced as the primary message (not buried under a wrapped "version probe failed" line). When the user has opted out of vector search, downgrade to WARN_CONTINUE.
- Postinstall regression guard: any new transitive dep with `scripts.postinstall` or `scripts.install` that is not in an explicit allowlist fails the build, preventing a re-run of the v12.6.1 `tree-sitter-swift` hang.
- Cross-IDE test matrix: 12 IDEs × 4 scenarios (happy / ERESOLVE / missing uv / missing bun) = 48 cells, each asserting exit code, summary text, and remediation presence.

**Out of scope (defer to follow-up plans):**
- Replacing `bun-runner.js` (its own runtime concerns; tracked in `plans/2026-04-29-installer-streamline.md`).
- Re-architecting `bufferConsole` to a structured event stream (this plan only fixes the data loss; full streaming UX is later).
- Internationalizing the new remediation messages (English-only for now).
- Migrating `openclaw/install.sh` from bash to TypeScript (audit only; remediation is in-place hardening).

---

## Problem Statement (with line citations)

Concrete swallowed errors that exist today:

| # | File | Line(s) | Current behavior | Why it matters |
|---|---|---|---|---|
| 1 | `src/npx-cli/commands/install.ts` | 1126–1135 | Catches *every* `npm install` error, prints `console.warn`, returns the misleading task message `Dependencies may need manual install ⚠`. The surrounding install still ends with `installed successfully!`. | A genuine `ERESOLVE` (or any npm crash) becomes a yellow tip the user immediately ignores. |
| 2 | `src/npx-cli/commands/install.ts` | 565–581 | `runNpmInstallInMarketplace` always uses `npm install --omit=dev --legacy-peer-deps`. The flag papers over real peer conflicts unconditionally. | The next time a tree-sitter peer range tightens, `--legacy-peer-deps` will quietly install a broken tree, and we'll only see runtime failures. |
| 3 | `src/npx-cli/install/setup-runtime.ts` | 206–219 | If `getUvVersion()` returns null after auto-install, throws "uv installed but version probe failed." `runInstallCommand` does not wrap this with platform-specific instructions; the user sees the wrapped error during a clack spinner that may overwrite it. | Honors CLAUDE.md's "uv auto-installed if missing" promise on the happy path but degrades to a confusing one-liner on failure. |
| 4 | `src/npx-cli/commands/install.ts` | 163–169, 328–347 | Per-IDE failures push into `pendingErrors[]` via `bufferConsole` (lines 43–64). `installStatus` (line 1197) only reads `failedIDEs.length > 0`, so an IDE that throws *after* `bufferConsole` returns 0 is invisible. The summary line "Failed: …" is the only signal. | A single failed IDE produces a yellow note that scrolls off-screen above the green "installed successfully!" outro. |
| 5 | `src/npx-cli/commands/install.ts` | 1131 | `console.warn('[install] npm install error:', …)` — error is logged but not classified, retried, or surfaced in the summary. | Same root cause as #1: stderr disappears, exit code stays 0. |
| 6 | `src/npx-cli/commands/install.ts` | 1161–1166 | `disableClaudeAutoMemory` failures classified as "WARN_CONTINUE" today (correct severity), but the implementation is ad-hoc. | Inconsistent — every other catch in this file uses different logging shapes. |
| 7 | `openclaw/install.sh` | 36 occurrences of `2>/dev/null` / `\|\| true` (e.g. lines 169, 224–229, 251, 255, 289, 293, 405, 435, 471, 495, 572, 612, 631, 670, 1076, 1155, 1161, 1185) | Bash-level error suppression on curl/jq/find/health-check pipelines. Many are correct (best-effort probes), but several mask genuine install failures. | Some `\|\| true` patterns hide a missing `bun` or unwritable plugin dir. |
| 8 | `src/services/integrations/*.ts` | 50+ catch blocks across 7 files (Codex, Cursor, Gemini, OpenCode, OpenClaw, Windsurf, MCP) | Each integration installer has its own ad-hoc error handling. Errors return non-zero, are buffered by `bufferConsole`, then dropped. | The IDE matrix has 12 different failure UX paths. |
| 9 | `scripts/build-hooks.js` | Generates `plugin/package.json` with all tree-sitter deps and `trustedDependencies: ['tree-sitter-cli']`. No CI guard prevents adding a new package with `scripts.postinstall` outside this allowlist. | The exact root cause of v12.6.1 — re-runnable by anyone editing this file. |

### Reference incident (canonical learning)

`CHANGELOG.md:93–110` documents v12.6.1 → v12.6.2: PR #2300 moved 21 tree-sitter grammars from devDependencies to dependencies; `tree-sitter-swift`'s postinstall pulled a nested `tree-sitter-cli` that downloaded a Rust binary and SIGINT'd. **Lesson:** npm does not honor `trustedDependencies` (Bun-only). Any new transitive dep with a network postinstall can hang `npx claude-mem install`. Phase 7 turns this into a CI guard.

---

## Phase 0 — Documentation Discovery

Each implementation phase below cites these facts by line number; do not re-derive.

### Allowed APIs / patterns to copy

| Item | Location | What to copy |
|---|---|---|
| Existing clack `runTasks` / `bufferConsole` pattern | `src/npx-cli/commands/install.ts:32–64` | Tasks return a string; orchestrator handles spinner. Reuse, but route every error through `installerError`. |
| `describeExecError` (stdout/stderr extractor) | `src/npx-cli/install/setup-runtime.ts:100–112` | Already canonical for child_process errors. Move to a shared module. |
| Marker write pattern for partial state | `src/npx-cli/install/setup-runtime.ts:262–275` | Use the same JSON shape (`{ severity, component, phase, cause, …}`) for the new `~/.claude-mem/last-install-error.json`. |
| Plugin-cache resolution | `src/npx-cli/utils/paths.ts` (`pluginCacheDirectory`, `marketplaceDirectory`) | All path resolution must honor `CLAUDE_MEM_DATA_DIR`; reuse instead of inventing. |
| Existing IDE list (canonical 12) | `src/npx-cli/commands/ide-detection.ts:40–129` | claude-code, gemini-cli, opencode, openclaw, windsurf, codex-cli, cursor, copilot-cli, antigravity, goose, roo-code, warp. |
| `trustedDependencies` allowlist (postinstall guard) | `scripts/build-hooks.js:106–108` and root `package.json:190–202` | The pattern Phase 7 enforces. |
| Existing install tests (extend, don't replace) | `tests/install-non-tty.test.ts`, `tests/setup-runtime.test.ts`, `tests/install-disable-auto-memory.test.ts` | Same harness shape (mocked spawn, isolated TMPDIR HOME). |
| Docker harness (clean Linux) | `Dockerfile.test-installer` | Already supports running install with no bun/uv preinstalled. Phase 6 forks this for the matrix runner. |
| CLAUDE.md exit-code contract | `CLAUDE.md` "Exit Code Strategy" section | Hooks: exit 0 = success, 1 = non-blocking, 2 = blocking. Installer is NOT a hook — it can exit 1 or 2 for ABORT. Phase 8 cross-references. |
| Prior plan format | `plans/2026-04-29-installer-streamline.md`, `plans/2026-04-30-onboarding-ux-overhaul.md` | Phased layout, file inventory, anti-patterns table. |
| v12.6.2 incident text | `CHANGELOG.md:93–110` | Phase 7 quotes this verbatim in code comments. |

### External facts (cited)

| Topic | Source / canonical reference | Key fact |
|---|---|---|
| npm `ERESOLVE` semantics | `npm install` docs (npm v10+) and npm RFC 0023 | `ERESOLVE` is emitted on stderr with a deterministic prefix `npm error code ERESOLVE` followed by `While resolving:` block. `--legacy-peer-deps` skips peer-dep resolution; `--force` accepts conflicting trees. They are NOT equivalent — `--force` is more aggressive and is *not* what we want. |
| Bun install errors | `bun install` source / docs | Stderr lines start with `error:`. A peer-dep violation prints `error: package "X" has unmet peer "Y"`. A network failure prints `error: failed to resolve`. |
| uv install script return codes | `https://astral.sh/uv/install.sh` | Exits 0 on success even when binary lands in a non-PATH dir (e.g. `~/.local/bin` not yet on `PATH`). The version probe must check `UV_COMMON_PATHS` after the script runs. |
| Claude Code hook exit-code contract | `CLAUDE.md` "Exit Code Strategy" | Worker/hook errors exit 0 (Windows Terminal hygiene). The `npx claude-mem install` CLI is NOT a hook and is allowed to exit non-zero on ABORT. |

### Anti-patterns / API methods that DO NOT exist (avoid inventing)

- There is **no** central `installerError` function today. Phase 3 must create it. Do not reach for a non-existent helper.
- `--force` is **not** a substitute for `--legacy-peer-deps`. Phase 4 must not "upgrade" the fallback to `--force` — that masks more than ERESOLVE.
- npm has **no** `--no-postinstall` flag at the CLI level. The correct flag is `--ignore-scripts`. Don't invent.
- Bun's `trustedDependencies` is **not** honored by npm. Do not assume the same allowlist works for both. Phase 7 enforces a separate npm-level guard.
- `process.exitCode = 1` (line 1324 of install.ts) **does not** abort an in-flight `await` chain. Phase 3's `InstallAbortError` must throw, not just set `exitCode`.
- The `bufferConsole` wrapper (install.ts:43–64) **swallows** stderr inside the buffer; do not assume stderr ever reaches the terminal in non-interactive mode unless explicitly flushed.
- `clack`'s `p.spinner()` *overwrites* the line on `.stop()`. Errors emitted via `console.warn` during a spinner are lost. Phase 3's WARN_CONTINUE must enqueue to a summary list, not log live.
- `ensureUv()` already throws on failure — but the throw is caught one level up by clack's task runner, which displays the message in a single line. Do not assume the user reads it; Phase 5 must add an explicit ABORT block.
- The `install/public/install.sh` and `install/public/installer.js` files are **already deprecated stubs** (verified — both just print "use npx claude-mem install"). Don't waste audit time on them.
- `openclaw/install.sh` is the active shell installer (1653 lines). It has its own bash-level audit in Phase 1.

### File inventory

| File | Lines | Disposition |
|---|---|---|
| `src/npx-cli/commands/install.ts` | 1371 | Edited heavily (Phase 1, 3, 4, 5) |
| `src/npx-cli/install/setup-runtime.ts` | 288 | Edited (Phase 5, 7) |
| `src/npx-cli/install/error-taxonomy.ts` | NEW | CREATED (Phase 2) |
| `src/npx-cli/install/error-reporter.ts` | NEW | CREATED (Phase 3) |
| `src/services/integrations/CodexCliInstaller.ts` | ~360 | Edited (Phase 3) — every catch routed to `installerError` |
| `src/services/integrations/CursorHooksInstaller.ts` | ~530 | Edited (Phase 3) |
| `src/services/integrations/GeminiCliHooksInstaller.ts` | ~310 | Edited (Phase 3) |
| `src/services/integrations/OpenCodeInstaller.ts` | ~250 | Edited (Phase 3) |
| `src/services/integrations/OpenClawInstaller.ts` | ~260 | Edited (Phase 3) |
| `src/services/integrations/WindsurfHooksInstaller.ts` | ~395 | Edited (Phase 3) |
| `src/services/integrations/McpIntegrations.ts` | ~220 | Edited (Phase 3) |
| `openclaw/install.sh` | 1653 | Audited and selectively hardened (Phase 1) |
| `scripts/build-hooks.js` | ~250 | Edited (Phase 7) — postinstall allowlist guard |
| `scripts/check-postinstall-allowlist.js` | NEW | CREATED (Phase 7) — pre-publish CI script |
| `tests/install-error-matrix.test.ts` | NEW | CREATED (Phase 6) — 12 × 4 matrix |
| `tests/install-non-tty.test.ts` | 277 | Extended (Phase 6) |
| `tests/setup-runtime.test.ts` | 135 | Extended (Phase 5) |
| `Dockerfile.test-installer-matrix` | NEW | CREATED (Phase 6) |
| `docs/public/troubleshooting.mdx` | NEW or extended | Edited (Phase 8) |
| `CLAUDE.md` "Exit Code Strategy" | Existing | Edited (Phase 8) — cross-reference taxonomy |
| `CHANGELOG.md` | — | **DO NOT EDIT** — generated automatically per CLAUDE.md |

---

## Phase 1 — Audit every error-suppression pattern

**Goal:** Produce a definitive table of every `catch`, `|| true`, `2>/dev/null`, and `try {} catch {}` in installer paths. Every row gets a proposed Phase 2 classification (ABORT / FAIL_LOUD_PER_IDE / WARN_CONTINUE / SILENT_RETRY).

**Deliverable:** `plans/audit-installer-errors.csv` (committed alongside this plan), with columns:
`file, line, kind (catch | bash-or-true | bash-redirect), current_behavior, proposed_severity, proposed_remediation_text, notes`.

### What to audit (exact greps)

Run these greps from repo root and turn every hit into a row:

```bash
# TS catch blocks
grep -nE 'catch\s*(\(|\{)' src/npx-cli/ src/services/integrations/ -r

# TS empty catch
grep -nB1 'catch\s*\{\s*\}' src/npx-cli/ src/services/integrations/ -r

# TS console.warn after caught error
grep -nE 'catch.*\{' src/npx-cli/ src/services/integrations/ -r -A 3 | grep -A 0 'console\.warn\|log\.warn'

# Shell silent failures
grep -nE '\|\| true|2>/dev/null|2>&1.*\|\|' openclaw/install.sh

# Build / sync scripts
grep -nE 'catch|process\.exit\(0\)' scripts/build-hooks.js scripts/sync-marketplace.cjs

# Plugin hooks
grep -nE 'catch|exit 0' plugin/scripts/version-check.js plugin/scripts/bun-runner.js
```

### Known counts (from the initial audit baked into this plan)

- `src/npx-cli/commands/install.ts`: **14** catch blocks (lines 387, 393, 406, 455, 596, 613, 631, 725, 980, 1056, 1131, 1161, 1243, 1252).
- `src/npx-cli/install/setup-runtime.ts`: **5** catch blocks (lines 38, 60, 73, 95, 233).
- `src/services/integrations/CursorHooksInstaller.ts`: **8** catch blocks.
- `src/services/integrations/CodexCliInstaller.ts`: **8** catch blocks.
- `src/services/integrations/WindsurfHooksInstaller.ts`: **9** catch blocks.
- `src/services/integrations/OpenCodeInstaller.ts`: **8** catch blocks.
- `src/services/integrations/OpenClawInstaller.ts`: **4** catch blocks.
- `src/services/integrations/GeminiCliHooksInstaller.ts`: **4** catch blocks.
- `src/services/integrations/McpIntegrations.ts`: **2** catch blocks.
- `scripts/sync-marketplace.cjs`: **6** catch blocks (line 28, 75, 90, 101, 111, 188, 220).
- `scripts/build-hooks.js`: **1** catch block (line 422).
- `openclaw/install.sh`: **36** `|| true` / `2>/dev/null` patterns.

**Audit total ≈ 105 sites.** Each row in the CSV must end with a Phase 2 severity proposal.

### Verification checklist

- [ ] CSV row count ≥ 100 (matches grep counts above ± 5%).
- [ ] Every row has a non-empty `proposed_severity`.
- [ ] No row has `proposed_severity = SILENT` — that severity does not exist; the closest valid choice is SILENT_RETRY.
- [ ] CSV is committed at `plans/audit-installer-errors.csv` and referenced from this plan.

### Anti-pattern guards

- Do **not** classify "this catch logs a warning today" as "WARN_CONTINUE" automatically. Read each one and decide. Some are genuine ABORTs masquerading as warnings.
- Do **not** classify any `2>/dev/null` on a `curl` health probe as ABORT — health probes are best-effort by design.
- Do **not** mark `installClaudeCode()` (line 416–462) failures as ABORT; the user explicitly opted into "install Claude Code now" and a failure should be FAIL_LOUD with manual remediation, not abort the install.

---

## Phase 2 — Define error taxonomy

**Goal:** Single source-of-truth typed enum + lookup table that classifies every installer error and prescribes a remediation string.

**File to create:** `src/npx-cli/install/error-taxonomy.ts`

### What to implement

Copy the structure from this skeleton (paraphrased; do not edit copy verbatim — adapt to actual TypeScript types in the repo):

```typescript
export enum ErrorSeverity {
  ABORT = 'ABORT',                       // exit 1, do not continue
  FAIL_LOUD_PER_IDE = 'FAIL_LOUD_PER_IDE', // exit 1 if all IDEs fail; otherwise partial summary
  WARN_CONTINUE = 'WARN_CONTINUE',         // print warning to end-of-install summary, continue
  SILENT_RETRY = 'SILENT_RETRY',           // retry once with backoff; escalate to WARN_CONTINUE
}

export interface ErrorCategory {
  id: string;                             // 'tree-sitter-eresolve', 'uv-missing', etc.
  severity: ErrorSeverity;
  match: (cause: unknown, ctx: { component: string; phase: string }) => boolean;
  remediation: (ctx: { platform: NodeJS.Platform; dataDir: string }) => string;
}

export const ERROR_CATEGORIES: ErrorCategory[] = [ /* see seed list below */ ];
```

### Seed taxonomy (the categories Phase 3 must implement)

| id | Severity | Match heuristic | Remediation summary |
|---|---|---|---|
| `bun-missing-after-install` | ABORT | `cause.message.includes('Bun executable not found')` | "Install Bun manually then re-run `npx claude-mem install`. macOS/Linux: `curl -fsSL https://bun.sh/install \| bash`. Windows: `winget install Oven-sh.Bun`." |
| `uv-missing-after-install` | ABORT (downgradable to WARN_CONTINUE if user opted out of vector search — see Phase 5) | `cause.message.includes('uv executable not found') \|\| cause.message.includes('uv installed but version probe failed')` | Platform-specific block from `installUv()` (lines 164–166) surfaced as primary message. |
| `tree-sitter-eresolve` | ABORT (after one retry with `--legacy-peer-deps`) | stderr contains literal `ERESOLVE` AND `--legacy-peer-deps` retry also failed | "ERESOLVE conflict in marketplace deps that --legacy-peer-deps could not resolve. Open an issue at https://github.com/thedotmack/claude-mem/issues with the conflicting peer ranges below: \<details\>." |
| `bun-install-network-fail` | SILENT_RETRY → WARN_CONTINUE | bun stderr `error: failed to resolve` for a known package on first try, repeated on retry | "bun install failed to resolve packages — check network connectivity and re-run `npx claude-mem install`. Cached packages in ~/.bun/install/cache will be reused." |
| `marketplace-dir-not-writable` | ABORT | `EACCES`/`EPERM` on `mkdirSync` / `writeFileSync` to `marketplaceDirectory()` | "Cannot write to marketplace directory `${dataDir}/.claude/plugins/...`. Check filesystem permissions or set CLAUDE_MEM_DATA_DIR to a writable path." |
| `plugin-json-corrupt` | ABORT | JSON.parse error on `plugin.json` | "Existing plugin.json is corrupt. Run `rm -rf ~/.claude/plugins/marketplaces/thedotmack` and re-run install." |
| `all-ides-failed` | ABORT | `failedIDEs.length === selectedIDEs.length && selectedIDEs.length > 0` | "Every selected IDE integration failed. See per-IDE errors above. Re-run with `--ide=<single>` to isolate." |
| `single-ide-failed` | FAIL_LOUD_PER_IDE | per-IDE installer non-zero exit | Echo first 20 lines of stderr + "Run `npx claude-mem install --ide=<name>` to retry just this IDE." |
| `mcp-integration-optional-fail` | WARN_CONTINUE | MCP installer non-zero AND IDE has alternate (non-MCP) integration path | "MCP setup for ${ide} failed; non-MCP features still work. Run `npx claude-mem mcp ${ide}` later." |
| `path-update-failed` | WARN_CONTINUE | `applyClaudeCodePathSetupIfNeeded` write fails | "Could not auto-update PATH in ${configFile}. Run manually: `echo '...' >> ${configFile}`." |
| `auto-memory-toggle-failed` | WARN_CONTINUE | `disableClaudeAutoMemory` throws | "Could not disable Claude Code auto-memory. Add `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` to ~/.claude/settings.json env block." |
| `version-probe-transient` | SILENT_RETRY → WARN_CONTINUE | bun/uv `--version` returns non-zero once | (no message on first try; on retry: "Could not verify ${tool} version — installation likely OK.") |
| `idempotent-json-merge-race` | SILENT_RETRY | `EEXIST`/`ENOENT` race during `writeJsonFileAtomic` retry | (silent; retry once.) |
| `child-process-timeout` | ABORT | spawnSync/execSync timeout (Phase 7's wrapper) | "${command} did not finish in ${timeout}s. Check network connectivity. If the host is slow, set CLAUDE_MEM_INSTALL_TIMEOUT_MS." |

### Verification checklist

- [ ] `error-taxonomy.ts` exports `ErrorSeverity`, `ErrorCategory`, `ERROR_CATEGORIES`.
- [ ] `ERROR_CATEGORIES` contains exactly the 14 rows above (extensions allowed).
- [ ] Every category's `remediation()` reads `dataDir` from a passed-in context, not from `process.env` directly (so multi-account setups work — see CLAUDE.md "Multi-account").
- [ ] `npm run typecheck` passes.

### Anti-pattern guards

- Do **not** include a `SILENT` severity (no remediation, no log). It does not exist in this taxonomy.
- Do **not** hard-code `~/.claude-mem` paths in remediation strings. Always interpolate `dataDir`.
- Do **not** add a category for "unknown error" with low severity. Unknown errors must default to ABORT until classified — fail loud is the safe default.

---

## Phase 3 — Implement `installerError(severity, ctx)` central handler

**Goal:** Single function every catch in installer paths must call. ABORTs throw a typed error; WARN_CONTINUEs enqueue to a summary list; SILENT_RETRYs re-invoke the wrapped action.

**Files to create:** `src/npx-cli/install/error-reporter.ts`

### What to implement

Skeleton (adapt to actual repo conventions; do not paste verbatim):

```typescript
export class InstallAbortError extends Error {
  readonly category: ErrorCategory;
  readonly remediation: string;
  readonly cause: unknown;
}

export interface ErrorContext {
  component: string;       // 'cursor', 'codex-cli', 'marketplace-npm-install', 'uv-install', etc.
  phase: string;           // 'setup-runtime', 'ide-install', 'marketplace-deps', etc.
  cause: unknown;
  remediation?: string;    // optional override; default from taxonomy
  eresolveDetails?: string; // raw stderr block to surface verbatim
}

export interface InstallSummary {
  warnings: Array<{ component: string; message: string; remediation: string }>;
  failedIDEs: string[];
  retryCount: Record<string, number>;
}

export function createInstallSummary(): InstallSummary;

export function installerError(
  severity: ErrorSeverity,
  ctx: ErrorContext,
  summary: InstallSummary
): never | void;

export async function withRetry<T>(
  action: () => Promise<T>,
  ctx: ErrorContext,
  summary: InstallSummary,
  maxAttempts: number = 2
): Promise<T>;

export function flushSummary(summary: InstallSummary, isInteractive: boolean): void;
```

### Behavior contract

| Severity | Behavior |
|---|---|
| `ABORT` | Write `~/.claude-mem/last-install-error.json` (path resolved via `pluginCacheDirectory` / `CLAUDE_MEM_DATA_DIR`), print remediation block to stderr (ANSI-colored only when `process.stderr.isTTY`), throw `InstallAbortError` with `cause` chained. The top-level `runInstallCommand` catches `InstallAbortError`, prints the headline "Installation Aborted: <category.id>", and `process.exit(1)`. |
| `FAIL_LOUD_PER_IDE` | Append to `summary.failedIDEs`, append a remediation block to `summary.warnings`. Continue. The top-level summary prints "Installation Partial" (red, not green). Exits 1 only if all IDEs fail (which then triggers `all-ides-failed` ABORT). |
| `WARN_CONTINUE` | Append to `summary.warnings`. Do **not** log live (clack spinner would clobber). `flushSummary` prints all warnings *after* the spinner / outro. |
| `SILENT_RETRY` | Increment `summary.retryCount[component]`. If count > 1, escalate to WARN_CONTINUE. Caller uses `withRetry` helper to wrap the action. |

### Refactor every audited catch

For each row in `plans/audit-installer-errors.csv` produced by Phase 1, replace the existing handler with a call to `installerError(severity, ctx, summary)`. Before/after example:

**Before (install.ts:1126–1135):**
```typescript
try {
  runNpmInstallInMarketplace();
  return `Dependencies installed ${pc.green('OK')}`;
} catch (error: unknown) {
  console.warn('[install] npm install error:', error instanceof Error ? error.message : String(error));
  return `Dependencies may need manual install ${pc.yellow('!')}`;
}
```

**After:**
```typescript
try {
  await runNpmInstallInMarketplace();  // Phase 4: now async w/ ERESOLVE handling
  return `Dependencies installed ${pc.green('OK')}`;
} catch (error: unknown) {
  installerError(ErrorSeverity.ABORT, {
    component: 'marketplace-npm-install',
    phase: 'marketplace-deps',
    cause: error,
  }, summary);
  // installerError throws — unreachable, but TypeScript needs a return
  return '';
}
```

### Rework `bufferConsole`

`src/npx-cli/commands/install.ts:43–64` currently swallows stderr into a string buffer and only surfaces it via `pendingErrors`. After this phase:
- A non-zero result from the wrapped function **must** preserve the stderr verbatim in the returned object (already does).
- `setupIDEs` (lines 328–347) **must** call `installerError(FAIL_LOUD_PER_IDE, …)` with `eresolveDetails: output.slice(0, 4000)` (first ~80 lines).
- The IDE summary block **must** show the exit code + first 20 lines of stderr verbatim, not a generic "X failed" line.

### Top-level wiring

In `runInstallCommand` (`install.ts:961`), thread `summary` through:
1. Create `summary` at the top.
2. Pass to `setupIDEs`, every `runTasks` task, `ensureBun`/`ensureUv`, `runNpmInstallInMarketplace`.
3. After all tasks, call `flushSummary(summary, isInteractive)` *before* the existing `p.note(summaryLines, installStatus)`.
4. Wrap the entire body in `try { … } catch (e) { if (e instanceof InstallAbortError) { … print + exit 1 } else throw }`.

### Verification checklist

- [ ] `grep -rE 'console\.warn\(.*install' src/npx-cli/ src/services/integrations/` returns 0 hits (all warnings go via `installerError`).
- [ ] `grep -rE 'catch.*\{[^}]*//.*ignore' src/npx-cli/ src/services/integrations/` returns 0 hits.
- [ ] Every catch in the Phase 1 CSV has been edited (verify by line-number cross-check).
- [ ] New unit test: ABORT throws `InstallAbortError`, WARN_CONTINUE appends to summary, SILENT_RETRY escalates after 2 attempts.
- [ ] `npm run typecheck` passes.
- [ ] `npm run test` passes (existing tests must keep passing — refactor must be behavior-preserving on the happy path).

### Anti-pattern guards

- Do **not** call `process.exit()` directly inside `installerError` — throw `InstallAbortError` so the top-level handler can flush the summary and print a coherent outro.
- Do **not** print warnings live during a clack spinner. Always enqueue to `summary.warnings` and flush at the end.
- Do **not** introduce a new global module. `summary` is an explicit parameter (testability).
- Do **not** silence the stack trace inside `InstallAbortError` — Node's default `stack` is fine; the user wants debug info.

---

## Phase 4 — tree-sitter ERESOLVE detection and explicit handling

**Goal:** Replace the unconditional `--legacy-peer-deps` with strict-first, fall-back-on-confirmed-ERESOLVE-only.

**File to edit:** `src/npx-cli/commands/install.ts:565–581`

### What to implement

Rewrite `runNpmInstallInMarketplace`:

```typescript
async function runNpmInstallInMarketplace(summary: InstallSummary): Promise<void> {
  const marketplaceDir = marketplaceDirectory();
  const packageJsonPath = join(marketplaceDir, 'package.json');
  if (!existsSync(packageJsonPath)) return;

  // Phase 7: --ignore-scripts is the default. The 12.6.2 incident proved that
  // any new transitive dep with a postinstall (e.g. tree-sitter-swift's
  // tree-sitter-cli download) can hang `npx claude-mem install`.
  const baseFlags = ['install', '--omit=dev', '--ignore-scripts'];

  const strictResult = await runNpmStrict(marketplaceDir, baseFlags);
  if (strictResult.code === 0) return;

  const stderr = strictResult.stderr ?? '';
  const isEresolve = /\bERESOLVE\b/.test(stderr) || /code ERESOLVE/.test(stderr);
  if (!isEresolve) {
    installerError(ErrorSeverity.ABORT, {
      component: 'marketplace-npm-install',
      phase: 'marketplace-deps',
      cause: new Error(`npm install failed (exit ${strictResult.code})`),
      eresolveDetails: stderr.slice(0, 4000),
    }, summary);
  }

  // Confirmed ERESOLVE — log loudly, attempt one fallback with --legacy-peer-deps.
  log.warn(`npm reported ERESOLVE peer-dependency conflict in marketplace deps; retrying with --legacy-peer-deps. Conflict details:`);
  log.warn(extractEresolveBlock(stderr));

  const legacyResult = await runNpmStrict(marketplaceDir, [...baseFlags, '--legacy-peer-deps']);
  if (legacyResult.code === 0) {
    summary.warnings.push({
      component: 'marketplace-npm-install',
      message: 'tree-sitter peer-dep ERESOLVE was resolved with --legacy-peer-deps fallback. This is benign for the marketplace install but should be re-evaluated when tree-sitter peer ranges change.',
      remediation: 'No action required.',
    });
    return;
  }

  installerError(ErrorSeverity.ABORT, {
    component: 'marketplace-npm-install',
    phase: 'marketplace-deps',
    cause: new Error(`npm install --legacy-peer-deps still failed (exit ${legacyResult.code})`),
    eresolveDetails: legacyResult.stderr?.slice(0, 4000),
  }, summary);
}
```

Helpers (extract to `src/npx-cli/install/npm-install-helper.ts`):
- `runNpmStrict(cwd, flags): Promise<{ code: number; stdout: string; stderr: string }>` — wraps `spawnSync` with timeout (Phase 7).
- `extractEresolveBlock(stderr): string` — pulls the `While resolving:` … `Conflicting peer dependency:` block for display.

### Bun install hardening (`installPluginDependencies` setup-runtime.ts:221–239)

Same pattern: wrap with `runBunStrict`, parse stderr for `error: failed to resolve` (network) vs `error: package "X" not found` (real missing dep). Network failures = SILENT_RETRY (one retry); real missing = ABORT.

### Verification checklist

- [ ] Existing test `tests/install-non-tty.test.ts` still passes (happy path).
- [ ] New unit test: simulated `npm install` exit 1 with `ERESOLVE` in stderr triggers fallback path.
- [ ] New unit test: simulated `npm install` exit 1 *without* `ERESOLVE` → immediate ABORT (no fallback).
- [ ] New unit test: both strict and legacy fail → ABORT with first-20-lines stderr in `eresolveDetails`.
- [ ] `grep -n "legacy-peer-deps" src/npx-cli/commands/install.ts` only appears inside `runNpmInstallInMarketplace`'s fallback path, never on first try.

### Anti-pattern guards

- Do **not** use `--force`. It accepts conflicting trees that `--legacy-peer-deps` would skip — different semantics.
- Do **not** retry the *strict* install — strict failure with no ERESOLVE means a real bug; retrying just hides it.
- Do **not** assume `ERESOLVE` is always present in lowercase. The npm format is uppercase; match `/\bERESOLVE\b/` not `/eresolve/i`.
- Do **not** parse stderr with a fragile regex; the simple `\bERESOLVE\b` token check is sufficient. Keep `extractEresolveBlock` defensive (return raw stderr if the block markers aren't found).

---

## Phase 5 — Missing-uv auto-detection and explicit failure

**Goal:** Honor CLAUDE.md's "uv auto-installed if missing" promise, but make the failure case loud and platform-specific. Downgrade to WARN_CONTINUE if the user opted out of vector search.

**File to edit:** `src/npx-cli/install/setup-runtime.ts:206–219`

### What to implement

Augment `ensureUv()`:

```typescript
export async function ensureUv(
  summary: InstallSummary,
  options: { allowVectorSearchOptOut?: boolean } = {}
): Promise<{ uvPath: string; version: string } | { uvPath: null; version: null }> {

  if (!isUvInstalled()) {
    installUv();   // existing logic — already throws platform-specific error on failure
  }

  // Post-install verification: PATH may not yet include ~/.local/bin in the
  // current shell. Re-probe UV_COMMON_PATHS explicitly.
  let uvPath = getUvPath();
  if (!uvPath) {
    // One more direct check of UV_COMMON_PATHS (in case install just wrote there).
    uvPath = UV_COMMON_PATHS.find(existsSync) ?? null;
  }

  if (!uvPath) {
    if (options.allowVectorSearchOptOut && userHasOptedOutOfVectorSearch()) {
      installerError(ErrorSeverity.WARN_CONTINUE, {
        component: 'uv-install',
        phase: 'setup-runtime',
        cause: new Error('uv binary not found after install; vector search disabled — continuing.'),
      }, summary);
      return { uvPath: null, version: null };
    }
    installerError(ErrorSeverity.ABORT, {
      component: 'uv-install',
      phase: 'setup-runtime',
      cause: new Error('uv binary not found after auto-install attempt'),
      remediation: platformUvRemediation(),  // surfaced as PRIMARY message
    }, summary);
  }

  const version = getUvVersion();
  if (!version) {
    // Probe failed once — retry with a 1-second sleep (sometimes new binaries need a moment).
    await new Promise((r) => setTimeout(r, 1000));
    const retried = getUvVersion();
    if (!retried) {
      installerError(ErrorSeverity.WARN_CONTINUE, {
        component: 'uv-version-probe',
        phase: 'setup-runtime',
        cause: new Error(`uv binary at ${uvPath} did not respond to --version after retry`),
      }, summary);
      return { uvPath, version: 'unknown' };
    }
    return { uvPath, version: retried };
  }
  return { uvPath, version };
}
```

Helpers:
- `userHasOptedOutOfVectorSearch()` — check `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)` for a `CLAUDE_MEM_DISABLE_VECTOR_SEARCH` setting (define if it does not exist; default false).
- `platformUvRemediation()` — extract the existing platform-specific block from `installUv` (lines 164–166) into a standalone exported function so both error paths share it.

### Apply same pattern to `ensureBun`

`ensureBun` (lines 191–204): same retry-after-1s, same `platformBunRemediation()`. Bun has no opt-out — bun is mandatory for hooks.

### Verification checklist

- [ ] `tests/setup-runtime.test.ts` extended: case where `installUv` succeeds but `getUvPath` still returns null (mock `existsSync` to lie) → ABORT with platform string.
- [ ] Test: same scenario but with vector search opted out → WARN_CONTINUE, `ensureUv` returns `{uvPath: null}`.
- [ ] Test: `getUvVersion` returns null on first call, version on second → returns `{ version: ...}` after retry, no warning.
- [ ] Test: `getUvVersion` returns null both times → WARN_CONTINUE, `version: 'unknown'`.

### Anti-pattern guards

- Do **not** call `installUv()` more than once per `ensureUv()` invocation. The auto-install attempt is one-shot; if it fails, ABORT with manual instructions. Do not loop.
- Do **not** silently swallow `installUv()`'s thrown error — its message already contains the platform-specific instructions; let them propagate as the ABORT remediation.
- Do **not** add a "press enter to continue" prompt on missing uv — non-interactive installs would hang.

---

## Phase 6 — Cross-IDE validation matrix (12 × 4 = 48 cells)

**Goal:** Every IDE × every failure mode asserts the right outcome.

**Files to create:**
- `tests/install-error-matrix.test.ts`
- `Dockerfile.test-installer-matrix`

### What to implement

Use `bun test`'s existing harness. For each of the 12 IDEs (`claude-code`, `gemini-cli`, `opencode`, `openclaw`, `windsurf`, `codex-cli`, `cursor`, `copilot-cli`, `antigravity`, `goose`, `roo-code`, `warp`) and for each of 4 scenarios, generate one test case:

| Scenario | Fixture / mock | Assertions |
|---|---|---|
| **Happy path** | Mock `spawnSync` so `bun --version`, `uv --version`, `npm install` all return 0. | exit 0, stdout contains `installed successfully`, summary `failedIDEs.length === 0`, `summary.warnings.length === 0`. |
| **tree-sitter ERESOLVE** | Mock `npm install` to exit 1 with `npm error code ERESOLVE` in stderr; mock `--legacy-peer-deps` retry to also exit 1. | exit 1, stderr contains `Installation Aborted: tree-sitter-eresolve`, stderr contains the conflicting peer ranges block, stdout does **not** contain `installed successfully`. |
| **Missing uv (auto-install fails)** | Mock `getUvPath` to return null; mock `installUv` to throw with `astral.sh 404`. | exit 1, stderr contains `Installation Aborted: uv-missing-after-install`, stderr contains platform-specific manual instructions (`curl -LsSf https://astral.sh/uv/install.sh \| sh` on Linux, `winget install astral-sh.uv` on Windows). |
| **Missing bun (auto-install fails)** | Mock `getBunPath` to return null; mock `installBun` to throw with `bun.sh 404`. | exit 1, stderr contains `Installation Aborted: bun-missing-after-install`, stderr contains platform-specific manual instructions. |

### Helpers needed

- `setupIsolatedHome(): { home: string; cleanup: () => void }` — creates a temp HOME, sets `CLAUDE_MEM_DATA_DIR=$home/.claude-mem`, `HOME=$home`, returns paths.
- `mockSpawnSync(matrix: Record<string, { code: number; stdout?: string; stderr?: string }>): void` — installs a mock that matches by command+arg.
- `runInstallSubprocess(ide: string, env: Record<string, string>): Promise<{ exitCode: number; stdout: string; stderr: string }>` — spawns `bun src/npx-cli/index.ts install --no-auto-start --ide=${ide}` with mocked env via a wrapper that injects the spawn mocks.

### Docker matrix runner

`Dockerfile.test-installer-matrix` extends `Dockerfile.test-installer`:
- Adds `RUN bun install` for the test deps.
- ENTRYPOINT runs `bun test tests/install-error-matrix.test.ts --reporter junit > /workspace/results.xml`.
- A `scripts/run-matrix-docker.sh` wrapper builds the image and runs it; CI invokes this on every PR that touches `src/npx-cli/`, `src/services/integrations/`, `scripts/build-hooks.js`, or `tests/install-*`.

### Verification checklist

- [ ] `bun test tests/install-error-matrix.test.ts` produces 48 test cases (12 × 4).
- [ ] Every case asserts at least: exit code, summary headline (`installed successfully` vs `Installation Aborted`), specific remediation substring, structured stderr.
- [ ] Docker matrix run completes in < 5 minutes.
- [ ] CI fails the PR if any of the 48 cells regresses.

### Anti-pattern guards

- Do **not** test against the real `~/.claude` — every case must use isolated TMPDIR HOME.
- Do **not** mock at the `installerError` level. Mock the underlying `spawnSync`/`existsSync` so the full pipeline is exercised.
- Do **not** skip the IDEs marked `coming soon` in the matrix — the install command can still be invoked with them. The matrix should assert that they exit cleanly with a "support coming soon" message and exit 0 (they are not failures).
- Do **not** rely on `process.env.HOME` mutations inside the test process — spawn a subprocess with the env override.

---

## Phase 7 — Postinstall regression guards (12.6.2 lesson)

**Goal:** Prevent another `tree-sitter-swift`-style hang. CI must fail when a new transitive dep with `scripts.postinstall` or `scripts.install` lands outside the explicit allowlist.

**Files to create / edit:**
- `scripts/check-postinstall-allowlist.js` (NEW, pre-publish CI)
- `package.json` `prepublishOnly` script (extend)
- `src/npx-cli/install/setup-runtime.ts` `installPluginDependencies` (timeout wrapper)

### CI guard

`scripts/check-postinstall-allowlist.js`:

```javascript
#!/usr/bin/env node
// Enforces: no transitive dep with scripts.postinstall|scripts.install may
// land in plugin/ or root node_modules unless allowlisted.
//
// Why: see CHANGELOG.md:93–110 (12.6.1 → 12.6.2 incident). npm does NOT honor
// trustedDependencies (Bun-only). Any new package with a network postinstall
// will hang `npx claude-mem install`.

const ALLOWLIST = new Set([
  'tree-sitter-cli',     // builds bindings; trusted because we explicitly need it
  'esbuild',             // platform-specific binary download is the package itself
]);

// Walk node_modules, parse each package.json, fail if scripts.postinstall or
// scripts.install is present and the package name is not in ALLOWLIST.
// Run against both root and plugin/ trees.
```

Wire into `prepublishOnly`: `"prepublishOnly": "npm run build && node scripts/check-postinstall-allowlist.js"`.

### Runtime `--ignore-scripts` default

`installPluginDependencies` (setup-runtime.ts:228–233): pass `--ignore-scripts` to `bun install`. Add comment:

```typescript
// Per CHANGELOG.md:93–110 (v12.6.1 → v12.6.2): tree-sitter-swift's
// nested tree-sitter-cli postinstall downloads a Rust binary and can
// hang the install. We allowlist the small set of packages that legitimately
// need postinstall (tree-sitter-cli, esbuild) via package.json
// trustedDependencies. Bun honors trustedDependencies; npm does not, which is
// why we additionally pass --ignore-scripts and why root devDependencies stay
// out of npx fetch (v12.6.2 fix).
execSync(`${bunCmd} install --ignore-scripts`, { ... });
```

`runNpmInstallInMarketplace` already has `--ignore-scripts` from Phase 4.

### Timeout wrapper

Every `execSync`/`spawnSync` install command must have an explicit timeout:

```typescript
const TIMEOUT_FIRST_RUN_MS = 5 * 60 * 1000;   // 5 min
const TIMEOUT_SUBSEQUENT_MS = 2 * 60 * 1000;  // 2 min
const installTimeout = process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS
  ? Number(process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS)
  : (isFirstRun ? TIMEOUT_FIRST_RUN_MS : TIMEOUT_SUBSEQUENT_MS);
```

`spawnSync` returns `signal === 'SIGTERM'` on timeout. Convert to ABORT with `child-process-timeout` category.

### Apply to all install spawns

Audit-driven list of spawns to wrap:
- `installBun` (line 122–127) — curl pipe-bash, 5 min timeout, allow override.
- `installUv` (line 152–155) — curl pipe-bash, 5 min timeout.
- `installPluginDependencies` bun install — 5 min first run, 2 min subsequent.
- `runNpmStrict` and `runNpmStrict --legacy-peer-deps` — 5 min first run, 2 min subsequent.
- `installClaudeCode` (line 426) — already has its own spinner, but no timeout. Add 5 min.

### Verification checklist

- [ ] `node scripts/check-postinstall-allowlist.js` against the current tree exits 0 (no offenders today).
- [ ] Adding `tree-sitter-haskell-evil` (hypothetical fixture) with a fake postinstall breaks CI.
- [ ] `grep -n "ignore-scripts" src/npx-cli/install/setup-runtime.ts src/npx-cli/commands/install.ts` shows the flag in both `bun install` and `npm install` paths.
- [ ] Test: `spawnSync` with `timeout: 100ms` on a slow command returns `signal: 'SIGTERM'` and triggers ABORT.

### Anti-pattern guards

- Do **not** auto-add packages to the allowlist when CI fails. Failing CI is the point — a human reviews each new postinstall.
- Do **not** add `tree-sitter-cli` to the allowlist twice (it already lives in `trustedDependencies` in package.json:190 and `scripts/build-hooks.js:106`). The new allowlist is just a CI-time guard, not a duplicate of trustedDependencies.
- Do **not** remove `--ignore-scripts` from `bun install` even though Bun honors `trustedDependencies` — the belt-and-suspenders is intentional.
- Do **not** make the timeout configurable per-IDE — one global `CLAUDE_MEM_INSTALL_TIMEOUT_MS` env var is sufficient.

---

## Phase 8 — Documentation and cross-references

**Goal:** Document the taxonomy and remediation map for end-users and contributors. Update CLAUDE.md to cross-reference.

**Files to edit / create:**
- `docs/public/troubleshooting.mdx` (CREATE or EXTEND if it exists)
- `CLAUDE.md` "Exit Code Strategy" section
- `plans/04-installer-transparency.md` (this file — already)

### What to write

`docs/public/troubleshooting.mdx`:
- Section "Installation errors": lists each `id` from the taxonomy table, the error message format, and the remediation. Markdown table mirroring Phase 2's seed taxonomy.
- Section "Reading the error": shows a sample stderr block and how to copy-paste the bottom block into a GitHub issue.
- Section "Debug": doc the `CLAUDE_MEM_INSTALL_TIMEOUT_MS` env var and `~/.claude-mem/last-install-error.json`.

`CLAUDE.md` "Exit Code Strategy" — append:

```markdown
**Installer exit codes** (note: installer is NOT a hook; it follows standard CLI exit semantics):

- **Exit 0**: install succeeded; "Installation Complete" headline; summary may include `WARN_CONTINUE` warnings.
- **Exit 1**: ABORT or partial-IDE failures. Headline is "Installation Aborted: \<category\>" or "Installation Partial". Structured cause written to `~/.claude-mem/last-install-error.json` (or `$CLAUDE_MEM_DATA_DIR/last-install-error.json`). See `src/npx-cli/install/error-taxonomy.ts` for the full category list.
```

`docs.json` (Mintlify nav): add a link to the new troubleshooting page.

### Verification checklist

- [ ] `troubleshooting.mdx` covers all 14 categories from Phase 2.
- [ ] CLAUDE.md cross-reference points to the right file.
- [ ] `docs.json` updated.
- [ ] **CHANGELOG.md is NOT edited** (auto-generated per CLAUDE.md's "No need to edit the changelog ever, it's generated automatically.").

### Anti-pattern guards

- Do **not** edit CHANGELOG.md.
- Do **not** add a "report this error to support" link to a non-existent endpoint. Use the GitHub issues URL from `package.json:25–27`.
- Do **not** localize the remediation strings yet — English-only for this phase.

---

## Phase 9 — Final verification

### Whole-system checks

- [ ] `npm run typecheck` passes (root + viewer).
- [ ] `npm run test` passes (all suites including the new matrix).
- [ ] `bun test tests/install-error-matrix.test.ts` produces 48 test cases, all green.
- [ ] Docker matrix runner (`scripts/run-matrix-docker.sh`) green on clean Linux.
- [ ] `npm run build-and-sync` completes without errors and the worker restarts cleanly.
- [ ] Manual test: `bun src/npx-cli/index.ts install --no-auto-start` on a fresh test home (`HOME=/tmp/test-home`) — should succeed and produce a clean summary.
- [ ] Manual test: same command after `mv ~/.bun /tmp/.bun-stash` (simulate missing bun) — should ABORT with platform-specific instructions.
- [ ] `grep -nE 'console\.warn\(' src/npx-cli/ src/services/integrations/` — should only show non-installer-error usage (e.g. `bug-report` script), no swallowed-error patterns.
- [ ] `grep -nE '\|\| true' openclaw/install.sh` — sites that should remain (best-effort probes) are documented; sites that should fail loud are converted to `\|\| { error "..."; exit 1; }`.

### Anti-pattern guards (sweep)

- [ ] No new `try {} catch {}` empty handlers introduced.
- [ ] No new `console.warn` in installer paths that bypass `installerError`.
- [ ] No use of `--force` anywhere in install scripts.
- [ ] No removal of `--ignore-scripts` from `bun install` or `npm install` calls.
- [ ] No edits to CHANGELOG.md.

### Rollback plan

If post-merge a real-world install regression appears:
1. Revert PR. Each phase is on a separate commit so partial revert is feasible.
2. The pre-existing `--legacy-peer-deps` unconditional behavior is preserved in git history at the line numbers cited in this plan.
3. The `~/.claude-mem/last-install-error.json` file written by `installerError` provides a reproducible diagnostic for any user who hits an ABORT — capture this in the rollback issue.

---

## Phase boundaries / ordering

Phases must execute in numerical order:
- Phase 0 → Phase 1: discovery before audit.
- Phase 2 (taxonomy) blocks Phase 3 (reporter uses the enum).
- Phase 3 (reporter) blocks Phase 4 / 5 (both call `installerError`).
- Phase 4 + 5 land independently after Phase 3.
- Phase 6 (matrix tests) needs 3, 4, 5 complete to assert correct behavior.
- Phase 7 (postinstall guards) can land any time after Phase 3 — independent.
- Phase 8 (docs) is last (documents what shipped).

Each phase is a separate commit (and each is a runnable mini-task in a fresh chat context).
