# Sync Hub poll-mode projection — ship plan

**BOARD DECISION LOCKED — ship Path A only.**
**Seat:** Sync Hub (receiving-end Worker / KV / DO). This file is the make-plan + ship path.
**Constraint:** kill-switch stays ON until the green path is live. Product stays LIVE. No Pro / Vercel / client brakes. Do not clear the kill-switch (Path C).
**PR:** https://github.com/thedotmack/claude-mem/pull/4209
**Customers:** ALE-457 / #4191, ALE-461 / #4198.

---

## 1. What actually broke

**Commit:** `b3f0d7cf` — `fix(sync-hub): stop projection-drain DO slam and inert watchdog` ([#4140](https://github.com/thedotmack/claude-mem/pull/4140)).

**Config:** `AUTH_CACHE` key `control:kill-switch` present (poll mode). Watchdog / manual trip. WS refused; HTTP stamped `X-Sync-Mode: poll`.

**Behavior:** `#4140` wired `skipProjectionDrain: killSwitch.tripped` on `POST /v1/sync/ops`. The Worker still called `pushOps` (head advanced) and still returned **HTTP 200**, but `projected_seq` was the stale Hub checkpoint (often `"0"`).

That violates two contracts at once:

- `DEPLOY.md`: a public push is 200 only after Hub `projected_seq` covers `head_seq`.
- Client `CloudSync.validatePushResponse`: `head_seq <= projected_seq` on every 200. A lagged 200 is a protocol violation — acks are **not** stamped; the outbox retries forever.

Manual `POST /internal/v1/projection/drain` repaired one account. The next push under kill-switch skipped drain again, so lag re-grew.

**Hypothesis (proven in comments + tests, not assumed):** the 1% Workers Logs sample cut (`wrangler.jsonc` `head_sampling_rate: 0.01`) is **not** the customer pain. Logging never advanced `projected_seq`. `skipProjectionDrain` did — it left `head_seq` ahead of `projected_seq`, which clients reject.

## 2. What people liked that stopped

Pre-#4140, every successful public push ran `drainProjection` until the Hub checkpoint covered that push’s `head_seq`. That is the catch-up paying users felt: flush succeeded, Pro stayed near the log, `lastFlushAt` moved.

What they did **not** need — and what #4140 correctly cut — were automated DO storage knocks on top of that work:

- extra `getProjectionState` after acquire (acquire already returns `projected_seq`)
- `heartbeatProjectionLease` on every page (`getProjectionPage` already renews the 90s lease; Hub abort is 45s)
- 100% log ingest
- long-lived WS pinning idle DOs

Those knocks stay gone. The drain itself is real sync and must stay.

## 3. Green path options (ranked, cost risk)

Keep kill-switch ON for all three until spend is actually green. None of them turn sync off. Idle DO loops stay quiet (no fleet-wide “knock every user” cron).

### A — Selective drain under kill-switch (ship this)

**What:** On an active poll-mode push, drain with a page budget (8 pages / ≤800 ops). If `projected >= head` → 200. If not → 503 `projection_catching_up` (`durable` + `retryable`) + `waitUntil` catch-up (32 pages). Repair route remains. Extra heartbeat / state knocks stay deleted. WS still refused.

**Cost risk:** Low–medium. DO RPCs and Pro fetches happen only for users who are writing. Idle accounts are not woken. Bound prevents a 66k-seq backlog from holding one request for `N × 45s`. vs pre-#4140: ~half the per-page storage knocks, 1% logs, no WS pin.

**Correctness:** Restores the 200-contract on the write path. Deep lag still progresses (503 + retry / waitUntil / repair).

### B — Keep skip on push + Hub-side background drain queue

**What:** Leave `skipProjectionDrain` on the request. Enqueue `user_id` in KV on each push. A Worker cron drains the queue (lease-safe, bounded pages).

**Cost risk:** Medium–high. A 200 with lagged `projected_seq` still breaks current clients, so the push would have to become 503 until the queue catches up — same user-visible delay as A, plus a new durable queue, lease races with repair, and a cron that can knock DOs after the user has gone idle if the queue is stale. More machinery for the same catch-up A already does on the write path.

**When:** Only if A’s request-path bound is proven too expensive *and* we still need catch-up with kill-switch ON.

### C — Clear kill-switch after a lean drain cost model

**What:** `wrangler kv key delete --binding AUTH_CACHE "control:kill-switch" --remote`. Restores WS + unbounded request-path drain.

**Cost risk:** High until A (and, if needed, B) prove the lean model. This is how the original slam returned (WS pin + unbounded drain + historically 100% logs). **Do not do this as the P0 fix.**

**When:** Only after A/B are insufficient *and* watchdog metrics (duration / rows / requests) stay under kill thresholds with the lean RPC budget.

## 4. Ship path (locked)

**Path A only.** Keep kill-switch ON. Fallback B only if A regresses cost. Do **not** clear kill-switch (Path C).

1. Merge this PR and deploy the **sync-hub Worker only** (`workers/sync-hub`).
2. Leave `control:kill-switch` in place. Poll mode remains the cost guardrail.
3. Existing lagged accounts (`projected_seq = 0`, head 40–200) catch up on the next client push (≤8 pages on the request, then waitUntil / retry) or via `/internal/v1/projection/drain`.
4. Watch Cloudflare DO duration / rows-read / rows-written for a few watchdog cycles. C stays locked. B is a follow-up on this seat only if A regresses cost while users can flush.

### Alex hand

**Deploy needs a human wrangler Allow on the Mac.** This seat cannot `wrangler deploy` the production Worker from CI/cloud. After merge:

```sh
cd workers/sync-hub
wrangler deploy
# do NOT: wrangler kv key delete --binding AUTH_CACHE "control:kill-switch" --remote
```

No client release, no Pro/Vercel change, no kill-switch clear. Optional: one repair drain for a known-stuck `user_id` if you want them caught up before their next push.

B is the fallback design if post-deploy spend is still above kill thresholds *while* users can flush. That would be a follow-up PR on this seat, still receiving-end only.
