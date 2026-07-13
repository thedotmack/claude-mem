# Agy CLI Provider Design

## Goal

Add `agy-cli` as an independent claude-mem observation provider backed by the locally installed Antigravity CLI. This supersedes the separate Gemini CLI observation-provider proposal without changing claude-mem's existing Gemini CLI hook integration.

## Verified CLI Contract

The implementation targets the locally verified `agy` 1.0.10 contract:

- `agy --add-dir <cwd> --print <prompt>` creates a project-scoped conversation and prints only the assistant response to stdout.
- `--log-file <path>` records `Created conversation <uuid>` for a new conversation.
- `agy --conversation <uuid> --print <prompt>` resumes that exact conversation.
- `--model <name>` is optional; omitting it uses the Antigravity default.
- `--print-timeout <duration>` bounds the CLI wait.
- The CLI has no Gemini-compatible JSON output or token statistics.

## Considered Approaches

### 1. Native provider with stable conversation IDs — selected

Create `AgyCliProvider`, capture a new conversation UUID from a per-invocation log file, store it as the claude-mem `memorySessionId`, and resume with `--conversation` on later turns. This preserves session isolation and matches the existing provider lifecycle.

### 2. Replace or wrap `gemini-cli` — rejected

The CLIs have incompatible invocation and output contracts. Reusing the provider name would also make existing configurations ambiguous and remove a working rollback path.

### 3. Use `--continue` or replay all history — rejected

`--continue` is global and can attach to a manually created Antigravity conversation. Replaying history creates large prompts and loses durable conversation identity. Neither is safe for concurrent claude-mem sessions.

## Architecture

### Provider

`src/services/worker/AgyCliProvider.ts` owns:

- executable resolution from `CLAUDE_MEM_AGY_CLI_PATH`, then `PATH`, then `~/.local/bin/agy`;
- one-shot process execution with stdout, stderr, timeout, and abort handling;
- unique log-file allocation and cleanup;
- fresh conversation ID extraction using the exact `Created conversation <uuid>` log record;
- persisted conversation restoration after worker restarts;
- resume fallback: only a classified missing-conversation failure may create a replacement conversation;
- response delivery through the existing `processAgentResponse` pipeline;
- conservative token estimates because agy exposes no token counts.

The first prompt includes the active mode's system identity, observer role, and XML-only output requirement. The conversation retains those instructions for later observation and summary turns.

### Configuration

Add these settings:

- `CLAUDE_MEM_PROVIDER=agy-cli`
- `CLAUDE_MEM_AGY_CLI_PATH` (optional, default discovery)
- `CLAUDE_MEM_AGY_CLI_MODEL` (optional; omitted means Antigravity default)
- `CLAUDE_MEM_AGY_CLI_TIMEOUT_MS` (default `300000`, matching agy's five-minute print default)

Expose `agy-cli` in settings validation, the installer, and the viewer provider selector.

### Worker Routing

Instantiate one `AgyCliProvider` in `WorkerService`, pass it to `SessionRoutes`, and select it whenever `CLAUDE_MEM_PROVIDER` is exactly `agy-cli`. Executable resolution failures remain on the Agy path and surface as configuration errors instead of silently falling back to Claude. Provider labels emitted to logs and response processing use `AgyCli`.

## Error Handling

- Missing executable: unrecoverable configuration failure with an actionable install/path message.
- Abort: send `SIGTERM`, escalate to `SIGKILL` after a grace period, wait for process exit, then propagate an `AbortError`.
- Timeout: terminate the child and classify as transient.
- Missing conversation: classify separately and retry once with a fresh conversation.
- Authentication, permission, or quota failures: classify from stderr plus the agy log file; never infer failure from noisy authentication warnings when the process exits successfully.
- Successful exit without a fresh conversation UUID: transient failure; do not use `--continue`.
- Successful empty stdout: consume the turn and log a warning without manufacturing an observation.

## Testing

- Unit-test conversation UUID extraction, error classification, timeout parsing, executable discovery, provider selection, and settings validation.
- Test worker routing and provider labels.
- Run focused provider/settings tests, TypeScript checks, the complete build, and the full test suite.
- Perform a real local smoke test for fresh and resumed conversations; keep it outside automated CI because it depends on the Antigravity desktop session.

## Scope Boundaries

- No changes to Antigravity hooks or the OpenCLI adapter.
- No automatic permission bypass flag.
- No changes to the existing Gemini CLI hook integration.
- No reliance on global active-conversation state.
