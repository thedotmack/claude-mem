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
| `CLAUDE_MEM_CODEX_PATH` | `codex` | CLI executable, resolved through PATH unless an explicit path is supplied. Set it in `settings.json` or the environment; the settings API does not accept executable paths. |

Each request uses the observer's shared deadline, `CLAUDE_MEM_LLM_TIMEOUT_MS`
(180 seconds by default); oversized-field condensation uses
`CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS`, as it does for every provider.

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

Failures are handled like every other observer provider's, and buffered work is
kept for the next attempt:

- A spent usage limit or a refused login pauses Codex requests behind the
  provider breaker; one request re-probes every 30 minutes, and a served
  request clears it. A request already waiting for the app-server is withheld
  while the breaker is armed instead of earning the same refusal.
- A missing CLI or ChatGPT login (or an auth file other users can read) is
  reported as `codex_cli` setup in `/api/health`; Codex starts wait 5 minutes
  between recovery probes.
- Timeouts and connection faults resume on the observer's transport backoff.

When testing from source, build the worker with `node scripts/build-hooks.js`
before starting it. Release versions and generated distribution files are not
changed by this contribution.

### Concurrent requests

`CLAUDE_MEM_CODEX_MAX_CONCURRENT_AGENTS` defaults to `2` (integer 1-8; invalid values use 2). Set it in settings.json; the settings API does not expose this key. Restart the worker after changing it. Requests enter a FIFO pool of exclusive app-server clients, each with its own private workspace and process. Queued cancellation does not send a request; shutdown cancels work and closes every client. Quota/setup admission is checked immediately before sending, and failures publish cooldowns before the slot is reused. Already admitted concurrent requests may still finish after a quota failure.
