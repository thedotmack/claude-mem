# Kiro CLI hook payload fixtures

Stdin payloads that Kiro CLI (kiro.dev) delivers to agent-config hooks, one
file per lifecycle event. Consumed by `tests/cli/adapters/kiro.test.ts`, and
by the shell e2e that pipes them through `worker-service.cjs hook kiro <event>`
against an isolated worker.

## Provenance

**Live-captured from kiro-cli 2.11.0** (headless `chat --no-interactive`,
July 2026) via the probe below, with paths/prompts normalised. Deviations
from the kiro.dev docs discovered by the capture:

- The payload carries **no `session_id`** — the session UUID reaches the hook
  process as the `KIRO_SESSION_ID` environment variable instead (the adapter
  reads payload first, then the env var).
- `fs_read` batches reads: `tool_input` is `{"operations":[{"mode","path"},…]}`,
  not a flat `{path}`.
- `tool_response.result` is always an array (strings, or
  `{exit_status,stdout,stderr}` objects for `execute_bash`).
- `agentSpawn` also receives the `prompt` in headless mode.
- A custom agent with no `tools` field has NO tools at all.
- The MCP fixture (`post-tool-use-mcp.json`) remains doc-derived — not yet
  captured against a real MCP server.

Re-run the probe after Kiro CLI upgrades and diff against these fixtures.

## Live probe (Phase 0)

1. Install the probe agent: copy `probe/claude-mem-probe.json` to
   `~/.kiro/agents/claude-mem-probe.json`.
2. Run `kiro-cli chat --agent claude-mem-probe` in a scratch project; submit a
   prompt, let it read/write a file and run a shell command, then end the turn.
3. Inspect `/tmp/kiro-probe.log` — one JSON payload per line, prefixed with the
   event name.
4. Also record: does `session_id` change across `/compact`, `--resume`,
   `/chat new`? Does `postToolUse` fire for MCP tools? Is `timeout_ms: 120000`
   honoured (add a `sleep 45` hook and see if it survives)?
