# [plan-08] OpenCode Integration Event-Contract Correctness — make the OpenCode plugin actually capture

## Defect

claude-mem's OpenCode plugin was written against event names that do not exist in OpenCode's hook API (e.g. `session.created`, `message.updated`, `session.compacted`, `file.edited`, `session.deleted`). Because no real event ever fires, sessions are never initialized and no observations are captured — while `claude-mem install` still reports success. The result is a silent dead loop: OpenCode users believe memory is recording and it is recording nothing. A second defect compounds it: the OpenCode search client parses `data.items` while the worker returns Claude-style `data.content` blocks, so even manual search returns "No results", and it resolves the worker port from the wrong source.

The architectural fix is to bind the plugin to OpenCode's **real** event contract and to the worker's **actual** response shape, then add a contract test so a future OpenCode API change fails CI rather than silently disabling capture.

## Children

- #2435 — plugin subscribes to non-existent OpenCode event names → zero sessions/observations recorded
- #2406 — `claude_mem_search` always returns "No results" (`data.items` vs `data.content`); worker-port resolution uses the wrong source
- #2419 — feature framing of the same gap: OpenCode plugin lacks `tool.execute.after` observation capture
- #2462 — duplicate user report: OpenCode install reports success but captures no memory

## Fix sequence

1. **Rebind to real events:** rewrite the plugin against OpenCode's actual hooks (`tool.execute.after`, `chat.message`, `experimental.session.compacting`, …); add session init + observation POST on the correct events (#2435, #2419).
2. **Fix the search client:** parse the worker's `data.content` block shape; resolve the worker port from the authoritative settings source, with the env override honored (#2406).
3. **Contract test:** a test that asserts the plugin subscribes only to event names OpenCode actually emits, and that the search client parses the worker's real response shape. This is the regression guard.
4. **Install honesty:** OpenCode install must verify capture is live (one round-trip) before reporting success, so a future contract break surfaces at install time (ties to plan-04).

## Test matrix

| Surface | Input | Required behavior |
|---|---|---|
| Tool execution in OpenCode | a tool call | `tool.execute.after` fires → observation POSTed → row appears |
| Session lifecycle | open/compact/close | session init + compaction handled via real events |
| `claude_mem_search` | a query with known results | parses `data.content`; returns the rows (not "No results") |
| Worker-port resolution | non-default port via env/settings | client targets the correct port |

The matrix lives in CI. An OpenCode-capture regression must fail CI before a user can file.

## Out of scope

- Claude Code hook IO discipline → plan-01.
- Worker write-path / persistence correctness → plan-09.
- The worker's own search SQL source-scoping → plan-09.
