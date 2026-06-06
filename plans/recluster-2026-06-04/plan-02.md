# [plan-02] Spawn-Contract Templating — canonical ${CLAUDE_PLUGIN_ROOT} resolution across all hosts

## Defect

The shell/command strings claude-mem templates for hooks and MCP subprocesses are not portable across hosts. On Windows the same root cause recurs in many surfaces: `cmd.exe /c uvx … --with "pkg>=x"` lets the shell eat `>`/`<` redirect operators, `command:"sh"` reappears where `sh` is not on PATH, chroma-mcp/mcp-search die instantly or time out, bash hooks pop visible `cmd` windows, `where bun` breaks under GBK/UTF-8 usernames, and the PATH prelude spawns a fresh login shell on every hook. All are one defect: there is no single, host-aware spawn contract that quotes arguments and resolves the interpreter/root canonically.

## Children

- #2776 — Windows: chroma-mcp connection times out (-32000) despite healthy server + SDK 'poison' churn
- #2762 — Windows: cmd.exe /c uvx mangles `>`/`<` in `--with` version pins (one-line fix)
- #2757 — Windows: cmd.exe /c uvx `--with "onnxruntime>=1.20"` mangled by shell redirect operators
- #2716 — Regression (v13.4.0): chroma-mcp still dies instantly on Windows — #2701 cmd.exe quoting fix incomplete
- #2714 — Regression (v13.4.0): mcp-search fails on Windows -32000 — `command:"sh"` reappeared; sh not on PATH
- #2715 — Hook PATH prelude spawns a login shell on every hook (~0.27s × PostToolUse/UserPromptSubmit/Stop)
- #2755 — Windows + Claude Desktop: bash hooks spawn visible cmd windows on every event
- #2708 — `where bun` on Windows with Chinese (GBK/UTF-8) username
- #2706 — MCP keeps failing to connect (Windows)

## Fix sequence

Design doc: `plans/02-spawn-contract-templating.md`. Centralize argv construction with host-aware quoting (no shell redirect exposure for `uvx --with`); resolve interpreter/root once; avoid login-shell-per-hook; suppress console windows on Windows GUI hosts; encode-safe path handling under non-UTF-8 locales.

## Test matrix

| Host | Shell | Required behavior |
|---|---|---|
| Windows | cmd.exe | `uvx --with "pkg>=x"` reaches uvx intact; no `>`/`<` mangling |
| Windows | PowerShell / Desktop | no visible cmd windows; chroma-mcp + mcp-search connect |
| Windows | GBK username | `where bun` / spawn resolves |
| all | all | no login shell spawned per hook |

## Out of scope

Hook IO channel/exit discipline (plan-01); worker process lifecycle (plan-03).
