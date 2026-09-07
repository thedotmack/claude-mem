# RECEIPT-JOIN — tool_uses ↔ expense tallies

**Stamp:** 2026-09-06 (PT), implementation landed 2026-09-07 · Tool SQLite ↔ Receipt  
**Status:** SHIPPED — schema v51 matches this contract; `tool_uses` exists in `~/.claude-mem/claude-mem.db`  
**Authority split:** Claude-Mem `tool_uses` = identity / DISTINCT COUNT. OpenRouter stamps + spend log = **$**. Never put `cost_usd` / micros on `tool_uses` as authority.

---

## Frozen join keys

| Claude-Mem `tool_uses` | Receipt / spend log | Use |
|---|---|---|
| `content_session_id` | ↔ `or_session_id` via convention below | Session/job grouping |
| `tool_name` | ↔ tally `groupBy: 'tool'` label | Feature/tool rollup |
| `tool_use_id` | DISTINCT COUNT preferred over `or_trace.tool_calls` int | Usage counts |
| `project` | filter | Scope |
| `agent_id` | filter | Seat/agent |
| `created_at_epoch` | period | Time window |
| `observation_id` (nullable) | optional later | Claude-Mem back-reference. **Batch pointer, not 1:1** — see caveat below |
| `or_generation_id` (nullable) | ↔ spend-log / Ledger `or_generation_id` (`gen-…`) | **Cash-line join** when tool sat inside a stamped OR/inference call |
| `or_session_id` (nullable, exact stamp echo) | ↔ spend-log `or_session_id` | Prefer this when present over reconstructed `job:`+id |

**Do not add:** `cost_usd` / micros on `tool_uses`.

---

## `content_session_id` ↔ `or_session_id` string format

Receipt stamps OpenRouter via `buildOrStamp` (`/workspace/mem-invoice/src/or/stamp.ts`):

```text
or_session_id  =  "job:" + runId     # ≤256 chars; body field session_id
```

Claude-Mem hooks store the platform session id as `content_session_id` (Claude Code / Cursor / grok-bot session UUID — **no** `job:` prefix).

### Required stamp convention (so they match)

When a paid OR call is associated with a Claude-Mem session, stampers **must** set:

```text
runId = <claude-mem content_session_id>
⇒ or_session_id = "job:" + content_session_id
```

**Join recipe (COUNT / session filter):**

1. If `tool_uses.or_session_id` is non-null → equality join to spend-log `or_session_id` (exact).
2. Else → `spend.or_session_id = 'job:' || tool_uses.content_session_id`

**Anti-patterns**
- Stamping `session_id` with a bare UUID while expecting a direct equality to `content_session_id` (prefixes won’t match).
- Stamping a different `runId` (expense-report id, random job id) without also writing that same string onto `tool_uses.or_session_id`.
- Truncating either side — `buildOrStamp` throws on over-long ids; keep that.

### Examples

| content_session_id | Correct or_session_id |
|---|---|
| `a1b2c3d4-…` | `job:a1b2c3d4-…` |
| `cmem-sess-9f` | `job:cmem-sess-9f` |

MemBench offline aggregates may use `job:membench:<runHash>` — those will **not** auto-join `tool_uses` unless the same string is stored on `tool_uses.or_session_id`.

---

## Cash attribution

- **COUNT tool usages:** `COUNT(DISTINCT tool_use_id)` filtered by session/project/tool_name/period.
- **Attribute $ to a tool row:** only when `or_generation_id` is set and matches a measured spend-log / Ledger line. Without it, COUNT by session+tool is still valid; micros stay on the OR generation line.
- Interim Receipt path (`or_trace.tool` + `or_trace.tool_calls`) remains until `tool_uses` is the durable COUNT source.

---

## Schema columns (SHIPPED)

Migration **v51**, `src/services/sqlite/tool-uses.ts` (DDL) + `SessionStore.ensureToolUsesTable()`.
Exactly the frozen set — nullable `or_generation_id`, nullable `or_session_id`, no cost columns:

