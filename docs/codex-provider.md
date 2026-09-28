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

### Concurrent requests

`CLAUDE_MEM_CODEX_MAX_CONCURRENT_AGENTS` defaults to `2` (integer 1–8; invalid values use 2). Restart the worker after changing it. Requests enter a FIFO pool of exclusive app-server clients, each with its own private workspace and process. Queued cancellation does not send a request; shutdown cancels work and closes every client. Quota/setup admission is checked immediately before sending, and failures publish cooldowns before the slot is reused. Already admitted concurrent requests may still finish after a quota failure.

### Observation backlog batching

Codex immediately combines up to `CLAUDE_MEM_CODEX_OBSERVATION_BATCH_SIZE=8` observations (integer 1–32). The rendered observation turn is capped by `CLAUDE_MEM_CODEX_OBSERVATION_BATCH_MAX_CHARS=32000` (integer 4000–128000); invalid settings use defaults. This budget excludes prior conversation history. There is no wait to fill a batch. FIFO summaries, prompt numbers, working directories, and agent attribution changes stop a batch. Each input retains its timestamp, tool fields, tool-use ID and pending ID. Oversized next items run separately through existing field compression; an oversized first item uses explicit field elision after compression to respect the cap. Metadata too large to fit pauses with the item retained.

Only included items are claimed, and the existing response/storage path acknowledges them after an accepted response (including an explicit skip). Errors, quota pauses, aborts and conversation recycling retain buffered work. Other providers keep single-observation requests. The queue remains in RAM: process crashes still require transcript replay.

Validation: the focused Codex pool/client/provider/batch, session-buffer, shared init/summary, and recycle suites pass (78 tests; 16 POSIX-only transport tests skipped on Windows). `bun run typecheck` checks both worker and viewer. Live Codex throughput and POSIX subprocess behavior still need validation on their target runtime.
