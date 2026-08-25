# claude-mem-pro: Cowork hook endpoints — drop-in spec

Two endpoints let hook-based clients that can't run the local worker (Cowork
cloud containers, CI, any remote harness) stream raw tool-use fragments to the
cloud and pull compiled context back. Pro runs the worker + observer
server-side; this is deliberately the same shape as the local pipeline so the
existing worker code path can be reused.

Client reference implementation: `scripts/cmem-hook.mjs` in the
`claude-mem-cowork` plugin (this package).

---

## Auth

Both endpoints reuse the existing `/api/mcp` bearer validation:
`Authorization: Bearer <api key>`. Invalid/missing key → `401
{"error":"invalid_token"}` (+ `WWW-Authenticate` per the OAuth work).
Clients also send `X-CMEM-Platform: cowork` — store it as `platformSource`
on everything created from the request.

---

## 1) POST /api/hooks/ingest

Accepts one **envelope** or a batch (spool flush).

```jsonc
// single
{
  "v": 1,
  "platform": "cowork",          // → platformSource
  "event": "observation",        // see event table
  "project": "cowork",           // client-configured project slug
  "session_id": "abc123",        // harness session id (namespace per platform+key)
  "ts": 1755900000,              // client unix seconds (server also stamps received_at)
  "payload": { ... }             // event-specific, below
}

// batch (client spool flush, oldest first)
{ "v": 1, "batch": [ { ...envelope }, ... ] }
```

**Response**: `202 {"accepted": N}`. Never block the client on synthesis —
enqueue and return. Per-envelope failures inside a batch are dropped server-side
(client already treats the batch as fire-and-forget).

**Limits**: request body ≤ 256 KB (client truncates fields to 16 KB); rate
limit per key ~120 req/min (client fires ≤1 per tool call). Oversize → `413`,
rate → `429`; client spools and retries later — both are safe to return.

### Event table → worker mapping

| `event` | payload fields | worker equivalent |
|---|---|---|
| `session-start` | `session_id, cwd, source` | `hook claude-code context` (registration half) |
| `session-init` | `session_id, cwd, prompt` (≤4 KB) | `hook claude-code session-init` |
| `observation` | `session_id, cwd, tool_name, tool_use_id, tool_input, tool_response` (each ≤16 KB) | `hook claude-code observation` |
| `subagent-stop` | `session_id, agent_id, agent_type, tool_use_id` | (new — closes an agent scope) |
| `summarize` | `session_id, cwd` | `hook claude-code summarize` |
| `session-end` | `session_id, reason` | session close |

### Ingestion semantics (reuse the local pipeline)

- An `observation` envelope is exactly a **PendingMessage tool-use fragment**:
  push into the per-session in-RAM queue (`SessionMessageBuffer`), dedupe by
  `tool_use_id` — identical to what local hooks feed the worker. The observer
  generator, response parsing, and DB writes are unchanged.
- Cloud caveat the local buffer never had: sessions arrive from many keys.
  Bound the per-session buffer and evict idle sessions (no fragment for
  ~30 min → force a summarize pass and drop the buffer). Don't inherit the
  unbounded-RAM behavior (#3588).
- `session-init` carries the user prompt → same role as local session-init
  (observer context for the turn).
- `summarize` / `session-end` trigger the same summarize path as local Stop.
- Dedupe batch replays: `(api_key, platform, session_id, tool_use_id)` unique
  for observations; other events are idempotent by `(session_id, event, ts)`.

---

## 2) GET /api/hooks/context

Compiles the injection block server-side (client caps at ~6 KB and wraps in
`<claude-mem-context>` tags itself — return plain text/markdown, no wrapper).

```
GET /api/hooks/context?project=cowork&scope=session-start
GET /api/hooks/context?project=cowork&scope=agent&q=<first 500 chars of agent prompt>
GET /api/hooks/context?project=cowork&scope=status        // cheap auth/health probe
```

**Response**: `200 {"context": "…markdown…", "count": 12}`.
Empty memory → `200 {"context": ""}` (client injects nothing).
`scope=status` → `200 {}` is fine; it's only used by the diagnostics CLI.

**Content**, same recipe as local SessionStart injection:

- `session-start`: recent-observation timeline for `project` (most recent
  sessions first, timestamped one-liners), same selection the local
  `context` hook compiles. Include cross-platform observations — that's the
  whole point of Cowork↔Code continuity.
- `agent`: rank by relevance to `q` (memory_search under the hood), ~10 items.
- Target ≤ 5 KB. The client truncates anyway; don't bother paginating.

### Client fallback to /api/mcp (already live)

Until this endpoint deploys, the plugin falls back to JSON-RPC
`tools/call memory_search` against `/api/mcp` (stateless attempt first, then
`initialize` handshake honoring `Mcp-Session-Id`). Nothing to build — just be
aware injected context = raw memory_search text until `/api/hooks/context`
ships, so shipping it is what makes injection quality match local.

---

## Rollout order

1. `/api/hooks/context` (read-only, low risk) → good injection immediately.
2. `/api/hooks/ingest` wired into the existing worker queue → Cowork sessions
   start generating observations.
3. Optional later: per-event ack ids + client-side exactly-once, WebSocket
   push, and a `platformSource='cowork'` slice in the admin metrics strip.
