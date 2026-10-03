# Plan: Hooks call `claude-mem` directly, with no bash string

**Date:** 2026-10-02 · **Tracker:** plan-17 #3605 (Hook Wrapper Contract) · **Supersedes:** #3403, #3564, #4182; reshapes #4282
**Base:** `origin/main` @ `039c6160f`. Every phase works in a fresh worktree cut from `origin/main`, never from `strategic-pr-merge`, which is 230 commits behind.

## Primary Goal

Every Claude Code hook in `plugin/hooks/hooks.json` becomes one short, shell-free command:

```json
{ "type": "command", "command": "claude-mem", "args": ["hook", "claude-code", "observation"] }
```

That replaces today's ~1,700-character bash string. The result is zero console windows on Windows, no bash on any platform, and no per-call shell overhead. The installer puts `claude-mem` on PATH the way `rtk` is put on PATH.

## Why (the user-facing problem)

On Windows, every claude-mem hook runs `bash → node.exe → bun.exe`. Claude Code hides bash's console, but bash does not pass `SW_HIDE` to `node.exe`, so a console window flashes and can steal keyboard focus:

- once after **every** tool call (PostToolUse, matcher `*`),
- once more before every Read (PreToolUse `Read`),
- and once per prompt, per turn end, and at session start and end.

A 20-tool-call turn produces about 27 flashes. Reports: #3559, #3521, #3396 (the third recurrence after #676/#681/#748), #3248, #4121 (about 3.5 s of bash preamble per tool call). All were closed into plan-17, and main still ships `"shell": "bash"` on all 8 entries.

---

## Phase 0: Documentation Discovery (DONE, consolidated)

### Allowed APIs: Claude Code hooks (official docs)
- **Exec form exists.** A `"type": "command"` hook accepts `command` + `args` (array). When `args` is present, `command` is resolved as an executable on PATH and spawned directly, with no shell, and `shell` is ignored. Source: https://code.claude.com/docs/en/hooks#core-fields
- **Fields:** `command`, `args`, `shell` (`"bash"` | `"powershell"`), `async`, `asyncRewake`, `timeout`. Nothing else.
- **Variables:** `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_PROJECT_DIR}` are substituted literally in `command` and `args`. They are **also exported as environment variables** to the hook process. Source: https://code.claude.com/docs/en/plugins/manifest-reference#environment-variables
- **Plugin `bin/`:** files there go on the **Bash tool's** PATH while the plugin is enabled. It is **not documented** that hook processes see `bin/`, so do not rely on it (verify in Phase 1).
- **Exit codes:** 0 means success (stdout JSON parsed). 2 means blocking. Any other code is a non-blocking error. Stdin is the JSON payload.
- **Not documented:** Windows console visibility for hook children; how GUI-launched Claude Code builds PATH.