```sql
CREATE TABLE tool_uses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_use_id TEXT NOT NULL,
  content_session_id TEXT NOT NULL,
  memory_session_id TEXT,
  session_db_id INTEGER,
  project TEXT NOT NULL,
  platform_source TEXT NOT NULL DEFAULT 'claude',
  tool_name TEXT NOT NULL,
  tool_input TEXT,
  tool_response TEXT,
  cwd TEXT,
  prompt_number INTEGER,
  agent_type TEXT,
  agent_id TEXT,
  observation_id INTEGER,
  or_generation_id TEXT,
  or_session_id TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  UNIQUE(content_session_id, tool_use_id)
);
```

Indexed: `project`, `memory_session_id`, `content_session_id`, `session_db_id`,
`tool_name`, `created_at_epoch`, `observation_id`, `or_generation_id`.

---

## Read API for Receipt (prefer HTTP over opening the SQLite file)

The worker owns the DB handle; reading the file directly races the writer.

### `GET /api/tool-uses` — index / tally listing

Query params: `project`, `session` (= `content_session_id`), `memorySessionId`,
`tool_name` (comma-separated), `agentId`, `dateStart`, `dateEnd` (epoch ms),
`limit` (default 50, max 500), `offset`, `orderBy` (`date_desc` | `date_asc`).

Returns a **cheap** shape — identity, join keys, and size hints only. It never
returns `tool_input` / `tool_response`:

```json
{
  "count": 1,
  "toolUses": [{
    "id": 7,
    "tool_use_id": "toolu_01ABC",
    "tool_name": "Read",
    "project": "claude-mem",
    "content_session_id": "…",
    "memory_session_id": "…",
    "platform_source": "claude",
    "agent_id": null,
    "agent_type": null,
    "observation_id": 99,
    "or_generation_id": "gen-abc",
    "or_session_id": "job:…",
    "prompt_number": 2,
    "created_at": "2026-09-07T00:00:00.000Z",
    "created_at_epoch": 1757203200000,
    "tool_input_bytes": 25,
    "tool_response_bytes": 11
  }]
}
```

This is the endpoint for a tally: page it with `limit`/`offset` and count.

### `POST /api/tool-uses/batch` — raw bodies, by id only

Body: `{ "ids": [...], "limit"?, "project"?, "contentSessionId"? }`. `ids` accepts
numeric `tool_uses.id` or opaque `tool_use_id` strings. **Required and
non-empty** — there is deliberately no way to page the whole table of raw
payloads. Receipt should not normally need this endpoint at all.

Also exposed as the `get_tool_uses` MCP tool (progressive-disclosure layer 4).

---

## Caveats Receipt should know

**`observation_id` is a batch pointer, not a per-call mapping.** The observer
summarizes a *batch* of tool calls into one or more observations; every tool use
in that batch is linked to the batch's FIRST observation id, and the link is
never overwritten once set. Use it to navigate back to a summary — do not treat
it as "this observation cost this tool call". The reliable per-call identity
stays `(content_session_id, tool_use_id)`.

**Rows can be missing, and that is by design.** A tool call is absent from
`tool_uses` when: the platform gave no `tool_use_id`; the project is excluded;
the prompt was marked private; the tool is in `CLAUDE_MEM_SKIP_TOOLS`; or the
tool is one of claude-mem's own disclosure tools (`memory_*`, and the
claude-mem MCP `search` / `timeline` / `get_observations` / `get_tool_uses`),
which are skipped to stop the table growing every time it is read. Tallies
should be read as "tool calls claude-mem observed", never "all tool calls".

**Payloads are capped at 64 KB** with a `…[truncated: N bytes]` marker; a
truncated value is no longer valid JSON. `content_hash` is computed over the
original pre-truncation payload, so it still distinguishes two oversized bodies
that share a prefix.

**Replay updates, it does not duplicate.** `UNIQUE(content_session_id,
tool_use_id)` + upsert; a later replay can fill a `tool_response` the first
write lacked. `COUNT(DISTINCT tool_use_id)` is still the recommended tally
because it is correct regardless.

---

## Contact

Tool SQLite owns Claude-Mem table + HTTP/`get_tool_uses`. Receipt owns spend log + tally. Ping Tool SQLite if join keys need a change after freeze.
