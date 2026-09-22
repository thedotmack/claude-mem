# Why this fork exists

This fork keeps **Claude Code as the primary coding agent** while allowing Claude-Mem's
observation, compaction, and session-summary inference to run through the **OpenCode CLI**.

The goal is narrow:

- Claude Code continues to run the development session.
- Claude-Mem continues to capture Claude Code hooks, store observations, build summaries,
  index memory, and expose that memory back to future Claude Code sessions.
- The expensive/high-volume memory-processing calls can be delegated to a model available
  through OpenCode, including free OpenCode models.
- OpenCode is used only as a non-interactive inference transport. This fork does **not**
  turn OpenCode into the primary coding agent and does not install a Claude-Mem OpenCode host plugin.

This is intentionally different from broader OpenCode integration work in other forks.

## Motivation

Claude-Mem is useful precisely when new Claude Code sessions are started frequently:
the durable memory layer preserves decisions, discoveries, files touched, completed work,
and next steps across those short-lived contexts.

That creates a second stream of model usage, however. The coding model and the memory model
do not need to be the same model or even come from the same provider.

For this workflow:

```
Claude Code CLI
      |
      | hooks / observations / stop summaries
      v
  Claude-Mem
      |
      | observer inference
      v
 OpenCode CLI
      |
      v
 free / inexpensive model
      |
      v
 SQLite + semantic memory
      |
      v
future Claude Code sessions
```

Claude remains responsible for coding. OpenCode is just the inference boundary used by the
Claude-Mem observer.

## Why not use the earlier OpenCode-provider fork unchanged?

An earlier implementation proved that invoking `opencode run --format json` as a Claude-Mem
provider is practical. It also mixed that provider work with broader OpenCode host/plugin
integration and could run the summarizer with agent permissions inappropriate for a memory
compression worker.

A summarizer receives extremely hostile input by construction:

- source code,
- shell output,
- tool results,
- logs,
- web content,
- generated text,
- comments and README files,
- and arbitrary text copied into a Claude session.

Any of those can contain prompt-injection instructions.

A memory summarizer does not need filesystem, shell, web, MCP, subagent, or editing access.
Giving it those capabilities creates risk without adding useful functionality.

This fork therefore ports only the provider concept and deliberately makes the OpenCode
process **tool-less by default**.

## Security model

The OpenCode provider is launched with defense in depth rather than relying on a prompt saying
"do not use tools".

### 1. Dedicated neutral workspace

OpenCode runs under:

```
~/.claude-mem/opencode-summarizer/workspace
```

It does not run in the repository being observed. That prevents normal project-local
`opencode.json`, `.opencode/`, AGENTS files, and repository instructions from becoming part
of the summarizer's execution environment.

### 2. Isolated XDG config

The child process receives a separate `XDG_CONFIG_HOME` under Claude-Mem's data directory.

This intentionally prevents the summarizer from loading the user's normal global OpenCode
configuration, plugins, MCP definitions, and global instructions.

OpenCode provider authentication is normally stored separately in its data/auth store, so
regular authenticated providers remain available. A provider that exists *only* because of
custom entries in the user's normal OpenCode config may not be available in this isolated mode.

That tradeoff is intentional: secure isolation is the default.

### 3. Inline deny-all agent

The provider injects a temporary `claude-mem-summarizer` primary agent through
`OPENCODE_CONFIG_CONTENT`.

Both the global inline config and the agent itself specify deny-all permissions and disabled
tools.

The child also receives `OPENCODE_PERMISSION={"*":"deny"}`.

### 4. No Claude Code prompt/skills inheritance

The child disables OpenCode's Claude Code compatibility prompt and skill loading. The
summarizer should receive only the Claude-Mem observer conversation supplied over stdin.

### 5. Plugins and auxiliary features disabled

The invocation uses `--pure` and disables default plugins, auto-sharing, auto-update checks,
LSP downloads, and Exa.

### 6. Prompt sent through stdin

Session content is never placed in the process command line. This avoids command-line length
limits and keeps transcript text out of normal process listings.

### 7. No shell interpolation

The OpenCode binary is spawned directly with an argv array and `shell: false`.
Model names are validated before being placed in argv.

### What this isolation does not guarantee

This is **application-level isolation, not an operating-system sandbox**. It prevents the model
from being intentionally given OpenCode tools and keeps ordinary user/project OpenCode
configuration out of the worker, but it does not sandbox the OpenCode executable itself.
OpenCode is still a trusted local program running as your user.

System-managed OpenCode configuration may also have higher precedence than user configuration.
If your environment requires a hard process/filesystem/network boundary, run the memory worker
inside an OS/container sandbox in addition to these controls.

## Important boundary: model privacy

Tool isolation does **not** make a remote model local.

If `CLAUDE_MEM_OPENCODE_MODEL` selects a hosted/free model, the text Claude-Mem sends for
observation and summarization is sent to that model's provider through OpenCode.

That text can contain:

- source code,
- file paths,
- tool inputs and outputs,
- architecture details,
- logs,
- and other content from the Claude Code session.

Use a hosted model only if that data handling is acceptable for the project.

For private work, configure OpenCode to use an appropriate local model/provider.

## Configuration

In `~/.claude-mem/settings.json`:

```json
{
  "CLAUDE_MEM_PROVIDER": "opencode",
  "CLAUDE_MEM_OPENCODE_MODEL": "provider/model"
}
```

Optional executable override:

```json
{
  "CLAUDE_MEM_OPENCODE_PATH": "/absolute/path/to/opencode"
}
```

If `CLAUDE_MEM_OPENCODE_MODEL` is empty, OpenCode chooses its default model. For predictable
cost behavior, explicitly set a model.

Use:

```bash
opencode models
```

to see model IDs available in the installed OpenCode version.

## What this fork changes

The fork adds:

- `src/services/worker/OpenCodeProvider.ts`
  - invokes `opencode run` non-interactively,
  - parses JSON event output,
  - reports token usage when OpenCode provides it,
  - classifies common auth/quota/rate-limit/setup errors,
  - applies the isolation controls described above.
- provider dispatch support for `CLAUDE_MEM_PROVIDER=opencode`.
- worker/session routing support for the new provider.
- settings keys:
  - `CLAUDE_MEM_OPENCODE_MODEL`
  - `CLAUDE_MEM_OPENCODE_PATH`
- quota-breaker typing for OpenCode.
- tests for safety configuration, output parsing, error classification, model validation,
  and provider selection.

## What this fork deliberately does not change

It does **not**:

- install a Claude-Mem plugin into OpenCode,
- modify `~/.config/opencode/AGENTS.md`,
- register Claude-Mem MCP inside OpenCode,
- use OpenCode as the session-capture host,
- auto-approve permissions,
- use `--auto` or `--dangerously-skip-permissions`,
- give the summarizer filesystem or shell access.

The primary host remains Claude Code.

## Upstream relationship

The intent is to keep this fork easy to rebase on
[thedotmack/claude-mem](https://github.com/thedotmack/claude-mem).

The OpenCode functionality is therefore isolated to one provider and small dispatch/wiring
changes rather than introducing a second full host integration.

If an equivalent secure provider is accepted upstream, this fork should ideally become
unnecessary.
