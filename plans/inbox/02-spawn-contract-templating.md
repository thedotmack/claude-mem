# Spawn-Contract Templating Ambiguity — Phased Fix Plan

**Root cause:** `${CLAUDE_PLUGIN_ROOT}` and similar placeholders are inconsistently treated across spawn boundaries. Some hosts substitute them at hook/MCP-spawn time, some shells expand them, some do neither (raw `${CLAUDE_PLUGIN_ROOT}` reaches the binary). Result: MCP servers fail to start; hook commands resolve to wrong paths; cross-IDE behavior diverges across the 12-IDE matrix.

**Net effect of this fix:** A single, documented canonical resolution rule per integration class; centralized template generators that produce the shell-defensive prelude and the absolute-path bake; build-time guardrails that prevent drift; documentation aligned with the canonical rule; and a validation matrix covering every (IDE × hook event × platform) combination.

**Out of scope:**
- Codex marketplace cache version-mismatch (covered by `plans/2026-05-06-codex-plugin-version-mismatch.md`).
- Any rework of `bun-runner.js`'s stdin handling (issue #2188 territory — separate concern).
- Pro-feature endpoints or worker port resolution (uses `CLAUDE_MEM_WORKER_PORT`, not `CLAUDE_PLUGIN_ROOT`; orthogonal).

---

## Phase 0 — Documentation Discovery

These facts came from direct file reads (grep + Read) of the working tree on 2026-05-07. Each implementation phase below cites them by line number; do not re-derive. **Confidence:** High for code; Medium for upstream IDE host docs (Phase 0 must verify those by web fetch in a fresh context).

### 0.1 Placeholder call sites — confirmed catalogue

| # | File | Lines | Substitution layer | Notes |
|---|---|---|---|---|
| 1 | `plugin/hooks/hooks.json` | 11, 24, 30, 42, 55, 68, 80 (every hook command) | Claude Code injects env var → bash expands `${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}` | 6 hook events. `shell: bash` set explicitly. |
| 2 | `plugin/hooks/codex-hooks.json` | 10, 15, 20, 32, 44, 56, 67 (every hook command) | Codex *should* inject env → sh expands. Adds extra PATH-resolution prelude. | 5 hook events (no `shell` field; sh assumed). |
| 3 | `.mcp.json` | 8 (single mcp-search command) | `sh -c "..."` arg expands `${VAR:-default}`. Build asserts byte-identical to #4. | Includes `$PWD/plugin`, `$PWD`, and `~/.codex/plugins/cache/...` fallbacks. |
| 4 | `plugin/.mcp.json` | 8 | Same as #3. | Bundled inside plugin; copy of #3. |
| 5 | `plugin/scripts/version-check.js` | 7–17 | Reads `process.env.CLAUDE_PLUGIN_ROOT`, then falls back to `dirname(fileURLToPath(import.meta.url))/..`. | Runtime resolution layer. |
| 6 | `plugin/scripts/bun-runner.js` | 11 (`RESOLVED_PLUGIN_ROOT`), 13–21 (`fixBrokenScriptPath`), 168 (diagnostic emit) | Reads `process.env.CLAUDE_PLUGIN_ROOT`, falls back to script dirname. `fixBrokenScriptPath` is a band-aid: when arg starts with `/scripts/` (i.e., raw unsubstituted `${CLAUDE_PLUGIN_ROOT}/scripts/X.cjs` came through as `/scripts/X.cjs`), it prepends `RESOLVED_PLUGIN_ROOT`. | Runtime resolution layer. |
| 7 | `src/services/integrations/CodexCliInstaller.ts` | 60–78 (`resolvePluginMarketplaceRoot`), 66–67 (env vars consulted) | Reads `process.env.CLAUDE_PLUGIN_ROOT`, then `process.env.PLUGIN_ROOT`, then `process.cwd()`, then script dirname. | Install-time only. |
| 8 | `src/services/integrations/CursorHooksInstaller.ts` | 84–110 (`findMcpServerPath`, `findWorkerServicePath`), 230–232 (`makeHookCommand`) | NONE — bakes absolute paths from `MARKETPLACE_ROOT` or `process.cwd()`. | Pure absolute-path bake. |
| 9 | `src/services/integrations/GeminiCliHooksInstaller.ts` | 46–60 (`buildHookCommand`) | NONE — bakes absolute `bunPath` and `workerServicePath`. | Pure absolute-path bake. |
| 10 | `src/services/integrations/WindsurfHooksInstaller.ts` | (uses `findBunPath`, `findWorkerServicePath` from CursorHooksInstaller) | NONE — bakes absolute paths. | Pure absolute-path bake. |
| 11 | `src/services/integrations/McpIntegrations.ts` | 16–21 (`buildMcpServerEntry`), 175–192 (Goose YAML builders) | NONE — bakes `process.execPath` (Node) + absolute `mcpServerPath`. | Pure absolute-path bake. Targets: copilot-cli, antigravity, goose, roo-code, warp. |
| 12 | `src/services/integrations/OpenCodeInstaller.ts` | 29–46 (`findBuiltPluginPath`) | NONE — copies `dist/opencode-plugin/index.js` to `~/.config/opencode/plugins/claude-mem.js`. | OpenCode runs JS in its own sandbox; no shell. |
| 13 | `src/integrations/opencode-plugin/index.ts` | 74–80 (`resolveWorkerPort`) | Uses `CLAUDE_MEM_WORKER_PORT` env (orthogonal to plugin-root scope). | No plugin-root templating. |
| 14 | `openclaw/install.sh` (1653 lines) | grep returns 0 hits for `CLAUDE_PLUGIN_ROOT` or `PLUGIN_ROOT`. Uses `${HOME}`, `${COLOR_*}`, etc. | N/A — OpenClaw configures via `configSchema` (`workerPort`, `workerHost`); no plugin-root templating. | Out of scope but documented for completeness. |
| 15 | `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json` | manifest fields | NONE — relative paths only (`./plugin`, `./.mcp.json`, `./hooks/codex-hooks.json`). | Resolved by host marketplace machinery. |
| 16 | `docs/public/hooks-architecture.mdx` lines 100, 176, 223, 283, 337, 604, 754 | code examples | DOCS — currently teach users raw `${CLAUDE_PLUGIN_ROOT}/scripts/...` syntax. | These examples drive third-party copy-paste; must align with canonical rule chosen in Phase 1. |
| 17 | `docs/public/configuration.mdx:142`, `docs/public/development.mdx:257`, `docs/public/architecture/hooks.mdx:196,204,208,215,223,230,237` | code examples | DOCS — same pattern as #16. | Same. |

### 0.2 Spawn-contract matrix — confirmed for sites we own

