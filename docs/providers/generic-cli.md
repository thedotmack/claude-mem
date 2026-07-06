# Generic CLI Provider (Kimi Code)

`GenericCliProvider` lets claude-mem use any CLI-based LLM agent for observation/summary compression, instead of the default Claude SDK (which consumes your Claude subscription quota). The flagship target is [Kimi Code](https://code.kimi.com), but any CLI with a `-p "<prompt>"` interface and a resumable-session model works.

## Why

By default, claude-mem's background compression runs through `ClaudeProvider` + Claude OAuth, so every `PostToolUse` observation and session summary consumes your Claude subscription — mixed into the same bill as Claude Code, with no way to attribute it. Routing compression to a separate CLI subscription (Kimi Code) isolates the cost.

## Configure

1. **Install the CLI** (Kimi Code) so `kimi` is on `PATH`:
   ```bash
   kimi --version
   ```

2. **Enable the provider** in `~/.claude-mem/settings.json`:
   ```json
   {
     "CLAUDE_MEM_PROVIDER": "generic-cli"
   }
   ```

3. **Restart the worker** (the next `SessionStart`/`PostToolUse` hook auto-spawns it):
   ```bash
   npx claude-mem stop
   ```

4. **Verify**:
   ```bash
   curl --noproxy '*' localhost:37700/api/health | jq .ai.provider
   # → "generic-cli"
   ```

## How it works

- Each observation/summary query spawns `kimi -p "<prompt>" --output-format text`.
- The first call (init) is a fresh spawn. The resume marker (`To resume this session: kimi -r session_<uuid>`) is parsed from stdout/stderr and reused for subsequent calls (`kimi -r <session> -p ...`) to keep context cheap.
- **Transient retry** (3×, exponential backoff) covers spawn failures; **content-layer retry** (2×) re-issues with a correction prompt when kimi returns non-XML output, then falls back to `<skip_summary reason="xml_failed_after_retries"/>` so the worker never poisons the session.
- `CLAUDE_MEM_SKIP_TOOLS` filters noisy tool hooks (e.g. `Bash`, `Read`) from enqueuing observations at all.

## Session ID capture: stderr fallback

kimi `--output-format text` intermittently writes the resume marker to **stderr** instead of stdout (~11% of invocations observed). `queryOnce` therefore parses `sessionId` from stdout first and falls back to stderr — otherwise those sessions lose the real session id, keep the synthetic placeholder stamped by `startSession`, and hit `kimi -r <synthetic>` → `Session not found` on every subsequent call.

## Limitations

- No real token accounting (`--output-format text` returns no usage); tokens are estimated as `chars/4` and only feed the history-truncation threshold, not telemetry.
- kimi response latency (30–60s typical) sets the spawn-timeout floor (`DEFAULT_SPAWN_TIMEOUT_MS = 120_000`).
- Resume-marker placement (stdout vs stderr) is not contractually guaranteed by kimi; the stderr fallback is a defensive measure, not a long-term contract.
