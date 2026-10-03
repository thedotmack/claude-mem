# SPIKE: Hooks call `claude-mem` directly (Phase 1 evidence)

**Plan:** `plans/2026-10-02-claude-mem-on-path-hooks.md` · **Date:** 2026-10-02 · **Base:** `origin/main` @ `039c6160f`
**Machine:** macOS 26.3 arm64, Claude Code 2.1.288, Bun 1.3.9.
**Scratch:** everything lives under `.scratch/spike/` (gitignored by `.gitignore:50`). No product code changed. The user's live install (`~/.claude/plugins`, `~/.claude-mem`, `~/.claude/settings.json`) was not touched. Plugin-install tests used an isolated `CLAUDE_CONFIG_DIR=.scratch/spike/cfg`. A grep afterwards found 0 `spike` matches in the real `settings.json`, `known_marketplaces.json` and `installed_plugins.json`.

**Gate result: items 1 and 2 PASS. The exec-form design holds. Nothing blocks Phase 2.**

There are three findings the plan did not expect. Each one changes Phases 2–3:
1. **The `Setup` hook never fires on plugin install or update** (item 8). The plan's Setup self-heal route is dead.
2. **A plugin's `bin/` directory is not on the hook PATH** (item 4). However, `"command": "${CLAUDE_PLUGIN_ROOT}/bin/x"` works in exec form, even with a path containing a space and an emoji. That is the zero-PATH fallback.
3. **A `bun build --compile` binary autoloads `.env` from the cwd by default.** Hooks run in the user's project directory, so the launcher must be compiled with `--no-compile-autoload-dotenv` (item 6).

## Verdicts

| # | Item | Verdict |
|---|---|---|
| 1 | Exec form runs with no shell and receives stdin | **PASS** |
| 2 | `CLAUDE_PLUGIN_ROOT` is in the hook env under exec form | **PASS** |
| 3 | What happens when the command is not on PATH | **PASS** (answered: non-blocking error, exit 1, the session continues) |
| 4 | A plugin `bin/` executable is visible to hooks by bare name | **FAIL** (not visible). `${CLAUDE_PLUGIN_ROOT}/bin/<x>` as the command works. |
| 5 | macOS GUI launch PATH includes `~/.local/bin` | **PARTIAL** (strong indirect evidence of yes; no real Code-tab launch) |
| 6 | `bun build --compile` of a ~30-line launcher | **PASS** (57.5 MiB, 0.13 s compile, about 10 ms startup) |
| 7 | `BUN_BE_BUN=1` on the compiled binary acts as the `bun` CLI | **PASS** (with caveats that steer the decision toward `findBun`) |
| 8 | When `Setup` fires | **PASS** (answered: only `--init`, `--init-only`, `--maintenance`; never on install, update or normal startup) |
| 9 | Windows: zero visible windows across 50 tool calls | **PENDING-WINDOWS-TESTER** |

Common harness, used for every Claude Code run below:

```bash
S="$WORKTREE/.scratch/spike"            # WORKTREE = .../hooks-exec-form
cd "$S/project"; export PATH="$S/bin:$PATH" SPIKE_LOG="$S/logs/<run>.log"
claude -p "<prompt that triggers a Bash tool call>" \
  --plugin-dir "$S/plugin-<x>" --setting-sources project \
  --dangerously-skip-permissions --no-session-persistence \
  [--output-format stream-json --verbose --include-hook-events] [--debug-file "$S/logs/<run>.debug.log"]
```

`--setting-sources project` isolates the run from the user's plugins. The debug log shows only the spike plugin plus built-ins (`Found 2 plugins (2 enabled, 0 disabled)`: `spike-exec-form` and `cc-plugin-telemetry`). The user's claude-mem hooks did **not** fire.

The probe, `$S/bin/spike-hook`, is a `/bin/sh` script. It appends `$0`, the argv, `CLAUDE_PLUGIN_ROOT`/`DATA`, `CLAUDE_PROJECT_DIR`, `PATH`, `ps -o comm= -p $PPID` and stdin to `$SPIKE_LOG`.

---

## 1. Exec form in real Claude Code (macOS): PASS

Hook (`$S/plugin-a/hooks/hooks.json`):
```json
{ "type": "command", "command": "spike-hook", "args": ["x", "${CLAUDE_PLUGIN_ROOT}", "has space"] }
```
Command: `claude -p "Use the Bash tool to run exactly: cat hello.txt . Then reply with its output." --plugin-dir "$S/plugin-a" --setting-sources project --dangerously-skip-permissions --no-session-persistence --debug-file "$S/logs/run1.debug.log"`