| Site | Spawned by | `${CLAUDE_PLUGIN_ROOT}` substituted by | Shell semantics |
|---|---|---|---|
| `plugin/hooks/hooks.json` | Claude Code hook runner | Claude Code injects env; bash expands `${VAR:-default}` | bash (`shell: bash`) |
| `plugin/hooks/codex-hooks.json` | Codex CLI hook runner | Codex *should* inject env; sh expands | sh (no `shell` field) |
| `.mcp.json` / `plugin/.mcp.json` | Claude Code / Codex MCP loader | `sh -c "..."` expands `${VAR:-default}` | `sh -c` with args[] |
| Cursor `hooks.json` / `mcp.json` | Cursor | NONE — installer bakes absolute paths | Native exec |
| Gemini `settings.json` hooks | Gemini CLI | NONE — installer bakes absolute paths | Native exec |
| Windsurf `hooks.json` | Windsurf | NONE — installer bakes absolute paths | Native exec |
| Copilot/Antigravity/Goose/Roo/Warp `mcp.json` | Each IDE's MCP loader | NONE — installer bakes absolute paths | Native exec |
| OpenCode plugin | OpenCode runtime | N/A — JS plugin, no shell | JS |
| OpenClaw plugin | OpenClaw gateway | N/A — settings via `configSchema` | JS |

### 0.3 Existing tests covering this scope

