# Chroma unconfirmed-drop containment (operator runbook)

This document describes the containment-only recovery journal implemented for
[#6113](https://github.com/thedotmack/claude-mem/issues/6113). The original
per-collection single-flight delete fix was delivered separately; this change
protects the remaining ambiguous-delete failure path.

## Safety contract

The SQLite/ODS store remains the authoritative source. A Chroma collection
deletion is destructive, and a transport timeout does **not** prove the delete
did not happen. Before deleting, the worker atomically records `DROP_PENDING`
in `<CLAUDE_MEM_DATA_DIR>/chroma-quarantine.json`. If the response is
unconfirmed, it persists `QUARANTINED` and suppresses further Chroma mutations
and rebuild sweeps for that collection.

The supported states are:

| Status | Meaning | Chroma dispatch |
|---|---|---|
| `READY` | No recovery restriction; index parity is **not** asserted | Permitted |
| `DROP_PENDING` | A destructive operation was initiated and has not been conclusively closed | Blocked |
| `QUARANTINED` | Deletion result unknown; manual verification required | Blocked |
| `UNKNOWN` | Journal, initialization marker, or transition lock cannot be trusted | Blocked |

`READY` is **not** an assertion that a rebuild finished. The existing
`chroma-sync-state.json` `rebuildPending` fields remain responsible for
resuming backfill after a **confirmed** delete.

## Files and crash behavior

- `chroma-quarantine.json`: versioned journal with per-collection entries.
- `chroma-quarantine.json.initialized`: durable initialization marker, written
  before the first journal. It is **never removed** as part of normal recovery.
  If the journal disappears after initialization, the worker reports `UNKNOWN`
  and blocks Chroma operations rather than silently returning to `READY`.
- `chroma-quarantine.json.lock`: exclusive transition lock created with
  filesystem `wx`. It is removed after a successful or failed in-process
  transition. A lock left by a crashed process blocks further operations until
  an operator verifies the outcome. It must **not** be deleted while a worker
  is active.

The writer lock already held by the Chroma MCP manager protects local Chroma
data-store ownership. The journal lock serializes metadata transitions, **not**
all vector mutations. Multiple independently active remote Chroma writers are
not a supported safety guarantee of this PR.

A first install with neither marker nor journal is `READY`. That legacy
bootstrap cannot detect a deliberate or accidental deletion of *both* files.
Treat the entire data directory as recovery-critical and back it up together.

## What an operator should do

1. Stop **all** Claude-Mem workers that could address the affected Chroma store.
   Confirm the worker and Chroma subprocesses are stopped; avoid concurrent
   supervisors/restarts and preserve crash logs.
2. Back up the complete Claude-Mem data directory **including** the authoritative
   SQLite database, sync checkpoint, recovery journal, marker, and any Chroma
   sidecar files.
3. Inspect the journal and logs for the affected collection, last deletion
   request, timestamp, and failure reason. A `DROP_PENDING` state after restart
   means the outcome is *unknown*, not that deletion was confirmed.
4. Using the supported Chroma administrative client, determine whether the
   **same collection generation** still exists, whether its index is corrupt,
   and whether a deletion already completed. Do **not** blindly repeat
   `chroma_delete_collection` merely because a transport returned an error.
5. Confirm that every authoritative project requiring rebuild has durable
   `rebuildPending` state in `chroma-sync-state.json`. Restore or reconstruct
   this intent from the SQLite source before allowing vector writes.
6. Only after the collection outcome and rebuild intent are independently
   verified, repair the journal with the workers stopped. Preserve the
   `.initialized` marker, use the repository's atomic JSON write helper, and
   modify only the verified collection entry. Do not simply delete the entire
   journal or the lock to force the service into `READY`.
7. Restart one authorized worker; monitor backfill progress, row counts,
   failed-row retry records, and both search endpoints. A confirmed delete
   must be followed by reconciliation from the authoritative SQLite records.

There is intentionally **no automatic quarantine-clear API** in this PR.
Verification and controlled repair are operator operations; safe automated
probes, collection-generation fencing, and explicit reconciliation/health
transitions belong in the follow-up recovery work.

## Search availability

Known quarantine or unknown recovery state prevents Chroma semantic queries
in both search stacks. `SearchManager` reports
`search_strategy: 'fts'`, `fallback_reason: 'chroma_quarantined'`, and
`chroma_available: false`; `SearchOrchestrator` reports
`strategy: 'sqlite'` and `usedChroma: false`. These are existing distinct
metadata contracts, not a new universal public `source` field.

SQLite fallback is designed to keep stored text searchable; semantic ranking
and completeness are not equivalent while the index is quarantined.

## Required proof before release

- Durable pending/quarantine state, missing/corrupt journal, orphaned lock,
  and concurrent independent workers in tests.
- Zero fresh mutation dispatch after local quarantine becomes visible.
- Rebuild skipped on unconfirmed deletion; confirmed deletion retains durable
  backfill intent.
- Search fallback before a query, on transport error, and on a successful
  semantic reply that becomes stale during quarantine.
- Windows/Linux validation, complete relevant test suites, and live Chroma
  failure-injection with disposable data.

**Do not use this runbook as a license to delete production collections
without a verified backup and collection-generation identity.**