Output (`$S/logs/run1.log`, trimmed):
```
argv0=/Users/alexnewman/.superset/worktrees/claude-mem 🧠/hooks-exec-form/.scratch/spike/bin/spike-hook
argv[1]=x
argv[2]=/Users/alexnewman/.superset/worktrees/claude-mem 🧠/hooks-exec-form/.scratch/spike/plugin-a
argv[3]=has space
parent_comm=/Users/alexnewman/.local/bin/claude
grandparent_comm=/bin/zsh            <- the terminal that launched claude, not a hook shell
--- stdin ---
{"session_id":"a57b579d-…","hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"cat hello.txt",…},"tool_response":{"stdout":"hello",…},"tool_use_id":"toolu_01FSvnJAw71h49mNpLAsjpXe","duration_ms":4455}
```

What this shows:
- **No shell.** The hook's parent process is `claude` itself. Under shell form it would be `sh`/`bash`.
- **Exact argv.** An argument with a space stays one argument (`has space`), and `${CLAUDE_PLUGIN_ROOT}` is substituted into `args` even though the path contains a space and an emoji.
- **Stdin.** The full PostToolUse JSON payload arrived on stdin.
- **Debug log:** `Hook output does not start with {, treating as plain text`, so it was handled as an ordinary hook. The run took 12.5 s wall time, including the model turn.

## 2. `CLAUDE_PLUGIN_ROOT` in the hook environment: PASS

Same run (`$S/logs/run1.log`):
```
CLAUDE_PLUGIN_ROOT=/Users/alexnewman/.superset/worktrees/claude-mem 🧠/hooks-exec-form/.scratch/spike/plugin-a
CLAUDE_PLUGIN_DATA=/Users/alexnewman/.claude/plugins/data/spike-exec-form-inline
CLAUDE_PROJECT_DIR=/Users/alexnewman/.superset/worktrees/claude-mem 🧠/hooks-exec-form/.scratch/spike/project
```
All three are exported as environment variables under exec form. The launcher can rely on `process.env.CLAUDE_PLUGIN_ROOT` first, and the cache and marketplace fallbacks remain for robustness.

## 3. Command not on PATH: PASS (answered)

Hook (`$S/plugin-b`): `{ "type":"command", "command":"claude-mem-spike-does-not-exist", "args":["hook","claude-code","observation"] }`
Command: the harness with `--output-format stream-json --verbose --include-hook-events --debug-file "$S/logs/run3.debug.log"`, with a prompt asking for **two** Bash calls and then the reply `DONE`.

Stream (`$S/logs/run3.stream.jsonl`), once per tool call (2 of 2):
```json
{"subtype":"hook_response","hook_name":"PostToolUse:Bash","exit_code":1,"outcome":"error",
 "stderr":"Error occurred while executing hook command: Executable not found in $PATH: \"claude-mem-spike-does-not-exist\""}
```
Debug log:
```
[ERROR] Hook command failed to spawn (PostToolUse:Bash): Executable not found in $PATH: "claude-mem-spike-does-not-exist"
[ERROR] "Hook PostToolUse:Bash (PostToolUse) error: status code 1\nstderr:\nError occurred while executing hook command: …"
```
Final result: `"result":"DONE","is_error":false,"num_turns":3`.