### Current pipeline (origin/main): copy from these, don't reinvent
| What | Where |
|---|---|
| Generator for the bash string (root order: env → version-sorted cache, skip `.orphaned_at` → marketplace) | `src/build/hook-shell-template.ts` L316–363 (`buildShellCommand`) |
| **Pure-Node root resolver, already shell-free** (the template for the launcher's resolver) | `src/build/hook-shell-template.ts` L223–261 (`buildMcpNodeLauncher`), L276–309 (`buildCodexWindowsCommand`) |
| Manifest of every hook command | `scripts/build-hooks.js` L106–176 (`shellTemplateManifest`) |
| Rule A verifier (throws on hand edits) | `scripts/build-hooks.js` L183–292 (`verifyShellTemplateCanonical`), called at L847 |
| Runtime runner: plugin-disabled check, `findBun`, 5 s stdin buffer, `windowsHide`, empty-stdin diagnostic | `plugin/scripts/bun-runner.js` L23–285 |
| Worker `hook` dispatch | `src/services/worker-service.ts` L1566–1584 |
| Fail-open core (exit 0 + one stderr line on any failure) | `src/cli/hook-command.ts` L78–165 |
| Root oracle | `src/shared/worker-utils.ts` L563 `resolvePluginRoot()`, L471–543 |
| Installer flow | `src/npx-cli/commands/install.ts` `runInstallCommandInner` L2489; runtime setup L2619–2652 |
| Shell rc PATH appender (POSIX, existing) | `src/npx-cli/commands/install.ts` L587–654 (`applyClaudeCodePathSetupIfNeeded`) |
| Bun install and path list | `src/npx-cli/install/setup-runtime.ts` L64–80, L184–219, L331–380 |
| Existing compile command (precedent) | `package.json` `build:cli-binary`; `scripts/build-worker-binary.js` L14–17 |
| Tests that pin the bash shape (must be rewritten) | `tests/infrastructure/plugin-distribution.test.ts` L261–372, L457–498, L505–832 |
| Other tests keyed on the command text | `tests/shared/host-hook-limits.test.ts` L34–36 (`'hook claude-code context'`) |

### Facts that shape the design
- The fail-open logic already lives in TypeScript (`hook-command.ts`). The bash string only finds Node and the plugin root. **That is all the launcher must do.**
- Nothing installs `claude-mem` on PATH today. `package.json` `bin` points at a Node ESM CLI, and its `runHookCommand` (`src/npx-cli/commands/runtime.ts` L198–220) runs the **npm package's** copy, fails loud, and is wrong for hooks. Do not reuse it.
- Marketplace auto-update (`autoUpdate: true`, `install.ts:207`) runs no installer code. A binary on PATH therefore goes stale unless it is **version-stable**. The launcher must contain no claude-mem logic that changes between releases.
- The installer already guarantees Bun (`ensureBun`). `bun build --compile` for the host target uses the local Bun and needs no network and no CI matrix.
- There is no macOS CI job. Windows CI is `windows.yml` (`windows-2022`).

### Anti-patterns (do NOT)
- Do not invent hook fields; only the six fields above exist.
- Do not put per-user absolute paths in the shipped `hooks.json`.
- Do not commit compiled binaries to git (`plugin/scripts/claude-mem` is gitignored at `.gitignore:42` for a reason).
- Do not reuse `runHookCommand` or the npx ESM CLI as the hook entry.
- Do not reproduce claude-mem logic in the launcher (no handlers, no HTTP). It only resolves the root, runs `worker-service.cjs`, and fails open.
- Do not hand-edit `plugin/hooks/hooks.json`. It goes through the generator and Rule A.

---

## Phase 1: Spike (verify every assumption; no product code)

**Goal:** turn the unknowns into facts before building. Write results into `plans/2026-10-02-claude-mem-on-path-hooks.SPIKE.md` with the command, the output and a verdict. Use a throwaway local plugin or a scratch worktree, never the user's live install.

Verify:
1. **Exec form in real Claude Code (macOS).** Install a scratch plugin with a PostToolUse hook `{"command":"<name>","args":["x"]}` where `<name>` is a script on PATH that appends its argv and stdin to a file. Confirm it runs with no shell and receives stdin.
2. **`CLAUDE_PLUGIN_ROOT` is in the hook's environment** under exec form (`process.env.CLAUDE_PLUGIN_ROOT`).
3. **Command not on PATH:** what does Claude Code show? Exit code, UI message, does it block? This decides how loud "missing launcher" is.
4. **Is a plugin `bin/` executable visible to hooks?** Test with a `bin/` file and exec form. If yes, it becomes the zero-install fallback; record it.
5. **GUI launch PATH on macOS:** open Claude Code from the Desktop app's Code tab or a non-terminal launch, and log `PATH` from a hook. Is `~/.local/bin` present?
6. **`bun build --compile`** of a 30-line launcher: confirm it works, record its size and time, and confirm it runs.
7. **`BUN_BE_BUN=1`:** does spawning the compiled launcher's own `process.execPath` with `BUN_BE_BUN=1` act as the `bun` CLI and run `worker-service.cjs`? Cite Bun docs. If not, the launcher uses `findBun` from `bun-runner.js`.
8. **When does the `Setup` hook fire** (install, update, `--init`)? Cite docs plus an observed run. This decides whether Setup can self-install the launcher for marketplace-only users.
9. **Windows (needs a real Windows machine; ask a community Windows tester if none is local):** an exec-form hook to an `.exe` on PATH gives **zero** visible windows across 50 tool calls. Record who verified it and how.

**Verification:** SPIKE.md has a verdict for all 9 items with evidence. Items 1–8 run on this Mac. Item 9 is either verified or explicitly marked PENDING-WINDOWS-TESTER, which blocks only Phase 6, not Phases 2–5.

**Stop after Phase 1.** If item 1 or 2 fails, stop and report; the design needs to change.

---

## Phase 2: The launcher (version-stable, tiny)

**Goal:** `src/launcher/claude-mem-launcher.ts`. Its only job is: `claude-mem hook <platform> <event>` → find the plugin root → run `worker-service.cjs hook <platform> <event>` with the hook's stdin → exit 0 on any failure, with one stderr line.

**Copy, don't invent:**
- **Root resolution:** port `buildMcpNodeLauncher` (`hook-shell-template.ts` L223–261) and `buildCodexWindowsCommand` (L276–309). The order is `CLAUDE_PLUGIN_ROOT` / `PLUGIN_ROOT` env, then the version-sorted cache with `.orphaned_at` skipped, then the marketplace. Both `scripts/bun-runner.js` and `scripts/worker-service.cjs` must exist. Use the same `_E/plugin` normalization as the bash template L170–175.
- **Plugin-disabled check, stdin buffer, spawn with `windowsHide: true`, empty-stdin diagnostic and exit-code mapping:** port from `plugin/scripts/bun-runner.js` L101–285.
- **Bun:** use `BUN_BE_BUN=1` on `process.execPath` if Phase 1 item 7 passed. Otherwise use `findBun` from `bun-runner.js` L23–99.
- **Fail-open:** match `hook-command.ts` L138–161. Root not found, Bun not found or spawn error each print one line, `claude-mem: <reason>, continuing without memory`, and exit 0. **Never exit 2.**
- **Subcommands:** `hook <platform> <event>` and `--version`. The version prints `LAUNCHER_PROTOCOL` (an integer constant, starting at 1). Anything else prints usage and exits 0.

**Build:** add an esbuild target in `scripts/build-hooks.js` beside the others (L380–430 pattern), outputting `plugin/scripts/claude-mem-launcher.js`, committed like the other bundles. Do not compile in the build; compiling happens on the user's machine (Phase 3).

**Tests:** `tests/launcher/claude-mem-launcher.test.ts` runs the bundle with Bun against a temp HOME. Cases:
- env root
- cache fallback with the highest version winning and orphaned versions skipped
- marketplace fallback
- no root found: exit 0 plus the stderr line
- plugin disabled: exit 0
- stdin delivered intact to a stub `worker-service.cjs`
- a child exiting with 7: the launcher exits 0 (fail-open)

Copy the case shapes from `plugin-distribution.test.ts` L635–832.

**Verification:** `bun test tests/launcher/`, `npm run typecheck`, `npm run build`. Also `grep -n "fetch\|http" src/launcher/` returns nothing (no claude-mem logic in the launcher).

**Anti-pattern guards:** no imports from `src/services`, `src/cli/handlers` or `src/shared/worker-utils` (the launcher must stay version-stable). No `shell: true` except `.cmd`/`.bat`, exactly as `bun-runner.js` does.

**Stop after Phase 2.**

---

## Phase 3: Install the launcher on PATH (and keep it there)

**Goal:** `npx claude-mem install` and `update` compile the launcher and place `claude-mem` on PATH. Marketplace-only users get it automatically, and a missing launcher is loud, never silent.

1. **Compile at install:** after `ensureBun` in the runtime-setup step (`install.ts` L2619–2652), run `bun build --compile <cache>/plugin/scripts/claude-mem-launcher.js --outfile <binDir>/claude-mem[.exe]`.
2. **Bin dir:**
   - POSIX: `~/.local/bin`. Reuse the rc-file appender at `install.ts` L587–654, generalized so it runs whenever `~/.local/bin` is not already on PATH, not only after installing Claude Code.
   - Windows: `%LOCALAPPDATA%\claude-mem\bin`, added to the **user** PATH. Use `[Environment]::SetEnvironmentVariable('Path', …, 'User')` through PowerShell, appending only if absent and never truncating; `setx` is forbidden because it truncates at 1024 characters.
   - If Phase 1 item 5 showed that GUI launches miss `~/.local/bin` on macOS, also symlink into the first writable directory among `/opt/homebrew/bin` and `/usr/local/bin`, and record which was used.
3. **Skip when current:** if `claude-mem --version` already prints the current `LAUNCHER_PROTOCOL`, do nothing.
4. **Self-heal for marketplace-only installs:** if Phase 1 item 8 confirmed Setup fires on install and update, then `plugin/scripts/version-check.js` (which Setup runs) performs the same compile-and-place step when the launcher is missing or its protocol is old. If Setup does not fire on plugin install, use the fallback chosen in SPIKE.md (for example the plugin `bin/` from item 4) and record the decision.
5. **Uninstall:** `commands/uninstall.ts` L57–68 removes the binary it placed. It leaves rc files alone and prints the line to remove.
6. **Doctor:** add a `doctor` row: launcher on PATH (where), its protocol, and one timed `claude-mem --version` round trip.

**Tests:** extend the existing installer tests (find them with `grep -rl "runInstallCommand\|applyClaudeCodePathSetupIfNeeded" tests/`). Cover: compile invoked with the right outfile per platform; Windows PATH append is idempotent and never truncates; skip when current; uninstall removes the binary.

**Verification:**
- Typecheck, build, tests.
- On this Mac: `npx` the local build into a throwaway HOME (`HOME=$(mktemp -d -p .scratch)`), then confirm `command -v claude-mem` and `claude-mem --version` from a fresh shell.

**Stop after Phase 3.**

---

## Phase 4: Switch the hooks to exec form, and make bash impossible to come back

**Goal:** every runtime Claude Code hook becomes `{"command":"claude-mem","args":["hook","claude-code","<event>"]}`, with the same events, matchers, `async` and timeouts as today (table in Phase 0 sources: `build-hooks.js` L125–150).

1. **Generator:** add `buildExecHook(event)` beside `buildShellCommand` in `hook-shell-template.ts`. Update `shellTemplateManifest` so `plugin/hooks/hooks.json` entries for SessionStart (`start` and `context`), UserPromptSubmit, PostToolUse, PreToolUse, Stop and SessionEnd verify `command` + `args` and the **absence** of `shell`.
2. **Setup hook:** keep whatever Phase 3 item 4 decided. If Setup must stay shell-form to self-install the launcher, it is the **only** shell entry, and it runs only on install and update.
3. **Rule A:** `verifyShellTemplateCanonical` throws `Claude Code runtime hook must be exec form (command+args, no shell)` when any runtime entry has `shell`, lacks `args`, or has a `command` other than `claude-mem`.
4. **Codex, Cursor and MCP:** unchanged in this plan. Codex keeps `command` / `commandWindows`. Note it as a follow-up.
5. **Tests:**
   - Rewrite `plugin-distribution.test.ts` L261–372, L457–498 and L505–558 for the exec shape.
   - Delete the bash-resolution matrix (L635–832) for Claude runtime hooks only; its cases now live in the launcher tests from Phase 2.
   - Update `tests/shared/host-hook-limits.test.ts` L34–36 to find SessionStart by `args`.
   - **New regression test** `tests/infrastructure/hooks-no-shell.test.ts`: for every entry in `plugin/hooks/hooks.json` except Setup, assert there is no `shell` key, `Array.isArray(args)` is true, `command === 'claude-mem'`, and no string contains `export PATH`, `_P=` or `bash`. This test is what prevents a fourth recurrence.
6. **Regenerate:** `node scripts/build-hooks.js --write-shell-templates`, then `npm run build`.

**Verification:**
- `bun test` (the full suite is compared against `BASELINE.md`: no new failures), `npm run typecheck`, `npm run build`.
- `jq '.hooks[][]|.hooks[]|select(.shell)' plugin/hooks/hooks.json` returns only Setup, or nothing.
- **Live check on this Mac:** with the launcher on PATH, run a real Claude Code session in a scratch project. Observations are captured (viewer or `/api/health` count goes up), and the hook log shows no `bash`.

**Stop after Phase 4.**

---

## Phase 5: Docs and help text

Update these to the new shape (one short command, the launcher on PATH, what `doctor` shows, what the missing-launcher error looks like):
- `docs/public/installation.mdx` L22–32, L50–71, L102, L148
- `docs/public/hooks-architecture.mdx` L83–115, L168, L469–573
- `docs/public/architecture/hooks.mdx` L207–211, L907
- `docs/public/architecture/overview.mdx` L125, L144
- `docs/public/configuration.mdx` L349
- `docs/public/troubleshooting.mdx` L622–633, plus a new "claude-mem: command not found in hooks" entry
- `README.md` L326
- `src/npx-cli/index.ts` help L17–66

Do not edit the CHANGELOG; it is generated automatically.

**Verification:** `grep -rn "shell.*bash\|bun-runner.js" docs/public README.md` shows no stale claims about Claude Code hooks. The Mintlify `docs.json` nav is unchanged unless a page was added.

**Stop after Phase 5.**

---

## Phase 6: Final verification, PR, community

1. **Anti-pattern sweep:**
   - `grep -n '"shell"' plugin/hooks/hooks.json` (Setup only, or none)
   - `git ls-files | grep -E 'claude-mem(\.exe)?$'` (no committed binaries)
   - `grep -rn "src/services\|src/cli" src/launcher/` (none)
2. **Full gate:** typecheck, build, the full `bun test` against `BASELINE.md`, then the `windows.yml` and `ci.yml` jobs green on the PR.
3. **Windows proof:** Phase 1 item 9 must be VERIFIED before merge: zero visible windows across 50 tool calls, from a real Windows machine. If no local machine exists, ask in the PR and on #3605 for a Windows tester. Ask nathan-v, mmerlino23 and PetVix, who are active Windows reporters. Link the exact install-from-branch steps.
4. **PR:** one PR against `main`, titled `fix(hooks): call claude-mem directly — no bash, no console flash on Windows`. The body links #3605, #3559, #3521, #3396, #3248, #4121 and the SPIKE.md. Credit rodboev (#3403) and #3564's author as co-authors for the exec-form diagnosis.
5. **After merge:**
   - Close #3403, #3564 and #4182 with thanks and a link.
   - Comment on #4282 that Grok Build should now target the `claude-mem hook …` exec form, and invite nathan-v to rebase onto it.
   - Post the result on #3605.

**Verification:** the PR is green, the Windows proof is recorded, the ledger and roster are updated if `.scratch/pr-triage/` is still in use.

---

## Open decisions (resolved by Phase 1 evidence, not guessed)
- The marketplace-only self-heal route: Setup hook, plugin `bin/`, or a loud error with the install command.
- Whether macOS GUI launches need the `/opt/homebrew/bin` / `/usr/local/bin` symlink.
- `BUN_BE_BUN=1`, or finding a separately installed Bun.

## Out of scope (follow-ups)
- Codex `codex-hooks.json` exec form (needs Codex hook-schema verification; plan-23).
- Grok Build (#4282 rework onto this).
- Deleting `bun-runner.js` once nothing calls it. Codex and MCP still do.
