# Opt-in local raw tool evidence search (#4060)

## Scope

Implements the local SQLite slice of [plan-12](../../plans/12-provider-and-extensibility-roadmap.md),
tracked by [#2785](https://github.com/thedotmack/claude-mem/issues/2785#issuecomment-5647109577).
Based on main `8e91e3abb0f4536d374095193c18d72fa9d92b05` (15.4.0).
This is a feature, not a claim that the complete provider/server roadmap is done.

The motivating fixture stores an observation saying “fixed the connection pool”
and raw Bash output containing `DB_CONN_1042: increase pool size from 10 to 30`.
On the baseline, ordinary search and a request carrying `deep:true` return no
matches, although selected-ID raw retrieval proves the body exists. With this
change and the index enabled, ordinary search still returns zero while deep
search returns one typed raw hit and its bounded excerpt.

## Decisions

- Default-off persistent setting plus explicit `deep:true` on local memory search.
  Neither code `smart_search` nor server raw search is changed.
- Only successful, empty observation searches on their first page qualify.
  Summaries/prompts can still match; they are retained. Errors do not activate
  raw search. Observation-only and unsupported session/tool filters do not run it.
- Shared strict FTS query quoting and CJK/mixed substring helpers. No any-term
  widening or non-CJK substring scans. All mapped scope filters precede LIMIT.
- Independent tool-use IDs, snippets, count and hasMore; selected bodies use the
  same project read keys. No cross-tier pagination and no raw Chroma embeddings.
- External-content FTS with actual OLD/NEW body comparison. Metadata changes and
  identical replay do not churn the index. FTS triggers fail atomically with raw
  writes; this does not promise guaranteed raw capture after an index failure.
- Derived schema/version/state are in SQLite, independent of the core writer
  version. Existing writer guards remain in force. Newer index versions are not
  overwritten. Read-only opens never mutate the main database.
- A synchronous prototype took 17.2 seconds to build the large synthetic corpus.
  The implemented writer builds 64-row transactions after core search is ready,
  yielding between batches. Its committed cursor gates insert/update/delete
  triggers until ready. New rows above the cursor await their batch; indexed
  rows update immediately. Missing triggers invalidate the derived index and
  restart this build, rather than attaching normal delete triggers to stale data.
- No background indexing process, polling loop, external marker, or outbox.
  Raw queries now use a separate disposable process with an independent guard;
  they never occupy the ordinary context reader.
  The historical observation-FTS bloat cleanup is a one-time repair for an older
  write-amplification bug, not a generic scheduler for new indexes. This index
  uses SQLite's normal merges; tests also exercise an explicit merge and FTS
  external-content integrity check after retention.
- Bun's `run().changes` counts FTS trigger writes. Retention/session deletion now
  use SQL `changes()` to report base rows, so deleting one tool use still reports
  one rather than its shadow-table operations.

## Reproducible synthetic capacity probe

Run `bun scripts/bench-tool-use-search.ts 2500` or `139304`. The script creates and
removes its own temporary database and never opens a user's memory database.
It uses production connection pragmas, default autocheckpointing, varied numeric
identifiers in JSON/code-like output, a small/medium/large payload mix, and the
existing 64 KiB per-field storage cap. Every tenth row contains CJK text.

Recorded on macOS arm64, Bun 1.3.13. Each query measurement has seven samples;
these are local capacity observations, not a latency SLA. The final large run
was separate from the full test suite. Build timer gaps include SQLite work and
scheduling; they are not a direct instrument of write-lock duration. WAL size is
sampled between batches, not an OS-wide peak temporary-space measurement.

| Measurement | 139,304 rows |
| --- | ---: |
| Stored input + response bytes | 1,537,803,591 |
| Database before / after indexing | 1,642,291,200 / 2,259,480,576 bytes |
| Additional database bytes | 617,189,376 |
| First build | 31.6 s |
| Largest observed timer gap during build | 84.1 ms |
| Sampled peak WAL / WAL at completion | 18,268,112 / 4,194,304 bytes |
| Rare error-marker FTS, median / max | 0.43 / 1.83 ms |
| Common-term FTS with project, median / max | 3,859 / 5,618 ms |
| Mixed CJK hit with project, median / max | 204 / 1,759 ms |
| CJK miss across all projects, median / max | 971 / 6,008 ms |
| CJK miss with project, median / max | 29.4 / 35.6 ms |
| 100 inserts / identical replays | 131.5 / 12.7 ms |
| 100 changed responses / deletes | 63.1 / 1.7 ms |
| VACUUM INTO before / after index | 4.57 / 7.03 s |
| Backup before / after index | 1,636,118,528 / 2,251,476,992 bytes |

The 2,500-row probe stores 27,087,240 body bytes, adds 12,124,160 database
bytes, and builds in 233 ms (largest observed timer gap 13.4 ms). Its median
rare/common FTS times are 0.20/14.4 ms; global/scoped CJK misses are 15.6/0.44 ms.

`dbstat` attributes 610,877,440 bytes to `_data`, 1,667,072 to `_docsize`,
1,687,552 to `_idx`, and 4,096 to `_config`; the virtual table has no separate
body copy. Total database growth also includes page/metadata overhead.

An earlier run with autocheckpointing deliberately disabled accumulated about
3.86 GB of WAL. That is not the default configuration, but shows why disk headroom
and long-lived readers that prevent checkpoints matter. These measurements
precede the subprocess revision: the initial implementation ran expensive raw
reads on the existing reader and could delay normal context reads. The current
implementation isolates raw reads in a disposable child and reports timeout
after a 4-second budget including preparation/startup, set from the real-corpus
measurement below. A bounded
result count does not bound FTS ranking or CJK scan CPU. Project filters greatly help CJK misses but do not
make common-word FTS ranking cheap.

## Initial validation (historical) and remaining gate

- Baseline/candidate comparison uses the same stored-body fixture described above.
- 73 focused tests across six files pass, including a real HTTP route + read-worker
  + selected-body scope round trip and real MCP stdio. Another 251 existing
  search, CJK, MCP formatting, retention and route regressions across 23 files pass.
- Lifecycle coverage includes replay fill-in, no-op replay, body/metadata changes,
  trigger repair, writes on both sides of a build cursor, interrupted transactions,
  POSIX SIGKILL/reopen, retention, session deletion rollback, old/current backups,
  read-only main-file byte identity, and external-content FTS integrity.
- Typecheck, build, test-lane coverage and 24 committed-version checks pass.
  Those initial commits included generated bundles. The maintainer subsequently
  requested source-only PR changes; generated files now match upstream main,
  while validation rebuilds the final source graph in an isolated copy.
- The full fast lane was run during implementation: 6,750 passed / 90 skipped /
  3 failed in its first process, and 3,688 passed / 7 skipped / 0 failed in its
  second. Two feature-related failures (logger-policy coverage and trigger-aware
  retention count) were corrected and the affected suites rerun as listed above.
  The remaining macOS launcher signing failure reproduces in an isolated copy of
  unmodified main. The first process also exited with a Bun C++ exception after
  reporting results; its cause was not established. The full lane is not claimed
  green, and the separate browser/grammar integration lane was not run.
- No installed plugin, production worker, or private memory database was modified.

## Real-corpus qualification (2026-11-09)

Measured by the maintainers on a real local memory database (macOS arm64,
Bun 1.4.4, on a heavily loaded machine: load average 40–130). The database was
opened read-only and never copied or written; the FTS5 index was built in the
connection's temp schema as the same external-content table over a temp view of
`tool_uses`, in the same 64-row batches, and queried through `searchToolUses`.
Child startup was measured through `DeepSearchClient` against the same file.
21 runs per query, `limit: 5`.

| Measurement | Value |
| --- | ---: |
| Tool-use rows | 276,904 |
| Stored input + response bytes | 2,002,797,679 (226 MB + 1.78 GB) |
| `tool_uses` table pages | 2,256,691,200 bytes |
| FTS5 shadow tables | 863,408,128 bytes (38% of the table) |
| Backfill, 4,336 batches | 263 s (temp file, no WAL fsync) |
| Child startup + open + reply, median / p95 | 61 / 85 ms |
| Common term, all projects, median / p95 / first (cold) | 993 / 3,391 / 14,945 ms |
| Common term, largest project (33,699 rows), median / p95 | 285 / 379 ms |
| Two common terms, all projects, median / p95 | 579 / 681 ms |
| Rare-term miss, all projects | 0–12 ms |
| CJK hit, all projects, median / p95 | 1,732 / 3,508 ms |
| CJK miss, all projects, median / p95 | 5,368 / 12,791 ms |
| CJK miss, largest project, median / p95 | 284 / 449 ms |

At the earlier 1-second budget, 10 of 21 all-project common-term queries timed
out. The deadline is now 4 s: it covers the all-project common-term and CJK-hit
p95 plus child startup (3.6 s worst). An all-project CJK miss (a full substring
scan) and a first query on a cold page cache still expire, visibly as
`timeout`. The index adds about 0.4x the `tool_uses` table to the database file.

The local-only first slice keeps the existing worker observation contract.
Server raw search and full cross-runtime parity are out of scope; the
pre-existing server punctuation and 64-term differences are tracked under
plan-25 (#3982). No native Windows or Linux host run was performed.


## Maintainer follow-up (2026-11-09)

- Current verification on the merged source: **174 tests passed across 20 files**,
  including production child faults, HTTP/MCP release entrypoints, both artifact
  formats, environment isolation, CJK/server comparisons and upstream zero-epoch
  and work-view packaging regressions. Root TypeScript, bundle build, spawn-env,
  hook-IO and test-lane checks passed. The full suite and Linux/Windows host tests
  were not rerun locally; platform workflows remain required.
- Integrated main `989a98a2` (v15.13.0). Preserved the upstream Windows CJS
  compilation/media-sidecar path, work-view reader entry and lifecycle cleanup.
  Native builds use the shared Bun options; both compiler paths reject runtimes
  lacking the standalone child capability before building.
- Ordinary reads remain on the context reader. Deep queries have single-flight
  admission, explicit incomplete statuses, a disposable read-only child and
  confirmed-exit cleanup. Preparation is shared without accumulating request
  callbacks. Synthetic tests prove termination/recovery and overlap with an
  exclusively attributable deep-database reader, not real-corpus p95.
- The deadline was a provisional 1 second until the real-corpus measurement
  above set it to 4 seconds. The evidence is also beside the constant.
- Real-corpus preflight: with the owner's permission, SQLite's backup API read
  the local database through a read-only connection into a temporary snapshot.
  The snapshot contained **0 tool-use rows and 0 observations**. It is ineligible
  for qualification; no index-size/backfill acceptance numbers are claimed.
  Neither the original database nor the daily Worker was modified. No database,
  stored body, project name or query text is published.

### plan-25 contract matrix and remaining scope question

`tests/sqlite/raw-tool-cjk-contract.test.ts` uses the same text/query pairs against
worker observations, worker raw bodies and the server SQLite memory repository.
It covers Han, supplementary Han, Japanese, halfwidth Katakana, Katakana
extensions, Korean, Thai, mixed Latin/CJK, case folding, missing AND terms and
literal underscores, including project isolation. Upstream extended-Katakana
ranges are preserved in the extracted shared worker helper.

Two existing cross-runtime differences are explicit tests, not hidden failures:
server memory search tokenizes `+` and `%`, whereas worker observation/raw
substring matching preserves them literally. For `项目+配置` in `项目 配置` and
`数据%池` in `数据库连接池`, both worker tiers miss while server memory matches.
The server also has a distinct 64-term query budget; raw substring queries reject
more than 500 terms. No claim of complete cross-runtime equivalence is made.

Server **raw** search remains outside this local-first slice: `deep:true` is
explicitly rejected. The matrix covers the SQLite server memory route, not
Postgres or a new server raw endpoint. Maintainer confirmation is still needed
on whether these existing plan-25 differences/server raw support must be resolved
in this PR or tracked separately. Keep the PR draft pending that decision and a
representative, nonempty real corpus.