What this shows:
- A missing launcher is a **non-blocking error** reported as exit code 1, and the session continues.
- It is **reported on every hook invocation**, not once. Per the docs, the interactive transcript shows a `<hook name> hook error` notice with the first line of stderr (https://code.claude.com/docs/en/hooks, "exit codes other than 2").
- It is loud and repetitive but never blocks. The message names the missing executable, so the troubleshooting page can key on `Executable not found in $PATH: "claude-mem"`.
- Interactive-UI rendering was not visually confirmed, because this run was headless only.

## 4. Plugin `bin/` visible to hooks: FAIL (not visible); `${CLAUDE_PLUGIN_ROOT}/bin/x` works

The plugin `$S/plugin-c/bin/spike-bin-probe` was confirmed not on PATH (`command -v spike-bin-probe` returned nothing).

**4a. Bare name:** `{ "command":"spike-bin-probe", "args":["from-plugin-bin"] }` plus a PATH probe (`spike-hook`) in the same matcher.
```
hook_response: {"exit_code":1,"outcome":"error","stderr":"Error occurred while executing hook command: Executable not found in $PATH: \"spike-bin-probe\""}
hook_response: {"exit_code":0,"outcome":"success"}        <- PATH probe; its logged PATH has no plugin-c entry
Bash tool, same session:  command -v spike-bin-probe -> …/.scratch/spike/plugin-c/bin/spike-bin-probe
                          PATH entry 40 = …/.scratch/spike/plugin-c/bin
```
So `bin/` is on the **Bash tool's** PATH only. This matches the docs ("files there go on the Bash tool's PATH"). It is **not** on the hook PATH.

**4b. Plugin-root path:** `{ "command":"${CLAUDE_PLUGIN_ROOT}/bin/spike-bin-probe", "args":["via-plugin-root-path"] }`
```
hook_response: {"exit_code":0,"outcome":"success"}
argv0=…/.scratch/spike/plugin-c/bin/spike-bin-probe
argv[1]=via-plugin-root-path
parent_comm=/Users/alexnewman/.local/bin/claude
```
Exec form accepts a `${CLAUDE_PLUGIN_ROOT}`-relative absolute path as `command`, with no PATH lookup and no shell. The docs also recommend exactly this pattern: `"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/format.js"]`. This is **not** a per-user absolute path in the shipped `hooks.json`, because the placeholder is substituted at runtime.

## 5. macOS GUI-launch PATH: PARTIAL

I did not open any GUI app. Evidence:
```
$ launchctl getenv PATH
                                  <- empty; launchd default for GUI apps is /usr/bin:/bin:/usr/sbin:/sbin
$ ps eww -o command= -p <Claude.app main pid 96695> | tr ' ' '\n' | grep ^PATH=
PATH=/usr/bin:/bin:/usr/sbin:/sbin
$ ps eww -o command= -p <Claude.app child "disclaimer" pid 97801, parent of an MCP node> | … | grep ^PATH=
PATH=/Users/alexnewman/.kimi-code/bin:/Users/alexnewman/.local/bin:…:/opt/homebrew/bin:/Users/alexnewman/.bun/bin:…
$ grep -h "\[CCD\].*\(Shell environment\|login-shell\)" ~/Library/Logs/Claude/main*.log | tail
2026-09-15 13:50:27 [warn] [CCD] Shell environment extraction failed (attempt 1/5, willRetry=true), using process.env: Error: Shell environment extraction timed out
2026-09-15 13:56:57 [info] [CCD] Resolved 45 login-shell env vars
… (20 "Resolved 45 login-shell env vars" lines, 2026-09-04 → 2026-10-01; 1 failure, which then succeeded on retry)
```
Claude Code CLI does **not** repair PATH itself. A simulated launchd-minimal launch:
```
env -i HOME=$HOME USER=$USER LOGNAME=$USER SHELL=/bin/zsh TMPDIR=$TMPDIR PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  ~/.local/bin/claude -p "…echo hi…" --plugin-dir "$S/plugin-d" --setting-sources project …
hook "spike-hook" (bare name)           -> exit 1 "Executable not found in $PATH: \"spike-hook\""
hook "$S/bin/spike-hook" (absolute)     -> logged PATH=/usr/bin:/bin:/usr/sbin:/sbin
```
Conclusions:
- The CLI passes its inherited PATH straight to hooks. It does no login-shell probe for hooks. (`Spawn-env probe captured 98 keys` in the debug log belongs to the Bash-tool snapshot.)
- The Desktop app (`[CCD]`) resolves the **login-shell environment** and gives it to the children it spawns. Here that PATH contains `~/.local/bin`, because `.zshrc` and `.zprofile` export it. The installer's appender writes to `.zshrc` (`install.ts` `detectShellConfigFile`), which that extraction evidently reads: the child PATH contains `.zshrc`-only entries such as nvm and `~/Library/pnpm`.
- **Two gaps remain:**
  - (a) When extraction fails or times out, Desktop logs `using process.env`, which is `/usr/bin:/bin:/usr/sbin:/sbin`. Until the retry succeeds, `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin` are all missing.
  - (b) A real Code-tab session was not launched here, so a hook-logged PATH from Desktop is still unobserved.

**Remaining:** open a Code-tab session with the `$S/plugin-d` probe installed (for example via a scratch marketplace), and diff the logged PATH against `~/.local/bin`.

## 6. `bun build --compile` of a ~30-line launcher: PASS

Source: `$S/launcher/launcher.ts`, 26 lines. It handles `--version`, `hook <platform> <event>`, `CLAUDE_PLUGIN_ROOT` resolution, stdin buffering, `spawnSync(process.execPath, [worker-service.cjs, …], {env:{BUN_BE_BUN:"1"}, windowsHide:true})`, and fail-open exit 0.
```
$ /usr/bin/time -p bun build --compile launcher.ts --outfile claude-mem
   [9ms]  bundle  1 modules
 [111ms] compile  claude-mem
real 0.13
$ stat -f %z claude-mem         -> 60291808   (57.5 MiB)
$ file claude-mem               -> Mach-O 64-bit executable arm64
$ ./claude-mem --version        -> 1                                        (exit 0)
$ ./claude-mem                  -> usage: claude-mem hook <platform> <event> (exit 0)
$ CLAUDE_PLUGIN_ROOT=/nonexistent ./claude-mem hook claude-code observation </dev/null
claude-mem: plugin root not found (/nonexistent), continuing without memory   (exit 0)
$ for i in 1..5; time ./claude-mem --version          -> real 0.01 (x5)
$ for i in 1..3; time (echo '{}' | ./claude-mem hook …)  -> real 0.04 (x3; includes spawning the stub worker)
```
The host target compiled offline from the local Bun, with no download.

**Gotcha found:** compiled binaries autoload `.env` from the cwd (`--compile-autoload-dotenv`, default true).
```
$ cd $S/dotenv-probe   # contains .env: SPIKE_DOTENV_LEAK=leaked-from-project-env
$ ./envprint-default   -> launcher-entry SPIKE_DOTENV_LEAK=leaked-from-project-env
$ ./envprint-nodotenv  -> launcher-entry SPIKE_DOTENV_LEAK=<unset>     (built with --no-compile-autoload-dotenv)
```
Hooks run in the user's project directory, so Phase 3 **must** compile with `--no-compile-autoload-dotenv`. Note also that a `bun <script>` child (`BUN_BE_BUN` or a real bun) still autoloads the cwd `.env`. That is today's behavior through `bun-runner.js` too, so it is not a regression.

## 7. `BUN_BE_BUN=1`: PASS (works; caveats favor `findBun`)

Docs (https://bun.sh/docs/bundler/executables, "New in Bun v1.2.16"):
> "Set the `BUN_BE_BUN=1` environment variable to run a standalone executable as if it were the `bun` CLI itself. The executable ignores its bundled entrypoint and exposes the full `bun` CLI instead. … CLI tools built on top of Bun can use this to … run other files without downloading a separate binary or installing Bun."

Stub `$S/fake-root/scripts/worker-service.cjs` echoes its argv, Bun version, execPath, stdin and a `bun:sqlite` require, then exits 7.
```
$ BUN_BE_BUN=1 ./claude-mem --version     -> 1.3.9          (bun CLI version, not LAUNCHER_PROTOCOL)
$ ./claude-mem --version                  -> 1
$ echo '{"hook_event_name":"PostToolUse","x":"ü 🧠"}' | BUN_BE_BUN=1 ./claude-mem $S/fake-root/scripts/worker-service.cjs hook claude-code observation
{"argv":["hook","claude-code","observation"],"bun":"1.3.9","execPath":"…/launcher/claude-mem","BUN_BE_BUN":"1",
 "stdinBytes":45,"stdin":"{\"hook_event_name\":\"PostToolUse\",\"x\":\"ü 🧠\"}\n","require":"function","sqlite":"ok"}   exit=7
$ echo '{…"payload":"abc"}' | CLAUDE_PLUGIN_ROOT=$S/fake-root ./claude-mem hook claude-code observation   # the launcher spawns itself
{…same shape, stdinBytes 50…}
claude-mem: worker exited 7
launcher exit=0                                                              <- fail-open
$ python3 -c "…{'big':'a'*2000000}…" | CLAUDE_PLUGIN_ROOT=$S/fake-root ./claude-mem hook claude-code observation
stdinBytes 2000012                                                           <- 2 MB stdin intact
```
It works, and stdin, UTF-8, exit codes, CJS `require` and `bun:sqlite` all pass through. **Caveats** for the real worker:
- **The worker's `process.execPath` becomes `…/claude-mem`, not `bun`.**
  - `ProcessManager.ts:57` `isBunExecutablePath` (`/(^|[\\/])bun(\.exe)?$/`) returns false, so runtime resolution falls through to a PATH or BUN_INSTALL lookup.
  - `ServerService.ts:865` and `worker-service.ts:1140` spawn the **long-lived daemon** with `process.execPath`, so the daemon would run as the `claude-mem` launcher binary. That works only because `sanitizeEnv` keeps `BUN_BE_BUN`.
  - `ChromaMcpManager.ts:657/814` records and compares the process name against `{bun, node}`, and `claude-mem` matches neither.
- **Frozen runtime.** The Bun version is fixed at launcher compile time, while `worker-service.cjs` updates through marketplace auto-update. The plan's "version-stable launcher" holds only if the launcher does not also supply the runtime.

## 8. When does `Setup` fire: PASS (answered: not on install or update)

Docs (https://code.claude.com/docs/en/hooks, Setup):
> "fires **only** when you explicitly invoke it: `claude --init-only` … `claude -p --init` … `claude -p --maintenance`. It does NOT fire on normal startup or session resumption. … **Setup hooks do NOT fire for plugin installation or updates.**" Matchers: `init`, `maintenance`. "Setup hooks cannot block."

Observed with `$S/plugin-e`, which has Setup hooks with no matcher, `init` and `maintenance`, plus a SessionStart hook, all exec form. (The `--init` flags do not appear in `claude --help` but are accepted.)
```
[normal]        claude -p "Reply with exactly: hi"            -> SessionStart (source=startup) only
[p-init]        claude -p --init "Reply with exactly: hi"     -> Setup-no-matcher, Setup-init (trigger=init), SessionStart
[init-only]     claude --init-only                            -> Setup-no-matcher, Setup-init (trigger=init), SessionStart
[p-maintenance] claude -p --maintenance "Reply …"             -> Setup-maintenance, Setup-no-matcher (trigger=maintenance), SessionStart
```
Plugin install and update in an isolated config (`CLAUDE_CONFIG_DIR=$S/cfg`, local directory marketplace `$S/mkt`):
```
$ claude plugin marketplace add $S/mkt        -> ✔ Successfully added marketplace: spike-mkt
$ claude plugin install spike-setup@spike-mkt -> ✔ Successfully installed plugin … (scope: user)
-- log after install: (empty: no hook fired on install)
$ (bump 0.0.1 → 0.0.2) claude plugin marketplace update spike-mkt; claude plugin update spike-setup@spike-mkt
✔ Plugin "spike-setup" updated from 0.0.1 to 0.0.2 for scope user. Restart to apply changes.
-- log after update: (empty: no hook fired on update)
```
Consequence: today's claude-mem `Setup` entry (`version-check.js`, matcher `*`) effectively never runs for normal users. **Setup cannot self-install the launcher.** `SessionStart` (`startup`) is the earliest hook that runs reliably after install or update.

## 9. Windows zero-window proof: PENDING-WINDOWS-TESTER

There is no Windows machine here. Repro steps for a tester (Windows 10/11, Claude Code ≥ 2.1.288, Bun installed):
1. `mkdir %USERPROFILE%\spike\bin %USERPROFILE%\spike\plugin\.claude-plugin %USERPROFILE%\spike\plugin\hooks %USERPROFILE%\spike\project`
2. Build a probe `.exe` (it must be a real `.exe`; docs: "`.cmd` and `.bat` shims cannot be spawned without a shell"). Save it as `probe.ts`:
   ```ts
   import { appendFileSync, readFileSync } from "node:fs";
   const stdin = (() => { try { return readFileSync(0, "utf8"); } catch { return ""; } })();
   appendFileSync(process.env.USERPROFILE + "\\spike\\probe.log",
     `${new Date().toISOString()} argv=${JSON.stringify(process.argv.slice(2))} root=${process.env.CLAUDE_PLUGIN_ROOT} stdinBytes=${stdin.length}\n`);
   ```
   Then run `bun build --compile --no-compile-autoload-dotenv probe.ts --outfile %USERPROFILE%\spike\bin\spike-hook.exe`
3. `plugin\.claude-plugin\plugin.json`: `{"name":"spike-win","version":"0.0.1"}`
4. `plugin\hooks\hooks.json`: PostToolUse `*`, PreToolUse `Read`, UserPromptSubmit, Stop and SessionStart, each `{"type":"command","command":"spike-hook","args":["<event>"]}`. No `shell` key.
5. In PowerShell: `$env:Path = "$env:USERPROFILE\spike\bin;$env:Path"; cd $env:USERPROFILE\spike\project`
6. Start Claude Code **interactively**, because window flashes only matter with a visible terminal: `claude --plugin-dir $env:USERPROFILE\spike\plugin --setting-sources project`. Prompt: "Run `echo n` with the Bash/PowerShell tool 50 times, one call each, then Read README.md".
7. Screen-record the whole run (Win+G or OBS). Watch for any console window or taskbar flash, or any focus steal.
8. Pass criteria: `probe.log` has ≥ 50 PostToolUse lines plus 1 PreToolUse(Read) line, and the recording shows **zero** windows or flashes. Control run: the same plugin with `"shell":"bash"` and `"command":"spike-hook PostToolUse"`, which should reproduce the flash and so confirms the test is sensitive.
9. Record the tester's GitHub handle, Windows build (`winver`), Claude Code version, and the recording link on #3605.

Suggested testers, per the plan: nathan-v, mmerlino23, PetVix.

---

## Decisions

**1. Marketplace-only self-heal route: neither Setup nor the plugin `bin/` on PATH. Use a shell-free exec-form `${CLAUDE_PLUGIN_ROOT}` path, and make a missing launcher loud.**
- Setup is ruled out. Both the docs and the observed runs show it never fires on plugin install or update (item 8).
- Bare-name `bin/` is ruled out because hooks do not see it (item 4a).
- What does work is exec form with `"command": "${CLAUDE_PLUGIN_ROOT}/…"` (item 4b). Phase 3 should add a `SessionStart` (`startup`) exec-form entry, `{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/ensure-launcher.js"]}`. It runs once per session, uses no shell, and compiles and places the launcher when it is missing or `--version` is below `LAUNCHER_PROTOCOL`. This is the documented pattern, though Windows console behavior for a directly spawned `node.exe` is still covered by item 9.
- Until a launcher exists, the runtime hooks fail as item 3 shows: a non-blocking `Executable not found in $PATH: "claude-mem"` error on each hook. `doctor` and the troubleshooting page should key on that string and give `npx claude-mem install` as the fix.
- **Escalation for the plan owner:** item 4b also allows a no-PATH design for the runtime hooks themselves, `{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/claude-mem-launcher.js","hook","claude-code","<event>"]}`. That design has no install step and is never stale, but it depends on `node` being on PATH. This is a design change, so it is flagged rather than adopted.

**2. macOS GUI symlink into `/opt/homebrew/bin` or `/usr/local/bin`: not needed by default. Skip it, and make `doctor` detect the gap.**
- The Desktop app resolves the login-shell environment for the processes it spawns, and its child PATH contains `~/.local/bin` (item 5; 20 successful `[CCD] Resolved 45 login-shell env vars` lines).
- The CLI itself passes PATH through unchanged, so terminal launches inherit the shell PATH that the installer's `.zshrc` line fixes.
- The residual risk is the extraction-timeout fallback to `process.env`, which is `/usr/bin:/bin:/usr/sbin:/sbin`. A symlink would not reliably help there: `/opt/homebrew/bin` is also absent from that PATH, and `/usr/local/bin` needs root here (`drwxr-xr-x root wheel`).
- Revisit only if the real Code-tab probe (item 5, "Remaining") shows `~/.local/bin` missing.

**3. `BUN_BE_BUN=1` vs `findBun`: use `findBun` (port `bun-runner.js` L23–99) as the primary, and `BUN_BE_BUN=1` on `process.execPath` only as the fallback when no Bun is found.**
- `BUN_BE_BUN` works (item 7). As the primary, though, it would make the worker and daemon's `process.execPath` equal `…/claude-mem`, which breaks `isBunExecutablePath` and the Chroma process-name checks.
- It would also pin the worker to the Bun version that was current at launcher compile time, while `worker-service.cjs` auto-updates. That defeats "version-stable launcher".
- `findBun` keeps the worker on the user's real `bun`, exactly as today. The fallback keeps fail-open behavior intact on machines where Bun was removed.
- In both cases, compile the launcher with `--no-compile-autoload-dotenv` (item 6).