`tests/infrastructure/plugin-distribution.test.ts`:
- Lines 110–114: every hook command must contain `CLAUDE_PLUGIN_ROOT`.
- Lines 116–122: every hook command must contain `$_C/plugins/marketplaces/thedotmack/plugin` fallback (issue #1215).
- Lines 124–132: cache path must be tried BEFORE marketplace fallback (issue #1533).
- Lines 84–99: MCP launcher includes `.codex/plugins/cache/claude-mem-local/claude-mem` and `plugins/cache/thedotmack/claude-mem` fallbacks; root and bundled launchers stay synced.
- Lines 135–177: full shell-prelude assertions for `.mcp.json`, codex hooks, and claude hooks (`${CLAUDE_CONFIG_DIR:-$HOME/.claude}`, `_E="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"`, `while IFS= read -r _R`, `[ -f "$_Q/scripts/..." ]`, `command -v cygpath`, etc.).

`tests/plugin-version-check.test.ts:10`: exercises `CLAUDE_PLUGIN_ROOT: root` env injection at version-check time.

### 0.4 Existing build-time enforcement

`scripts/build-hooks.js`:
- Lines 392–396: byte-identical sync between `.mcp.json` and `plugin/.mcp.json`.
- Lines 397–403: MCP launcher must include codex cache and claude cache fallbacks.
- Lines 361–404: required-distribution-files check.
- Lines 381–386: codex hook event names validated against allowlist.
- Lines 387–391: `.agents/plugins/marketplace.json` source.path must be `./plugin`.

### 0.5 Existing utilities the plan will reuse

| Item | Location | Use |
|---|---|---|
| `CLAUDE_CONFIG_DIR` constant | `src/shared/paths.ts:41` | Used in shell template fallback as `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` |
| `MARKETPLACE_ROOT` constant | `src/shared/paths.ts:43` | Used by `findMcpServerPath`, `findWorkerServicePath` |
| `shell-quote` package | already in `plugin/package.json` deps (`scripts/build-hooks.js:101`) | Use `quote()` to escape literal shell tokens when building templates |
| `findBunPath()`, `findMcpServerPath()`, `findWorkerServicePath()` | `src/services/integrations/CursorHooksInstaller.ts:84–130` | Reused by Windsurf, Gemini, MCP-only installers — already a de-facto centralization point |

### 0.6 Documentation discovery still required (Phase 0 subagent task)

Before Phase 1 finalizes the canonical rule, deploy a Documentation Discovery subagent to confirm:

1. **Claude Code hook spec.** Does Claude Code documentation say `CLAUDE_PLUGIN_ROOT` is *guaranteed* to be set at hook spawn time? Or only when the hook is loaded from a plugin (vs. a user-level hook)? Source: https://docs.claude.com/claude-code/ — find the hook contract page.
2. **Codex CLI hook spec.** Same question for Codex CLI 0.128+. The codex-hooks template in this repo defends against the var being missing; confirm whether that's needed or paranoid. Source: codex CLI docs / `codex --help plugin`.
3. **Cursor hook contract.** Confirm that Cursor invokes hook commands via direct exec (no shell expansion). Today's installer assumes it. Source: https://docs.cursor.com/.
4. **Gemini CLI hook contract.** Same for Gemini.
5. **Windsurf hook contract.** Same for Windsurf.
6. **OpenCode plugin contract.** Confirm that OpenCode passes plugin-root information via the `OpenCodePluginContext.directory` field rather than env var. Source: `src/integrations/opencode-plugin/index.ts:11`.
7. **MCP server protocol.** Confirm that MCP server registration in IDE-owned `mcp.json` files (Cursor, Copilot, Antigravity, Goose, Roo, Warp) does not provide any `${VAR}` substitution — i.e., absolute paths are mandatory for those hosts. Source: Anthropic MCP docs.

**Subagent reporting contract** (per make-plan skill): each finding must cite (URL or file:line), include the exact contractual statement quoted, and flag any "this is implied not stated" assumptions.

### 0.7 Anti-patterns / API methods that DO NOT exist (avoid inventing)

- There is no existing centralized shell-template generator. Phase 2 must create it.
- There is no existing `getMcpServerAbsolutePath()` / `getBunAbsolutePath()` helper module shared across installers; each duplicates logic. Phase 3 must create it.
- The `bun-runner.js` `fixBrokenScriptPath()` helper IS the band-aid — it must NOT be deleted in this plan until Phase 5 verification confirms no remaining call site can leak a raw `/scripts/...` arg.
- `${CLAUDE_PLUGIN_ROOT}` is **never expanded** at JSON-parse time. Any code that reads `.mcp.json` or `hooks.json` directly will see the literal string `${CLAUDE_PLUGIN_ROOT}` unless it shells out to bash/sh. Don't write tests that assume otherwise.
- Manifest files (`plugin.json`, `marketplace.json`) **do not** support `${VAR}` substitution per Claude/Codex marketplace specs. Don't propose adding it.

---

## Phase 1 — Codify the canonical resolution rule

**What to implement:** Decision document + amendment to `CLAUDE.md`. Code follows in Phases 2–4.

### 1.1 The three options (recap)

(a) **Always pre-resolve to absolute path at install time.** Every hook/MCP entry contains a hard-coded `/Users/<user>/.claude/plugins/cache/.../scripts/X.cjs`. Pro: zero spawn-contract surface. Con: every claude-mem version bump invalidates baked paths in IDE configs the host doesn't own (Cursor, Gemini, Windsurf, MCP-only IDEs, OpenClaw).

(b) **Always rely on POSIX-shell defensive expansion.** Hook/MCP entries contain `_E="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"; _P=$(... fallback chain ...)`. Pro: zero re-install needed across upgrades. Con: requires POSIX shell available to the host (Windows native cmd.exe doesn't qualify; cygpath workaround already addresses Git-Bash/MSYS).

(c) **Double-resolve via wrapper script.** Hook/MCP entry is `node /known/path/wrapper.js <event>`; wrapper resolves real plugin root in JS. Pro: single resolution rule, trivially testable. Con: wrapper itself needs a known absolute path → falls back to (a) for the wrapper's own install location.

### 1.2 The decision (orchestrator's recommendation — confirm in Phase 0 subagent)

Adopt a **two-rule split** indexed by who owns the config file:

- **Rule A (host-managed shell-template):** sites where the host (Claude Code, Codex CLI) owns the config file (`hooks.json`, `codex-hooks.json`, `.mcp.json`, `plugin/.mcp.json`) and may rotate the cache directory on plugin upgrade. Use the POSIX-shell defensive expansion (option b).
- **Rule B (installer-managed bake):** sites where claude-mem's installer owns the config file (Cursor, Gemini, Windsurf, MCP-only IDEs). Use the absolute-path bake (option a). On `claude-mem` version bump, the installer re-bakes paths idempotently.
- **Rule C (runtime resolution):** `plugin/scripts/version-check.js` and `plugin/scripts/bun-runner.js` accept BOTH `CLAUDE_PLUGIN_ROOT` env AND the script's own `dirname(import.meta.url)/..`, in that order. This is already the case (lines 7–17 of version-check.js, line 11 of bun-runner.js); document it.

Rule C is non-negotiable: it's the safety net behind both Rule A and Rule B. The shell template (Rule A) ultimately invokes `node "$_P/scripts/bun-runner.js" "$_P/scripts/worker-service.cjs" hook ...` — `bun-runner.js` then re-resolves `RESOLVED_PLUGIN_ROOT` from its own dirname and is the last line of defense if `$_P` itself was wrong.

### 1.3 What to implement in Phase 1

Append to `CLAUDE.md` under a new `## Spawn-Contract Resolution` section (between `## Multi-account` and `## File Locations`):

```md
## Spawn-Contract Resolution

claude-mem integrations resolve `${CLAUDE_PLUGIN_ROOT}` (and equivalents) using one of three rules. Pick the rule by who owns the config file.

### Rule A — Host-managed shell-template (Claude Code, Codex CLI)

Sites: `plugin/hooks/hooks.json`, `plugin/hooks/codex-hooks.json`, `.mcp.json`, `plugin/.mcp.json`.

The host (Claude Code or Codex) owns the file's runtime location and rotates the cache directory on plugin upgrade. Hook/MCP `command` strings use the canonical defensive shell prelude:

    _C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
    _E="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
    _P=$({ [ -n "$_E" ] && printf '%s\n' "$_E"; ls -dt "$_C/plugins/cache/thedotmack/claude-mem"/[0-9]*/ 2>/dev/null; printf '%s\n' "$_C/plugins/marketplaces/thedotmack/plugin"; } | while …; done)

The prelude is generated by `src/build/hook-shell-template.ts` (Phase 2). Hand-editing these strings is forbidden; tests in `tests/infrastructure/plugin-distribution.test.ts` enforce shape.

### Rule B — Installer-managed bake (Cursor, Gemini, Windsurf, MCP-only IDEs)

Sites: any per-IDE config file written by `src/services/integrations/*Installer.ts`.

The claude-mem installer owns the file. Bake absolute paths via the helpers in `src/services/integrations/install-paths.ts` (Phase 3). On `claude-mem` upgrade, the installer must re-bake paths idempotently — see the migration logic in Phase 6.

### Rule C — Runtime resolution (`bun-runner.js`, `version-check.js`)

Both runtime scripts MUST accept `CLAUDE_PLUGIN_ROOT` env first, then fall back to `dirname(import.meta.url)/..`. This is the safety net behind Rules A and B.
```

**Verification checklist:**
- [ ] `CLAUDE.md` has a `## Spawn-Contract Resolution` section exactly as above.
- [ ] The section names files (`hooks.json`, `codex-hooks.json`, etc.) and identifiers (`hook-shell-template.ts`, `install-paths.ts`) that Phases 2–3 will create.
- [ ] No code changes in this phase.

**Anti-pattern guards:**
- ❌ Do not pick option (c) — it adds an extra binary that itself needs install-time path baking, recursing the problem.
- ❌ Do not write a "unified" rule that tries to handle host-managed and installer-managed sites with the same template. They have different lifecycles.

---

## Phase 2 — Centralize the shell template

**What to implement:** A single TypeScript module that emits the canonical defensive shell prelude and the hook/MCP `command` strings. `scripts/build-hooks.js` calls it to *generate* `plugin/hooks/hooks.json`, `plugin/hooks/codex-hooks.json`, `.mcp.json`, and `plugin/.mcp.json` from a single source of truth.

Today these four files contain hand-edited shell strings (visible in the catalogue Phase 0.1, items #1–4). Drift between them is the proximate cause of issue #1215, the codex 12.3.1 cache breakage, and the `fixBrokenScriptPath` band-aid.

### 2.1 Create `src/build/hook-shell-template.ts`

API surface (these names are referenced by `scripts/build-hooks.js` in Phase 2.2):

```ts
export interface ShellTemplateOptions {
  // Which runtime script must exist for the resolved root to count as valid.
  // Examples: 'scripts/version-check.js', 'scripts/bun-runner.js', 'scripts/mcp-server.cjs'.
  requireFile: string;
  // Optional second required file (used by hook commands that need both bun-runner.js AND worker-service.cjs).
  requireFileSecondary?: string;
  // The trailing command to run after _P is resolved. Receives "$_P" (POSIX-quoted).
  // Example: ['node', '"$_P/scripts/bun-runner.js"', '"$_P/scripts/worker-service.cjs"', 'hook', 'claude-code', 'session-init']
  trailingCommand: string[];
  // Which host this is for. Selects the PATH-resolution prelude.
  host: 'claude-code' | 'codex-cli' | 'mcp';
  // Extra env exports prepended to the prelude (e.g. CLAUDE_MEM_CODEX_HOOK=1 for codex version-check).
  extraEnv?: Record<string, string>;
  // Optional trailing JSON output (e.g. SessionStart hook emits '{"continue":true,"suppressOutput":true}').
  trailingJson?: object;
  // Error message printed to stderr when no candidate root resolves.
  notFoundMessage: string;
}

export function buildShellCommand(options: ShellTemplateOptions): string;
```

The function builds a single-line shell string composed of:

1. **PATH-resolution prelude** (host-specific):
   - `claude-code`: `export PATH="$($SHELL -lc 'echo $PATH' 2>/dev/null):$PATH";` (matches `plugin/hooks/hooks.json:24`).
   - The Setup-hook variant has a hard-coded nvm path (`plugin/hooks/hooks.json:11`) — keep it as a special case `host: 'claude-code-setup'` or pass an `overridePathPrelude` field; reuse the literal from line 11.
   - `codex-cli`: `_HP=$(printenv PATH …); if [ -z "$_HP" ] && [ -n "${SHELL:-}" ]; then _HP=$("$SHELL" -lc 'printf %s "$PATH"' …); fi; _HP=$(printf '%s' "$_HP" | tr ' ' ':'); export PATH="${_HP:+$_HP:}$PATH";` (matches `plugin/hooks/codex-hooks.json:10`).
   - `mcp`: no PATH prelude (the `sh -c` for MCP servers inherits PATH from the parent — see `.mcp.json:8`).

2. **Config-dir + plugin-root resolution** (identical across hosts):
   ```sh
   _C="${CLAUDE_CONFIG_DIR:-$HOME/.claude}";
   _E="${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}";
   ```

3. **Candidate enumeration + filter loop** (reuse the existing pipeline from `plugin/hooks/hooks.json:24`):
   ```sh
   _P=$({
     [ -n "$_E" ] && printf '%s\n' "$_E";
     # MCP only: also try $PWD/plugin and $PWD and $HOME/.codex/plugins/cache/claude-mem-local/claude-mem/[0-9]*/
     ls -dt "$_C/plugins/cache/thedotmack/claude-mem"/[0-9]*/ 2>/dev/null;
     printf '%s\n' "$_C/plugins/marketplaces/thedotmack/plugin";
   } | while IFS= read -r _R; do
     _R="${_R%/}";
     [ -d "$_R/plugin/scripts" ] && _Q="$_R/plugin" || _Q="$_R";
     [ -f "$_Q/scripts/<requireFile>" ] && [ -f "$_Q/scripts/<requireFileSecondary>" ] && { printf '%s\n' "$_Q"; break; };
   done);
   ```

4. **Not-found guard:**
   ```sh
   [ -n "$_P" ] || { echo "<notFoundMessage>" >&2; exit 1; };
   ```

5. **Cygpath conversion** (host-specific — `claude-code` and `codex-cli` only, NOT `mcp` because `sh -c` already runs under POSIX shell which understands POSIX paths):
   ```sh
   command -v cygpath >/dev/null 2>&1 && { _W=$(cygpath -w "$_P" 2>/dev/null); [ -n "$_W" ] && _P="$_W"; };
   ```
   Note: existing `.mcp.json:8` does NOT include cygpath — confirm via test diff that we preserve that.

6. **Extra env exports** (e.g. `CLAUDE_MEM_CODEX_HOOK=1` for codex version-check, see `plugin/hooks/codex-hooks.json:10`).

7. **Trailing command** (already shell-quoted by caller: `node "$_P/scripts/bun-runner.js" "$_P/scripts/worker-service.cjs" hook claude-code session-init`).

8. **Optional trailing JSON** (e.g. `; echo '{"continue":true,"suppressOutput":true}'` for SessionStart, matching `plugin/hooks/hooks.json:24`).

**Reference shell strings to byte-match against** (compute hash of generated output vs. existing files in tests):

| Generator call | Must equal | Source file:line |
|---|---|---|
| `buildShellCommand({ host: 'claude-code-setup', requireFile: 'version-check.js', trailingCommand: ['node', '"$_P/scripts/version-check.js"'], notFoundMessage: 'claude-mem: version-check.js not found' })` | `plugin/hooks/hooks.json:11` | line 11 |
| `buildShellCommand({ host: 'claude-code', requireFile: 'bun-runner.js', requireFileSecondary: 'worker-service.cjs', trailingCommand: ['node', '"$_P/scripts/bun-runner.js"', '"$_P/scripts/worker-service.cjs"', 'start'], trailingJson: { continue: true, suppressOutput: true }, notFoundMessage: 'claude-mem: plugin scripts not found' })` | `plugin/hooks/hooks.json:24` | line 24 |
| (analogous for hooks.json:30, 42, 55, 68, 80) | each line in hooks.json | per line |
| `buildShellCommand({ host: 'codex-cli', requireFile: 'version-check.js', extraEnv: { CLAUDE_MEM_CODEX_HOOK: '1' }, trailingCommand: ['node', '"$_P/scripts/version-check.js"'], notFoundMessage: 'claude-mem: version-check.js not found' })` | `plugin/hooks/codex-hooks.json:10` | line 10 |
| (analogous for codex-hooks.json:15, 20, 32, 44, 56, 67) | each line | per line |
| `buildShellCommand({ host: 'mcp', requireFile: 'mcp-server.cjs', trailingCommand: ['exec', 'node', '"$_P/scripts/mcp-server.cjs"'], notFoundMessage: 'claude-mem: mcp server not found', mcpExtraCandidates: ['$PWD/plugin', '$PWD', '$HOME/.codex/plugins/cache/claude-mem-local/claude-mem/[0-9]*/'] })` | `.mcp.json:8` and `plugin/.mcp.json:8` | line 8 |

### 2.2 Wire into `scripts/build-hooks.js`

After the existing build steps and before the verification block (current `scripts/build-hooks.js:352`), insert a generation step:

```js
const { buildShellCommand } = await import('./build-shell-template-runner.js');
// (or compile src/build/hook-shell-template.ts to dist/build/hook-shell-template.js
//  via esbuild and import that — choose based on whether scripts/ already runs TS)
```

Generate the four files from a manifest object. Compare byte-for-byte against existing files; if mismatch, write new and warn (in CI: fail).

### 2.3 Use `shell-quote` for the trailing command tokens

`shell-quote` (`scripts/build-hooks.js:101`, already a plugin runtime dep) provides `quote(words)` to safely escape `node`, `"$_P/scripts/X.cjs"`, `hook`, `claude-code`, `session-init`. Do not hand-build the string — escape via `quote()`.

**Verification checklist:**
- [ ] `src/build/hook-shell-template.ts` exists and TypeScript compiles.
- [ ] `npm run build-and-sync` regenerates the four files; output is byte-identical to current contents.
- [ ] `git diff plugin/hooks/hooks.json plugin/hooks/codex-hooks.json .mcp.json plugin/.mcp.json` is empty after the build.
- [ ] All assertions in `tests/infrastructure/plugin-distribution.test.ts` still pass without modification.

**Anti-pattern guards:**
- ❌ Do not change the existing fallback chain. Order matters (env first, then cache, then marketplace) — issue #1533 regression.
- ❌ Do not introduce `${VAR}`-substitution at JSON-write time (trying to "pre-render" the placeholder) — the host shell is what expands it; pre-rendering would defeat the whole point.
- ❌ Do not delete the `cygpath` block on the `mcp` host until you've confirmed `sh -c` on Git-Bash/Cygwin actually passes POSIX paths through to `node` correctly (it does today; document the assumption).

---

## Phase 3 — Centralize the absolute-path bake helpers

**What to implement:** A shared helper module for installer-managed (Rule B) sites. Today, four installers (Cursor, Gemini, Windsurf, McpIntegrations) each duplicate path-probing logic with subtle variations.

### 3.1 Create `src/services/integrations/install-paths.ts`

API surface:

```ts
export function getMcpServerAbsolutePath(): string;
export function getWorkerServiceAbsolutePath(): string;
export function getBunAbsolutePath(): string;
export function getNodeAbsolutePath(): string;            // process.execPath, but with a deterministic fallback
export function getVersionCheckAbsolutePath(): string;    // for completeness; currently unused by installers
export function getPluginRootAbsolutePath(): string;      // returns the plugin root used by the helpers above
```

**Reference implementation to port from:**

- `getMcpServerAbsolutePath` ← `src/services/integrations/CursorHooksInstaller.ts:84–96` (`findMcpServerPath`).
- `getWorkerServiceAbsolutePath` ← `src/services/integrations/CursorHooksInstaller.ts:98–110` (`findWorkerServicePath`).
- `getBunAbsolutePath` ← `src/services/integrations/CursorHooksInstaller.ts:112–130` (`findBunPath`).
- `getPluginRootAbsolutePath` — new logic: probe `process.env.CLAUDE_PLUGIN_ROOT`, then `MARKETPLACE_ROOT/plugin`, then `process.cwd()/plugin`, then `process.cwd()`. Document that this is install-time only (Rule B uses absolute paths; Rule C handles runtime).

**Deduplication targets:**

- `CursorHooksInstaller.ts:84–130`: replace bodies with calls to the new helpers; keep `findMcpServerPath`/`findWorkerServicePath`/`findBunPath` as thin re-exports for one release cycle (call sites in `WindsurfHooksInstaller.ts:8` and `McpIntegrations.ts:6` import them).
- `WindsurfHooksInstaller.ts:8`: switch import to `install-paths.ts`.
- `McpIntegrations.ts:6, 16–21`: same. Note `McpIntegrations.ts:18` uses `process.execPath` directly — replace with `getNodeAbsolutePath()`.
- `GeminiCliHooksInstaller.ts:6`: same.

### 3.2 Versioned-cache awareness

Each helper must resolve to the *currently installed* version's cache directory, NOT a versioned one that could be stale. The `pluginCacheDirectory(version)` helper at `src/npx-cli/utils/paths.ts:32–34` (per `plans/2026-04-29-installer-streamline.md` Phase 0 inventory) gives the canonical version-aware cache path. Use it in `getPluginRootAbsolutePath` if `process.env.CLAUDE_PLUGIN_ROOT` is unset and `MARKETPLACE_ROOT/plugin` does not exist (e.g., Codex-only setup).

### 3.3 OpenCodeInstaller and OpenClawInstaller

These two integrations don't bake shell paths (their plugins run as JS), so they don't consume the new helpers. Out of scope for Phase 3, but **document in `CLAUDE.md` Spawn-Contract Resolution section** that they are exempt by design.

**Verification checklist:**
- [ ] `src/services/integrations/install-paths.ts` exists; all six exports compile.
- [ ] `grep -rn "findMcpServerPath\|findWorkerServicePath\|findBunPath" src/services/integrations` shows the four installers importing from `install-paths.ts` (re-exports allowed).
- [ ] `npm test` passes existing installer tests (if any — verify with `grep -rn "from.*CursorHooksInstaller\|from.*WindsurfHooksInstaller\|from.*GeminiCliHooksInstaller\|from.*McpIntegrations" tests/`).
- [ ] No installer file contains a string literal beginning with `${CLAUDE_PLUGIN_ROOT}` after this phase. Add a test:
  ```ts
  it('installers must not emit raw ${CLAUDE_PLUGIN_ROOT} placeholders', () => {
    for (const file of ['CursorHooksInstaller.ts', 'WindsurfHooksInstaller.ts', 'GeminiCliHooksInstaller.ts', 'McpIntegrations.ts']) {
      const content = readFileSync(...);
      expect(content).not.toMatch(/\$\{CLAUDE_PLUGIN_ROOT\}/);
    }
  });
  ```

**Anti-pattern guards:**
- ❌ Do not change the public API of the existing `findMcpServerPath`/`findWorkerServicePath`/`findBunPath` exports during this phase — keep them as thin wrappers. Schedule removal for the release cycle after migration completes.
- ❌ Do not introduce new env vars (e.g. `CLAUDE_MEM_BUN_PATH`). The existing `findBunPath()` at `CursorHooksInstaller.ts:112–130` already handles platform variation; preserve that logic.

---

## Phase 4 — Audit + migrate every existing site

**What to implement:** For each site in the Phase 0.1 catalogue, declare its rule (A/B/C/none) and reconcile the implementation with the canonical generator/helper from Phases 2–3.

### 4.1 Site-by-site disposition

| # | Site | Rule | Action |
|---|---|---|---|
| 1 | `plugin/hooks/hooks.json` | A | Generated by `scripts/build-hooks.js` calling `buildShellCommand` (Phase 2). |
| 2 | `plugin/hooks/codex-hooks.json` | A | Same. |
| 3 | `.mcp.json` | A | Same. |
| 4 | `plugin/.mcp.json` | A | Same. Build asserts byte-parity with #3 (already exists at `scripts/build-hooks.js:392–396`). |
| 5 | `plugin/scripts/version-check.js` | C | No change — already correctly implemented at lines 7–17. Document in `CLAUDE.md`. |
| 6 | `plugin/scripts/bun-runner.js` | C | Document `RESOLVED_PLUGIN_ROOT` at line 11 in `CLAUDE.md`. **Keep `fixBrokenScriptPath` (lines 13–21)** — it's the runtime safety net for Rule A failures (the `_P` resolution lands on a wrong cache and the trailing `node "$_P/scripts/X.cjs"` arg becomes literal `/scripts/X.cjs`). Add a comment block explaining why it exists. |
| 7 | `src/services/integrations/CodexCliInstaller.ts` (60–78) | B (install-time root resolution) | Refactor `resolvePluginMarketplaceRoot` to call `getPluginRootAbsolutePath()` from `install-paths.ts` (Phase 3). Existing logic (env → cwd → script dirname) becomes the helper's body. |
| 8 | `src/services/integrations/CursorHooksInstaller.ts` | B | Refactor to use `install-paths.ts` helpers (Phase 3.1). |
| 9 | `src/services/integrations/GeminiCliHooksInstaller.ts` | B | Same. |
| 10 | `src/services/integrations/WindsurfHooksInstaller.ts` | B | Same. |
| 11 | `src/services/integrations/McpIntegrations.ts` | B | Same. |
| 12 | `src/services/integrations/OpenCodeInstaller.ts` | exempt | Document — JS plugin, no shell. |
| 13 | `src/integrations/opencode-plugin/index.ts` | exempt | Document — JS plugin runtime. |
| 14 | `openclaw/install.sh`, `openclaw/openclaw.plugin.json` | exempt | Document — uses `configSchema`. |
| 15 | manifest files (`plugin.json`, `marketplace.json` ×6) | exempt | Document — manifest substitution not supported by hosts. |
| 16 | `docs/public/hooks-architecture.mdx` examples | docs | See Phase 4.2. |
| 17 | `docs/public/configuration.mdx`, `docs/public/development.mdx`, `docs/public/architecture/hooks.mdx` | docs | Same. |

### 4.2 Documentation alignment

The docs (`docs/public/hooks-architecture.mdx:100,176,223,283,337,604,754`, plus `configuration.mdx:142`, `development.mdx:257`, `architecture/hooks.mdx:196,204,208,215,223,230,237`) currently teach users to write hooks like:

```json
{ "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/your-hook.js" }
```

This is the canonical Claude Code documented form per upstream. **Keep the docs aligned with upstream** — do NOT replace these examples with the defensive shell prelude (which is claude-mem-internal complexity, not user-facing API).

Add a single subsection to `docs/public/hooks-architecture.mdx` titled "Why claude-mem's own hooks look different" that:
1. States the upstream contract: `${CLAUDE_PLUGIN_ROOT}` is set by the host.
2. Explains that claude-mem ships a defensive fallback because some host versions / cache rotations don't inject it.
3. Links to this plan and `plans/2026-05-06-codex-plugin-version-mismatch.md`.

**Verification checklist:**
- [ ] All Phase 0.1 catalogue rows #1–17 are addressed (action documented and, where applicable, code refactored).
- [ ] `git grep -n '\${CLAUDE_PLUGIN_ROOT}' -- ':(exclude)docs' ':(exclude)plugin/hooks' ':(exclude)*.mcp.json' ':(exclude)plans'` returns no hits — the only places that should mention raw `${CLAUDE_PLUGIN_ROOT}` are the host-managed shell-template files (Rule A) and user-facing docs.
- [ ] `npm test` passes.

**Anti-pattern guards:**
- ❌ Do not delete `bun-runner.js`'s `fixBrokenScriptPath` until Phase 5 enforces no remaining call site can leak `/scripts/...`. The band-aid is load-bearing for sites we don't own (third-party hooks copy-pasted from docs).
- ❌ Do not "improve" docs by replacing `${CLAUDE_PLUGIN_ROOT}` with shell preludes — users would copy-paste shell complexity into single-purpose hooks that don't need it.

---

## Phase 5 — Build-time enforcement

**What to implement:** Extend `scripts/build-hooks.js` and `tests/infrastructure/plugin-distribution.test.ts` to lock in the canonical rule.

### 5.1 Build-time assertions

In `scripts/build-hooks.js` after the verification block (current lines 352–404), add:

1. **All Rule A files were generated by `buildShellCommand`.** Hold a generation manifest; for each site, regenerate and compare. Fail if mismatch (`Hand-edited shell string detected in <file>; regenerate via npm run build-and-sync.`).

2. **No raw `${CLAUDE_PLUGIN_ROOT}` placeholder in installer-emitted JSON.** Scan the build output of `dist/npx-cli/index.js` for the literal substring `${CLAUDE_PLUGIN_ROOT}` (after esbuild bundling). It must not appear.

3. **`fixBrokenScriptPath` band-aid documented.** Assert that `plugin/scripts/bun-runner.js` contains a `// fixBrokenScriptPath:` comment block explaining why it stays. This forces the doc burden when someone tries to delete it.

### 5.2 Test additions to `tests/infrastructure/plugin-distribution.test.ts`

Add a new `describe('Plugin Distribution - Spawn-Contract Templating')` block:

```ts
import { buildShellCommand } from '../../src/build/hook-shell-template.js';

it('hooks.json Setup hook command equals buildShellCommand output', () => {
  const generated = buildShellCommand({
    host: 'claude-code-setup',
    requireFile: 'version-check.js',
    trailingCommand: ['node', '"$_P/scripts/version-check.js"'],
    notFoundMessage: 'claude-mem: version-check.js not found',
  });
  const actual = readJson('plugin/hooks/hooks.json').hooks.Setup[0].hooks[0].command;
  expect(actual).toBe(generated);
});

// (analogous tests for each of the 6 hooks.json events, 5 codex-hooks events, 1 mcp-search server)

it('no installer-output JSON contains raw ${CLAUDE_PLUGIN_ROOT}', () => {
  // After install runs in CI, scan ~/.cursor/hooks.json, ~/.cursor/mcp.json,
  // ~/.gemini/settings.json, ~/.codeium/windsurf/hooks.json, ~/.github/copilot/mcp.json,
  // ~/.gemini/antigravity/mcp_config.json, ~/.config/goose/config.yaml, ~/.roo/mcp.json,
  // ~/.warp/mcp.json — none should contain the literal string '${CLAUDE_PLUGIN_ROOT}'.
});
```

Where the install-output scan can't run in unit test context, gate it behind an env flag and run in an e2e job (see Phase 7).

### 5.3 Lint rule for documentation

Add a `lint:docs` script that fails CI if `docs/public/**/*.mdx` mentions `${CLAUDE_PLUGIN_ROOT}` in a `bash`/`sh` fenced code block (vs. JSON, which is the upstream-approved form).

```bash
# Pseudo-rule: any ```bash or ```sh block containing ${CLAUDE_PLUGIN_ROOT} fails.
# JSON examples are allowed because that's the upstream Claude Code hook contract.
```

**Verification checklist:**
- [ ] Hand-editing any Rule A file and running `npm run build-and-sync` produces a clear error telling the user to use the generator.
- [ ] All new tests in `tests/infrastructure/plugin-distribution.test.ts` pass.
- [ ] `lint:docs` CI step runs and passes against current `docs/public/`.
- [ ] Removing `fixBrokenScriptPath` from `bun-runner.js` causes the build to fail (at the doc-comment assertion).

**Anti-pattern guards:**
- ❌ Do not assert exact byte equality between the four Rule A files in tests — they have different `host` values (different PATH preludes), so they should NOT be byte-equal. Only the MCP pair (`.mcp.json` ↔ `plugin/.mcp.json`) is required to be byte-equal.
- ❌ Do not auto-regenerate Rule A files in CI without a check — accidental regenerations could mask drift bugs.

---

## Phase 6 — Migration / deprecation plan

**What to implement:** Handle existing installs in the wild that have absolute paths baked in from previous claude-mem versions. Plan the upgrade semantics for each integration.

### 6.1 Per-IDE migration matrix

| Integration | Current bake state | Migration on `npx claude-mem install` |
|---|---|---|
| Claude Code (Rule A) | host-managed; Claude Code rotates cache on `claude plugin update`. | No installer action needed. Setup hook (version-check.js) prints upgrade hint. Already implemented via `plans/2026-04-29-installer-streamline.md`. |
| Codex CLI (Rule A) | host-managed BUT Codex 0.128 may keep stale cache (see `plans/2026-05-06-codex-plugin-version-mismatch.md`). | Already covered by that plan; this plan adds no new migration. |
| Cursor (Rule B) | absolute paths in `~/.cursor/hooks.json` and `~/.cursor/mcp.json`. | `installCursorHooks` is idempotent (writes `hooks.json` whole); re-running `npx claude-mem install` re-bakes paths. |
| Gemini (Rule B) | absolute paths in `~/.gemini/settings.json`. | `mergeHooksIntoSettings` already overwrites the `claude-mem`-named hook entries (see `GeminiCliHooksInstaller.ts:97–123`) — re-running re-bakes. |
| Windsurf (Rule B) | absolute paths in `~/.codeium/windsurf/hooks.json`. | Idempotent rewrite — same pattern. |
| Copilot/Antigravity/Goose/Roo/Warp (Rule B) | absolute paths in each `mcp.json`. | `installMcpIntegration` overwrites `claude-mem` entry only (see `McpIntegrations.ts:31–39`). |
| OpenCode | absolute path of bundle copy. | `installOpenCodePlugin` overwrites the bundle file — `npm run build` then `npx claude-mem install` is the canonical upgrade path. |
| OpenClaw | configSchema-managed; no path baking. | No migration. |

### 6.2 Detection of stale installs

Add a new check in `npx claude-mem install` (in `src/npx-cli/commands/install.ts` setupIDEs flow): for each Rule B integration that's already installed, detect if the baked `mcpServerPath` / `workerServicePath` / `bunPath` still resolves on disk. If not, re-bake silently. Emit a single line: `Cursor: re-baked stale paths from <oldVersion> to <newVersion>`.

This addresses the case where a user installs claude-mem v12.7.0, then v12.8.0, and the v12.7.0 cache is still referenced in `~/.cursor/hooks.json` while the actual v12.7.0 bundle has been pruned by Claude Code's plugin garbage collector.

### 6.3 No version-pinned grace period needed

All Rule B integrations are bake-and-overwrite by design — running the installer always re-bakes. No legacy-format readers are needed. The marker file (`.install-version`) already gates the version-aware cache directory choice via `pluginCacheDirectory(version)` (per `plans/2026-04-29-installer-streamline.md` Phase 0).

### 6.4 Documentation note for Codex self-hosted marketplaces

Cross-reference `plans/2026-05-06-codex-plugin-version-mismatch.md`: self-hosted Codex marketplaces need to re-add the marketplace post-claude-mem-upgrade because Codex 0.128 doesn't auto-upgrade enabled plugin caches. Add this note to:
- `docs/public/configuration.mdx` (Codex section if any)
- The "Spawn-Contract Resolution" section in `CLAUDE.md` (Phase 1) under a "Known limitations" subsection

**Verification checklist:**
- [ ] Re-running `npx claude-mem install` on a system with v(N-1) baked paths refreshes them to v(N) without user intervention.
- [ ] The "stale paths re-baked" log line appears once per Rule B integration that needed it, never on a fresh install.
- [ ] Codex self-hosted marketplace doc note is present.

**Anti-pattern guards:**
- ❌ Do not silently delete pre-existing user customizations in `~/.cursor/hooks.json` or `~/.gemini/settings.json`. Only overwrite the `claude-mem`-namespaced entries; preserve everything else (the existing installers already do this — verify it).
- ❌ Do not introduce a separate "migrate" CLI command. Keep migration implicit in `npx claude-mem install`.

---

## Phase 7 — Validation matrix

**What to implement:** A concrete (IDE × hook event × platform × resolution-source) test matrix that proves the canonical rule holds for every combination.

### 7.1 Matrix dimensions

- **12 IDEs:** claude-code, gemini-cli, opencode, openclaw, windsurf, codex-cli, cursor, copilot-cli, antigravity, goose, roo-code, warp.
- **N hook events per IDE** (per `src/cli/handlers/`):
  - claude-code: 6 (Setup, SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop).
  - codex-cli: 5 (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop).
  - gemini-cli: 7 (per `GeminiCliHooksInstaller.ts:36–44`: SessionStart, BeforeAgent, AfterAgent, BeforeTool, AfterTool, PreCompress, Notification).
  - cursor: 5 (per `CursorHooksInstaller.ts:236–256`: beforeSubmitPrompt, afterMCPExecution, afterShellExecution, afterFileEdit, stop).
  - windsurf: 5 (per `WindsurfHooksInstaller.ts:35–41`: pre_user_prompt, post_write_code, post_run_command, post_mcp_tool_use, post_cascade_response).
  - opencode: tool/event-driven (no fixed hook count; verify plugin loads).
  - openclaw: gateway-driven (no hooks; verify plugin loads).
  - copilot-cli, antigravity, goose, roo-code, warp: MCP only (no hooks; verify MCP server starts).
- **2 MCP server entries:** `.mcp.json` (root) and `plugin/.mcp.json` (bundled).
- **3 platforms:** macOS, Linux, Windows-WSL, Windows-cygpath/Git-Bash. (4 actually, but the matrix size doesn't matter — what matters is which dimensions vary the spawn contract.)
- **3 resolution sources** (Rule A only): (a) host injects `CLAUDE_PLUGIN_ROOT`; (b) host doesn't inject, cache fallback hits; (c) host doesn't inject, cache fallback misses (must fail with the canonical "claude-mem: ... not found" stderr).

### 7.2 Concrete test cases (Rule A)

Add to `tests/infrastructure/plugin-distribution.test.ts`:

```ts
describe('Spawn-contract resolution — Rule A shell evaluation', () => {
  // Use bun's $ or child_process.exec to actually shell-execute each command
  // with mocked filesystem for the cache directory.

  for (const file of ['plugin/hooks/hooks.json', 'plugin/hooks/codex-hooks.json']) {
    for (const command of commandHooksFrom(file)) {
      it(`[${file}] resolves _P when CLAUDE_PLUGIN_ROOT is set`, () => {
        const env = { CLAUDE_PLUGIN_ROOT: tmpPluginRoot, /* etc */ };
        const result = spawnSync('bash', ['-c', command + '; echo "_P=$_P"'], { env });
        expect(result.stdout.toString()).toContain(`_P=${tmpPluginRoot}`);
      });

      it(`[${file}] resolves _P from cache when CLAUDE_PLUGIN_ROOT is unset`, () => {
        // Set up tmp $HOME/.claude/plugins/cache/thedotmack/claude-mem/12.0.0/plugin/scripts/<requireFile>
        // Run command without CLAUDE_PLUGIN_ROOT; assert _P resolves to the cache path.
      });

      it(`[${file}] fails cleanly when no candidate exists`, () => {
        // Empty $HOME, no CLAUDE_PLUGIN_ROOT.
        const result = spawnSync('bash', ['-c', command], { env: { HOME: emptyTmpDir } });
        expect(result.status).not.toBe(0);
        expect(result.stderr.toString()).toMatch(/claude-mem: .* not found/);
      });
    }
  }
});
```

For Windows-cygpath, mock `cygpath` as a shell function returning a Windows-style path; assert `_P` is converted.

### 7.3 Concrete test cases (Rule B)

Add per-installer integration tests that:
1. Run the installer against a tmp config directory (override env vars: `CURSOR_CONFIG_DIR`, `WINDSURF_HOOKS_DIR` overrides, etc. — most installers in this repo use `homedir()` directly; tests will need to mock or run in a Docker container).
2. Read the resulting JSON config.
3. Assert no string in the config contains `${CLAUDE_PLUGIN_ROOT}` literally.
4. Assert every `command`/`args[]` path is absolute and exists on disk.
5. Run the installer a second time; assert idempotency (the resulting JSON is byte-equal).
6. Bump the version (mock `pluginCacheDirectory` to return a new directory); run again; assert paths are re-baked to the new version.

### 7.4 Documented manual verification on real IDEs

For each of the 12 IDEs, run `npx claude-mem install`, then start a session and verify:
- Claude Code: SessionStart hook fires; check via `~/.claude-mem/logs/`.
- Codex CLI: SessionStart hook fires; check via `~/.codex/logs/`.
- Cursor: `claude-mem` MCP server appears in MCP panel; one tool call succeeds.
- Gemini: `claude-mem` SessionStart hook runs; check via `~/.gemini/`.
- Windsurf: `claude-mem` hook runs.
- OpenCode: `claude-mem.js` plugin loads.
- OpenClaw: gateway-attached plugin loads.
- Copilot CLI / Antigravity / Goose / Roo / Warp: each MCP server registers and one tool call succeeds.

Document the manual results in the PR description.

**Verification checklist:**
- [ ] All Rule A shell-eval tests pass on Linux and macOS in CI.
- [ ] Windows shell-eval tests pass on Windows-WSL CI runner (or are explicitly marked skipped with a reason).
- [ ] All Rule B installer tests pass.
- [ ] Manual verification table is filled in for the PR.

**Anti-pattern guards:**
- ❌ Do not skip the "fails cleanly when no candidate exists" test. The "claude-mem: ... not found" error is what users see when their install is broken; it's a contract.
- ❌ Do not run Rule A shell tests with `set -u` or `set -e` — the canonical prelude relies on unset-with-default semantics; strict mode would change behavior.

---

## Phase 8 — Rollout

### 8.1 Pre-merge

1. `npm run build-and-sync` — must pass with new generator.
2. `npm test` — full suite passes including the new spawn-contract tests.
3. Manual verification on a fresh machine for at least Claude Code + Codex + Cursor + 1 MCP-only IDE (per Phase 7.4).
4. Open a non-draft PR against `main`. Title: `fix: codify spawn-contract templating across the 12-IDE matrix`. Reference issues #1215, #1533, and `plans/2026-05-06-codex-plugin-version-mismatch.md`.

### 8.2 Post-merge

1. Bump claude-mem version (the version-bump skill handles this).
2. Run `claude-mem version-bump` flow; the marketplace publishes the new bundle.
3. Watch for issues in the first 48 hours: monitor for any "claude-mem: <X> not found" reports in user issues — those signal Rule A fallback failures, which the test matrix should have caught.

### 8.3 Documentation deliverables (final)

After merge, confirm:

- `CLAUDE.md` has the `## Spawn-Contract Resolution` section (Phase 1.3).
- `docs/public/hooks-architecture.mdx` has the "Why claude-mem's own hooks look different" subsection (Phase 4.2).
- `plans/02-spawn-contract-templating.md` (this file) is referenced from `plans/2026-05-06-codex-plugin-version-mismatch.md` as the canonical resolution document.

**Verification checklist:**
- [ ] PR merges cleanly.
- [ ] Version bump publishes a new marketplace.
- [ ] No user-reported "not found" issues in the 48 hours after release.
- [ ] All three documentation deliverables are in place.

**Anti-pattern guards:**
- ❌ Do not bypass version-bump (per CLAUDE.md "No need to edit the changelog ever, it's generated automatically.").
- ❌ Do not skip the manual 4-IDE verification step. The whole point of this PR is cross-IDE consistency; type checks alone won't catch a regression.

---

## Summary of file changes

| Type | Path | Phase |
|---|---|---|
| Created | `src/build/hook-shell-template.ts` | 2 |
| Created | `src/services/integrations/install-paths.ts` | 3 |
| Edited | `scripts/build-hooks.js` | 2, 5 |
| Edited | `src/services/integrations/CodexCliInstaller.ts` | 4 |
| Edited | `src/services/integrations/CursorHooksInstaller.ts` | 3, 4 |
| Edited | `src/services/integrations/GeminiCliHooksInstaller.ts` | 3, 4 |
| Edited | `src/services/integrations/WindsurfHooksInstaller.ts` | 3, 4 |
| Edited | `src/services/integrations/McpIntegrations.ts` | 3, 4 |
| Generated | `plugin/hooks/hooks.json` | 2 |
| Generated | `plugin/hooks/codex-hooks.json` | 2 |
| Generated | `.mcp.json` | 2 |
| Generated | `plugin/.mcp.json` | 2 |
| Edited | `plugin/scripts/bun-runner.js` (add comment block) | 4 |
| Edited | `tests/infrastructure/plugin-distribution.test.ts` | 5, 7 |
| Created | per-installer integration tests | 7 |
| Edited | `CLAUDE.md` (new section) | 1 |
| Edited | `docs/public/hooks-architecture.mdx` (subsection) | 4 |
| Edited | `src/npx-cli/commands/install.ts` (stale-path detection) | 6 |

Estimated diff: **+800 / −300 lines** (net addition due to new generator, helpers, and tests).

---

## Open questions for Phase 0 subagent

These are unresolved and must be answered by the Phase 0 Documentation Discovery subagent before Phase 1 finalizes the canonical rule:

1. **Claude Code:** Is `CLAUDE_PLUGIN_ROOT` *guaranteed* to be set for hooks in plugin-loaded `hooks.json` files (vs. user-level `hooks.json`)? Source: Claude Code docs.
2. **Codex CLI 0.128+:** Same question. The defensive prelude in `codex-hooks.json` suggests the var is sometimes missing — confirm.
3. **Cursor:** Does Cursor's hook spec promise `${VAR}` substitution or require absolute paths? Today's installer assumes absolute; verify.
4. **Gemini, Windsurf:** Same question.
5. **OpenCode:** Confirm plugin context shape (`OpenCodePluginContext.directory` etc.) is the canonical plugin-root channel — not env vars.
6. **MCP protocol (all hosts):** Confirm no host runs `${VAR}` substitution on the `command`/`args` fields of `mcp.json`. Today's installers assume not; verify.

Each answer should cite (URL or file:line) and quote the contractual statement. Update Phase 1.2 (rule selection) if any answer contradicts the orchestrator's recommendation.
