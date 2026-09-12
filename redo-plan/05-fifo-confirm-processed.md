# 05 — FIFO confirm-processed + queue observability

Branch commit: `897f8da5 fix: FIFO confirm-processed and add queue observability`
Files touched on the branch: `src/services/worker/agents/ResponseProcessor.ts`, `src/services/worker/SDKAgent.ts`, `src/services/worker/SessionManager.ts`, `src/utils/logger.ts`, plus `plugin/` build artifacts.

> **TL;DR — drop this commit. Its premise no longer exists on main, and the underlying concern (silent data loss on the AI-success path) is better fixed by re-applying the conservative `clearProcessingForSession` patch (drafted as `a0899529` on `origin/pre-queue-engine-rewrite`, reverted within 33 seconds, and now sitting unshipped). Salvage only the `CLAUDE_MEM_LOG_TO_STDOUT` opt-in mirror in `src/utils/logger.ts`.**

---

## 1. What the feature is

Two unrelated changes shipped under one commit:

**a. The FIFO confirm fix.** Before `897f8da5`, `ResponseProcessor.processAgentResponse` consumed *the entire* `session.processingMessageIds` array on every response — calling `pendingStore.confirmProcessed(messageId)` for each id, then unconditionally clearing both arrays. After the fix, it shifts a single id off the head of the array, gated on `storedSomething = result.observationIds.length > 0 || result.summaryId !== null`. If nothing was stored, no confirm happens and the tracker is left alone.

The bug premise (from the commit message): the SDK pre-fetches the next user message before delivering the response to the current one, so `processingMessageIds` can already contain a future message's id while an earlier init/continuation response is arriving. Pre-consuming the whole tracker on an empty response deleted the wrong pending row. The TITANS conversation observer (`4eb23b7b`) made the failure mode worse because the conversation path now shares the same tracker — interleaved init / conversation / tool messages can mislabel each other.

**b. Queue observability.** Three new logger.info breadcrumbs:
- `QUEUE TRACKED_FOR_CONFIRM` — when `SDKAgent` pushes onto `processingMessageIds`.
- `QUEUE CONFIRM_PASS` — when `ResponseProcessor` shifts and confirms one id.
- `QUEUE CONFIRM_SKIP` — when it skips (nothing stored or tracker empty), with `reason=`.

Plus an opt-in `CLAUDE_MEM_LOG_TO_STDOUT=1` mirror in `src/utils/logger.ts:299` that pipes every log line to stdout so `tee -a worker.log` captures it inside Docker.

## 2. What we want it to do (functional behavior)

- Strict 1:1 between SDK request → SDK response → exactly one row removed from `pending_messages`.
- An "empty" response (no observations, no summary) confirms nothing — the tracked id stays put for the next response.
- Tracker drains in arrival order (FIFO); never pre-consumes pre-fetched ids.
- Every queue mutation is observable via a single grep `grep "QUEUE"` over `worker.log`.
- `CLAUDE_MEM_LOG_TO_STDOUT=1` makes the log stream visible to `docker logs` / `tee` without changing on-disk file format.

## 3. What we want it to accomplish (user value)

- No silent message loss when the SDK's read-ahead interleaves with response delivery.
- No mislabeled observations (the source-metadata work in commit `c2a39635` depends on per-message identity surviving the response cycle).
- A debuggable queue: when a user reports "my observations didn't get stored," the operator can trace `RECEIVED → CLAIMED → TRACKED_FOR_CONFIRM → CONFIRM_PASS|CONFIRM_SKIP` for that message id.

## 4. Why we think it will work

The FIFO invariant only holds if every response causally maps to exactly one prior message. That assumption is true for SDK responses *that produce stored output* (every observation/summary batch is downstream of one user/tool turn). Gating on `storedSomething` is the load-bearing piece — it lets init/continuation/empty turns pass through without poisoning the tracker. The shift-on-success approach is correct in isolation.

## 5. The simplest possible implementation if we ignore edge cases and the existing codebase

Don't track at all. After the response stores cleanly, run:

```sql
DELETE FROM pending_messages
 WHERE session_db_id = ? AND status = 'processing'
```

That's it. No `processingMessageIds` array, no `processingMessageMeta` array, no FIFO logic, no shift, no gate. The DB already knows which rows you claimed (status='processing'); just delete those. Anything that arrived as 'pending' during the AI's response latency stays put for the next round.

## 6. Is that simple way better or worse than what we designed?

**Simpler is better here.** Concrete comparison:

| Aspect | Branch's FIFO tracker | `clearProcessingForSession` |
| --- | --- | --- |
| Shared mutable state | 2 arrays on `ActiveSession` synchronized between `SDKAgent` and `ResponseProcessor` | None |
| Correctness under SDK pre-fetch | Correct (gated shift) | Correct (status filter ignores pending pre-fetches) |
| Correctness under hook bursts (B,C arrive while A in flight) | Correct | Correct |
| Crash recovery | Relies on `claimNextMessage` self-healing of stale 'processing' rows | Same (DB is source of truth, no in-memory state to lose) |
| LOC added | ~30 in source + ~10 in tests | ~10 in source + ~5 in tests |
| Failure mode if invariant breaks | Tracker desyncs silently; symptoms appear turns later | DB query is wrong → loud SQL error or zero rows deleted |

The tracker only earns its keep if you need *per-id* semantics — e.g. partial-batch confirms or message-level retry. Neither is a current requirement. With status-scoped delete, the DB row's `status` column *is* the tracker, and there's nothing to keep in sync.

The PATHFINDER and Codex CEO reviews on May 1 already concluded the queue should not be rewritten, only simplified by deletion. Re-introducing the `processingMessageIds` array on top of main would be a structural *addition* to the queue — directly counter to that conclusion.

## 7. Suggestions for how to continue

See `06-execution-plan.md` Phase 5 for the current approach. Only the `CLAUDE_MEM_LOG_TO_STDOUT` mirror is salvaged; the FIFO tracker is dropped and per-message tracking is not re-introduced.

## 8. Overlap / conflict notes vs `origin/main`

| File on branch | Status on main | Conflict severity |
| --- | --- | --- |
| `src/services/worker/agents/ResponseProcessor.ts` | Restructured around `clearPendingForSession` (line 111). No `processingMessageIds` references. | High (whole hunk obsolete). Rewrite from scratch. |
| `src/services/worker/SDKAgent.ts` | Renamed to `src/services/worker/ClaudeProvider.ts` by PR #2255 ("provider rename"). | High. Skip — log line is for an obsolete tracker. |
| `src/services/worker/SessionManager.ts` | `clearPendingForSession(sessionDbId)` exists (line 259); no `processingMessageIds` field. | Low — branch's diff is comment-only. Skip. |
| `src/services/sqlite/PendingMessageStore.ts` | Has `claim`, `clearPendingForSession`, `resetProcessingToPending`, `peekPendingTypes`. No `confirmProcessed`. | Add new `clearProcessingForSession` method (status-scoped DELETE). |
| `src/utils/logger.ts` | No `CLAUDE_MEM_LOG_TO_STDOUT` env var. | Low — clean append after line 299. |
| `plugin/scripts/*.cjs` | All regenerated by build. | Ignore — never hand-merge. |

---

**Bottom line:** The branch's FIFO commit is a well-aimed fix for a problem that no longer exists in the same shape on main. Main has its own version of the same class of bug (success-path data loss), and the right fix for it is `clearProcessingForSession` — already drafted, already reverted, ready to be re-applied as a single small commit. Total redo cost: ~1 hour including the regression test.
