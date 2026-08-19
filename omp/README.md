# Claude-Mem for OMP (Oh My Pi)

An [OMP](https://omp.sh) hook adapter that records OMP sessions into the same
claude-mem store that Claude Code, Cursor, and OpenCode already write to —
one shared memory across all your agents.

OMP loads hook modules from `~/.omp/agent/hooks/pre/*.ts` (user-global) or
`<cwd>/.omp/hooks/pre/*.ts` (per-project) on every session start. This hook
translates OMP lifecycle events into claude-mem's REST V1 event shape, so no
OMP-side plugin or modification is required.

## How it works

| OMP event | claude-mem endpoint | Purpose |
|---|---|---|
| `session_start` | — | Mint a process-stable `contentSessionId` |
| `before_agent_start` | `POST /api/sessions/init` | Create/continue the claude-mem session (records the real user prompt) |
| `tool_result` | `POST /api/sessions/observations` | Record each tool call (fire-and-forget) |
| `context` | `GET /api/context/inject` | Inject memory from past sessions into the prompt (60s cache) |
| `session_shutdown` | `POST /api/sessions/summarize` | Finalize the session summary |

Behavioral notes (matching the OpenClaw adapter's conventions):

- `contentSessionId` is stable for the lifetime of an OMP process and rotates on
  compaction — never per user prompt, so observations stay grouped.
- All POSTs are fire-and-forget detached chains; the hook never blocks tool
  dispatch (the extension runner's 30s handler cap is never approached).
- `memory_*` tool results are skipped to avoid recursion.
- `tool_response` is capped at 1000 characters; `tool_input` is passed raw.
- A circuit breaker opens for 30s after 3 consecutive worker failures.
- The worker port resolves from `CLAUDE_MEM_WORKER_PORT` or the default
  `37700 + (uid % 100)`.
- The `context` handler always preserves the original conversation — it
  re-spreads `event.messages` and appends exactly one system message.

## Install

Requires a running claude-mem worker (installed via `npx claude-mem install`).

```bash
npx claude-mem install --ide omp
```

This copies `omp/hooks/claude-mem.ts` to `~/.omp/agent/hooks/pre/claude-mem.ts`,
where OMP auto-discovers it for every session. No restart of OMP is needed —
the hook loads at the next session start.

Manual install (no claude-mem CLI):

```bash
mkdir -p ~/.omp/agent/hooks/pre
cp omp/hooks/claude-mem.ts ~/.omp/agent/hooks/pre/claude-mem.ts
```

## Uninstall

```bash
npx claude-mem uninstall   # removes the OMP hook along with all other integrations
```

Or manually:

```bash
rm ~/.omp/agent/hooks/pre/claude-mem.ts
```

## Verify

Run a session in OMP, make at least one tool call, then:

```bash
npx claude-mem search "your project"
```

Observations from the OMP session appear alongside Claude Code / Cursor
observations under the same project (platform source `omp`), and
`~/.claude-mem/claude-mem.db` gains an `sdk_sessions` row with
`platform_source = 'omp'`.

## Development

The hook is a single self-contained TypeScript module with no runtime
dependencies (`import type` is erased at load). To test against a live OMP
installation, copy the file into a project's `.omp/hooks/pre/` and run:

```bash
omp --print "Use the bash tool to run: pwd. Then finish."
```

Then confirm the observation landed in claude-mem's database:
`SELECT * FROM sdk_sessions WHERE platform_source = 'omp';`
