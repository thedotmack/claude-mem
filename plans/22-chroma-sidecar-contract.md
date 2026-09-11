# [plan-22] Chroma Sidecar Contract — host-safe spawn with pinned deps and a clean env, single-writer upsert sync, honest fallback (or retire the sidecar)

> **Tracker:** #3610 · **Design doc:** `plans/22-chroma-sidecar-contract.md` · **Series:** plan-14 #3602 · plan-15 #3603 · plan-16 #3604 · plan-17 #3605 · plan-18 #3606 · plan-19 #3607 · plan-20 #3608 · plan-21 #3609 · plan-22 #3610 · plan-23 #3611 · plan-24 #3618

## Defect

The vector store is a Python sidecar (`uvx … chroma-mcp`) driven over MCP stdio, and every layer between the worker and the index is untested against the environments users actually have. The result is a semantic search that is silently degraded (FTS5 fallback, confident-empty results, frozen watermarks) for weeks or months, and a store that grows without bound:

- **Spawn args are host-unsafe:** `chroma-mcp==0.2.6` as a bare positional (rejected by uvx < 0.5.31; `@`/`--from` needed), `--with onnxruntime>=1.20 --with protobuf<7` routed through `cmd.exe /c` where `>`/`<` are redirects, then double-quoted through the spawn layer so uvx sees literal quotes; the prewarm path re-implements the spawn without the transport's `.cmd` handling; the launching shell's `VIRTUAL_ENV`/`PYTHONPATH` leak into the child so `numpy` resolves from a foreign venv; the `onnxruntime>=1.20` constraint is not overridable (no wheels for macOS 12 / cp313 mismatch); `chromadb` is unpinned so an engine bump segfaulted a persisted store for 2.5 months with zero log signal; the preflight ignores `CLAUDE_MEM_CHROMA_UVX_PATH`; the connect timeout (30 s, later a 120 s prewarm) is shorter than a cold `uvx` materialization, and killing uvx mid-build leaves 100+ GB of `uv` temp dirs and reruns the cold build forever.
- **Sync has no write contract:** `ChromaSync` uses add-only `chroma_add_documents`, advances the watermark only on a clean full write, so a partial failure re-adds the same docs every cycle (74 GB for 27k rows, ~260× duplication); a corrupted HNSW segment is hot-retried forever with multi-GB spikes; two workers (two config dirs, two plugin versions, or a Codex install) write the same `--data-dir` with no arbitration → 157 GB `link_lists.bin` and kernel panics; the writer lock records the worker's PID, not the child's; docs are tagged with the daemon's cwd as `project`; CJK content breaks the backfill JSON framing.
- **Fallback lies:** `executeWithFallback` only falls back to SQLite when a `platformSource` filter is present, so a project-scoped query that misses in Chroma (~32 % of rows are not synced) returns confident-empty with `usedChroma: true`; a child that dies 0.6 s after connect (99.4 % of connects) or crashes with SIGSEGV is treated as slow; `doctor`/`status` stay green while the unindexed backlog grows to thousands.

