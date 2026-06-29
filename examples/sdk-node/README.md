# `claude-mem` SDK — Plain-Node Example

A minimal Node script that proves the headline requirement of the
`claude-mem/sdk` package: **capture, compress, and search observations
in-process, with no worker process running.**

The example calls, in order:

1. `createCmemClient({ databaseUrl })` — opens the Postgres pool, bootstraps
   the schema, resolves tenancy, and starts the `uvx chroma-mcp` subprocess.
2. `client.captureAndGenerate({ ... })` — persists an `agent_event` row,
   creates a `queued` generation job, then runs the inline provider
   (Claude / Gemini / OpenRouter) and writes the resulting `observation`
   row plus the `observation_sources` link in a single Postgres transaction.
3. `client.search({ query: 'OAuth' })` — runs a semantic search against
   Chroma and hydrates the matching observations back from Postgres.
4. `client.context({ query: 'OAuth' })` — same as `search` but returns the
   observations' `content` joined with `\n\n` for direct injection into a
   prompt.
5. `await client.close()` — closes Chroma + the SDK-owned pool.

## Prerequisites

- **Postgres**, with the connection URL exported as
  `CLAUDE_MEM_SERVER_DATABASE_URL`. The SDK runs idempotent schema
  bootstrap on construction, so an empty database is fine.
- **`uvx`** on `PATH`. The SDK spawns a `uvx chroma-mcp` subprocess for
  semantic search; Chroma is required (see `src/sdk/index.ts` and the
  plan's Executive Decision). Install with the
  [astral-sh/uv](https://docs.astral.sh/uv/) one-liner.
- **One provider API key**, depending on which generator you want:
  - `ANTHROPIC_API_KEY` (default)
  - `GEMINI_API_KEY` (`CLAUDE_MEM_SERVER_PROVIDER=gemini`)
  - `OPENROUTER_API_KEY` (`CLAUDE_MEM_SERVER_PROVIDER=openrouter`)

## Run

From this directory:

```bash
npm install
CLAUDE_MEM_SERVER_DATABASE_URL=postgres://user:pass@host:5432/db \
ANTHROPIC_API_KEY=sk-ant-... \
  node index.mjs
```

That's it. **No worker or daemon required** — no `claude-mem worker start`,
no `claude-mem server start`, no Redis, no Express. The SDK does the
compression inline and persists everything to Postgres + Chroma in one
process.

## What you'll see

Roughly:

```
[sdk-node-example] creating client (no worker required)...
[sdk-node-example] client ready (teamId=…, projectId=…)
[sdk-node-example] capturing + generating one observation...
[sdk-node-example] generated observations: [
  { "id": "…", "kind": "discovery", "content": "Implementing OAuth flow with PKCE…" }
]
[sdk-node-example] searching for "OAuth"...
[sdk-node-example] search returned 1 result(s) (chroma=true, degraded=false):
  - …: Implementing OAuth flow with PKCE…
[sdk-node-example] context (… chars, degraded=false):
---
Implementing OAuth flow with PKCE…
---
[sdk-node-example] client closed. No worker was running at any point.
```

If `chroma=false` and `degraded=true`, your `uvx chroma-mcp` subprocess
died between `createCmemClient` returning and the `search` call. The SDK
fell back to Postgres FTS so the call still returned hits, but the next
`createCmemClient` (cold start) will reject until `uvx chroma-mcp` can
launch again. See [`docs/public/sdk.mdx`](../../docs/public/sdk.mdx) for
the degraded-mode contract.

## Where the data lives

- **Observations, events, jobs, sessions** — in the Postgres database at
  `CLAUDE_MEM_SERVER_DATABASE_URL`. The schema is created on first run.
- **Chroma vectors** — in `~/.claude-mem/chroma/` (or
  `$CLAUDE_MEM_DATA_DIR/chroma/`).
- **Default tenancy** — `$CLAUDE_MEM_DATA_DIR/sdk-tenant.json`. Production
  consumers should pass explicit `teamId` and `projectId` to
  `createCmemClient` and skip this file entirely.
