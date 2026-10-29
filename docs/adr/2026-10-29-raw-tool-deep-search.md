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
- No additional background process, polling loop, external marker, or outbox.
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
and long-lived readers that prevent checkpoints matter. Expensive raw reads run
on the existing read worker, keeping the main event loop free; they can still
delay other requests queued on that reader. A bounded result count does not bound
FTS ranking or CJK scan CPU. Project filters greatly help CJK misses but do not
make common-word FTS ranking cheap.

## Validation and remaining gate

- Baseline/candidate comparison uses the same stored-body fixture described above.
- 73 focused tests across six files pass, including a real HTTP route + read-worker
  + selected-body scope round trip and real MCP stdio. Another 251 existing
  search, CJK, MCP formatting, retention and route regressions across 23 files pass.
- Lifecycle coverage includes replay fill-in, no-op replay, body/metadata changes,
  trigger repair, writes on both sides of a build cursor, interrupted transactions,
  POSIX SIGKILL/reopen, retention, session deletion rollback, old/current backups,
  read-only main-file byte identity, and external-content FTS integrity.
- Typecheck, build, test-lane coverage and 24 committed-version checks pass.
  Affected runtime bundles are regenerated as required by the development guide.
- The full fast lane was run during implementation: 6,750 passed / 90 skipped /
  3 failed in its first process, and 3,688 passed / 7 skipped / 0 failed in its
  second. Two feature-related failures (logger-policy coverage and trigger-aware
  retention count) were corrected and the affected suites rerun as listed above.
  The remaining macOS launcher signing failure reproduces in an isolated copy of
  unmodified main. The first process also exited with a Bun C++ exception after
  reporting results; its cause was not established. The full lane is not claimed
  green, and the separate browser/grammar integration lane was not run.
- No installed plugin, production worker, or private memory database was modified.

Keep this PR draft pending representative real-corpus qualification, as requested
by plan-12. Synthetic scale tests cannot settle real payload distribution, ongoing
write contention, or the acceptable latency threshold. Maintainer review should
also confirm the local-only first slice and raw probing when summaries/prompts
match but observations do not. No native Windows or Linux host run was performed.