The maintainer has signalled Chroma may be scrapped (#3138 comment). Either resolution retires this cluster: **(a)** the contract below, or **(b)** removal of the sidecar in favor of an in-process index, in which case this plan's test matrix becomes "no chroma-mcp process ever spawns and search parity holds". The plan is written for (a); step 0 is the decision.

## Children

- #2879 — Chroma semantic search never connects with uv < 0.5.31 — bare `uvx <pkg>==<ver>` rejected → MCP -32000
- #2897 — chroma-mcp 30s connect timeout kills uvx mid-install, causing infinite retry loop that leaked ~111GB of uv temp files
- #2939 — chroma-mcp== version pinning breaks uvx — use @ instead of ==
- #2954 — Windows: Chroma spawn routes `>`/`<` dependency specifiers through cmd.exe /c, breaking semantic search
- #2961 — tracking: chroma-mcp spawn fails with MCP -32000 — uvx version syntax errors and Windows cmd.exe redirection mangling
- #2979 — Semantic injection always returns empty: project-filter mismatch between Chroma sync and /api/context/semantic
- #3012 — Runaway ChromaDB growth to 157 GB; dual chroma-mcp writers on same data dir; auto-reinstalls after uninstall
- #3121 — [Windows] chroma-mcp spawn fails instantly — quote-wrapping of --with specs double-quotes through cmd.exe (auth half → plan-19)
- #3199 — onnxruntime>=1.20 pin makes semantic search unusable on macOS 12 / older Intel Macs (no override)
- #3202 — Corrupted HNSW segment turns ChromaSync into an unbounded retry loop — multi-GB memory spikes and frozen watermarks
- #3361 — Empty semantic result returns confident-empty instead of falling back to SQLite: fallback gated on platformSource, not on emptiness
- #3362 — chroma-mcp is pinned but chromadb floats: an engine bump segfaulted a persisted store for ~2.5 months with zero signal
- #3423 — ChromaDB backfill fails with "JSON Parse error: Unrecognized token" for CJK observations
- #3552 — [Windows] chroma-mcp inherits the spawning process's Python env, defeating uvx isolation — semantic sync silently stops
- #3577 — Chroma/uvx preflight check ignores CLAUDE_MEM_CHROMA_UVX_PATH override
- #3579 — chroma-mcp subprocess dies ~0.6s after connecting (99.4% of connects) — permanent silent indexing stall
- #3591 — ChromaSync watermark freezes on partial write while add-only writes land — same docs re-added every cycle (74 GB for ~27k rows)

Related PRs to evaluate/rebase: #2940, #2880 (`--from`), #2847 (Windows connect quoting), #3266 (update instead of delete+add, shipped), #3192 (memory watchdog — lifecycle side in plan-14), #3178.

## Fix sequence

0. **Decide: contract or retire.** If retire → replace steps 1–5 with the removal + parity matrix and close this master when no `chroma-mcp` spawn path remains.
1. **One spawn spec, no shell.** `ChromaSpawnSpec` builds an argv array executed directly (`uvx.exe`/`uvx` resolved once, honoring `CLAUDE_MEM_CHROMA_UVX_PATH`, no `cmd.exe`, no per-arg quoting), with `--from chroma-mcp==X --with chromadb==Y --with onnxruntime==Z --with protobuf==W` all exact-pinned and overridable via settings (`CLAUDE_MEM_CHROMA_WITH`), a sanitized env (strip `VIRTUAL_ENV`, `PYTHONPATH`, `PYTHONHOME`, venv PATH entries), `--data-dir` from the resolved data dir; the same spec serves connect, prewarm, and preflight. Cold materialization runs as a separate, progress-watched `uv tool install`/prewarm step with no wall-clock kill (a stalled-download watchdog instead), so the MCP connect timeout only ever measures a warm start.
2. **Child health is observed, not assumed.** Exit code/signal of the child is captured; SIGSEGV/immediate death raises `chroma_engine_crashed` at ERROR with the pinned versions, sets `/api/health.chroma=down`, and shows in `doctor` with a crash counter and the unindexed backlog; a child dying within N s of connect opens a circuit breaker with backoff instead of a 1–3 min respawn cadence.
3. **Single writer, upsert semantics.** A writer lock keyed on the *child's* PID + start token (plan-15 liveness rules), stamped with the writer version so an older worker refuses to write; `chroma_upsert_documents` (or existing-id check on every add path); watermark advances per document; every doc tagged with `resolveProjectIdentity()` output (plan-20) and the where-clause tested; JSON framing UTF-8 safe for CJK.
4. **Failure classification in ChromaSync.** Deterministic tool-level failures per collection (HNSW apply errors) count toward a breaker that stops retrying, snapshots the collection, resets watermarks, and rebuilds from SQLite once — with a cooldown if that fails; a size sanity check (chroma bytes vs SQLite rows, `link_lists.bin` ≪ `data_level0.bin`) alarms in `doctor`.
5. **Honest fallback.** `executeWithFallback` falls back on emptiness (and on unavailability) regardless of filters, and every result carries `strategy: chroma|sqlite` plus `chromaCoverage` so callers and the viewer can show "semantic search degraded since <date>".

## Test matrix

| Host | uv / Python | Scenario | Required behavior |
|---|---|---|---|
| macOS arm64, macOS 12 x86_64, Linux, Windows 10/11 (uvx.exe, uvx.cmd shim, WinGet uv) | uv 0.5.7 / 0.5.29 / 0.11.x / 0.12.x; py 3.12 / 3.13 | connect | child reaches `list` probe; argv logged; no cmd.exe |
| Windows | any | launching shell has `VIRTUAL_ENV` set | child imports numpy from uvx env |
| all | any | cold cache | prewarm completes once (watched, not killed); no `.tmp*` build dirs older than 10 min |
| all | any | chromadb crashes on start (fixture) | ERROR with versions; `doctor` red; breaker open; SQLite search still serves |
| all | any | partial batch failure | watermark advances for written docs; no duplicates on the next cycle (id-count assertion) |
| all | any | two workers, one data dir | second is read-only or refuses; no dual writers |
| all | any | project-scoped query with rows only in SQLite | results returned with `strategy=sqlite` |
| all | any | CJK observation | backfill succeeds |
| all | any | (retire path) | no `chroma-mcp` process; search parity suite passes |

The matrix lives in CI (`tests/services/sync/chroma-spawn-spec.test.ts` with a fake `uvx`, plus a real-uvx job on each OS). A regression must fail CI before a user can file.

## Out of scope

Reaping the chroma tree when the worker dies and bounding its memory (plan-14). Missing `sqlite/` modules in the bundle (plan-16). Project key derivation itself (plan-20).
