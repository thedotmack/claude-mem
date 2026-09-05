# Codex Subscription Provider

Use an existing ChatGPT subscription through a locally installed Codex CLI.
No OpenAI API key is used, and failures do not fall back to another provider.

1. Install Codex CLI and run `codex login` as the user running claude-mem.
2. Set `CLAUDE_MEM_PROVIDER` to `codex` in claude-mem's `settings.json`.
3. Restart the claude-mem worker.

Optional settings:

| Setting | Default | Purpose |
| --- | --- | --- |
| `CLAUDE_MEM_CODEX_MODEL` | empty | Use Codex's default model, or name a model available to your subscription. |
| `CLAUDE_MEM_CODEX_REASONING_EFFORT` | empty | Use Codex's default effort, or an effort supported by the selected model. |
| `CLAUDE_MEM_CODEX_PATH` | `codex` | CLI executable, resolved through PATH unless an explicit path is supplied. |
| `CLAUDE_MEM_CODEX_TIMEOUT_MS` | `120000` | Per-request timeout in milliseconds. |

The provider uses `codex app-server` over stdio. It reuses claude-mem's existing
observation, summary, payload compression and persistence workflow. Requests
use ephemeral threads in a private workspace with tools, MCP servers, hooks
and project instructions disabled. The CLI manages subscription authentication;
claude-mem does not store credentials in its own settings.

File-backed ChatGPT login in `CODEX_HOME/auth.json` (or `~/.codex/auth.json`) is
required. On Unix, the auth file must be owned by the worker user and private
to that user. API-key login is rejected. Use a Codex CLI version that supports
app-server ephemeral threads and instruction-source attestation; unsupported
protocol responses fail rather than silently relaxing isolation.

Quota failures use the existing provider cooldown. Failed Codex batches remain
pending for recovery after authentication, quota or transport problems are
resolved. Changing providers, installation and service management retain their
existing behavior.

When testing from source, build the worker with `node scripts/build-hooks.js`
before starting it. Release versions and generated distribution files are not
changed by this contribution.
