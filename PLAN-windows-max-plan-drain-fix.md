# Plan: Fix Windows Max-Plan Drain (v12.3.3+ regression)

Context: `INVESTIGATION-windows-max-plan-drain.md` in repo root. Branch:
`investigate/windows-infinite-loop-usage-drain`. Test runner: `bun test`.

## Phase 0 — Documentation Discovery (COMPLETED)

Findings consolidated from three discovery subagents:

### Codebase APIs available (verified)

- **`SessionRoutes` already has** `this.sessionManager`, `this.eventBroadcaster`,
  `this.workerService` (`src/services/worker/http/routes/SessionRoutes.ts:34-49`).
- **`WorkerService.terminateSession` is `private`** (`worker-service.ts:964`) —
  cannot call from SessionRoutes. Must replicate the three-step pattern
  inline. Reference implementation: `worker-service.ts:964-976`.
- **Abandonment pattern already used in SessionRoutes** at
  `SessionRoutes.ts:123-125` — `pendingStore.markAllSessionMessagesAbandoned()`
  + `sessionManager.removeSessionImmediate()`. Copy this pattern.
- **`SessionManager.removeSessionImmediate`** is public
  (`SessionManager.ts:453-468`) and fires `onSessionDeletedCallback` →
  `broadcastProcessingStatus()` automatically.
- **`SessionEventBroadcaster.broadcastSessionCompleted`** exists
  (`events/SessionEventBroadcaster.ts:73-82`) — `worker-service.ts:951`
  does call it after `terminateSession`, so mirror that for parity.

### `RestartGuard` facts

- Full impl is only 70 lines (`src/services/worker/RestartGuard.ts`).
- **No existing tests** for RestartGuard.
- Public surface: `recordRestart(): boolean`, `recordSuccess(): void`,
  getters `restartsInWindow`, `windowMs`, `maxRestarts`.
- Call sites (must remain compatible):
  - `SessionRoutes.ts:314-315, 322-324, 336-337`
  - `worker-service.ts:824-825, 832-834, 854`
  - `ResponseProcessor.ts:211` — `recordSuccess()` called only after a batch is
    confirmed to storage.
- Field: `ActiveSession.restartGuard?: RestartGuard` (`worker-types.ts:39`).

### `unrecoverablePatterns` facts

- Location: `worker-service.ts:713-727`. Match is
  `unrecoverablePatterns.some(p => errorMessage.includes(p))`
  — simple substring on `(error as Error)?.message`.
- **DO NOT add bare `'401'`** — matches request IDs, log lines, etc. Use
  agent-prefixed forms instead.
- Gap found: **OpenRouter 401 is not currently caught**
  (`OpenRouterAgent.ts:458`). Mirror the Gemini pattern for consistency.
- Existing test file that covers transient/terminal classification:
  `tests/worker/agents/fallback-error-handler.test.ts` (line 75-77 asserts
  `'401 Unauthorized'` is terminal). No direct tests exist for
  `unrecoverablePatterns` — add them.

### Anti-patterns to avoid

- ❌ Making `terminateSession` public and calling it from SessionRoutes — couples
  the HTTP layer to WorkerService internals further; the three-step pattern is
  already public API surface.
- ❌ Adding bare `'401'` to `unrecoverablePatterns` — too broad.
- ❌ Refactoring RestartGuard public API — call sites depend on getters.
- ❌ Creating new test framework config — project already uses `bun test`.

---

## Phase 1 — Fix SessionRoutes restart-guard trip (stops the drip)

**Goal:** When the windowed restart guard trips in the HTTP-layer crash-recovery
path, abandon pending messages instead of leaving them in `'pending'` state, so
the next worker startup's `processPendingQueues()` does not replay them.

**Target file:** `src/services/worker/http/routes/SessionRoutes.ts`

**Doc reference (pattern to copy, verbatim except for the reason string):**

1. `SessionRoutes.ts:123-125` — existing abandonment pattern in the same class.
2. `worker-service.ts:964-976` — the private `terminateSession` body to
   replicate (logger message + reason + broadcastSessionCompleted call).
3. `worker-service.ts:951` — confirms `broadcastSessionCompleted` is called
   after abandonment in the sibling code path.

### Task 1.1 — Replace `abort()`-only trip with full abandonment

At `SessionRoutes.ts:326-329`, replace:

```ts
// Don't restart - abort to prevent further API calls
session.abortController.abort();
return;
```

With (copy-adapt from the pattern at SessionRoutes.ts:123-125 + the
log shape from worker-service.ts:968-972):

```ts
// Restart guard tripped — abandon pending messages so the next worker
// startup's processPendingQueues() does NOT replay them, and kill the
// subprocess. Mirrors WorkerService.terminateSession() semantics.
// (Cannot call terminateSession directly — it's private in WorkerService.)
session.abortController.abort();
const pendingStore = this.sessionManager.getPendingMessageStore();
const abandoned = pendingStore.markAllSessionMessagesAbandoned(sessionDbId);
logger.info('SYSTEM', 'Session terminated', {
  sessionId: sessionDbId,
  reason: 'max_restarts_exceeded',
  abandonedMessages: abandoned
});
this.sessionManager.removeSessionImmediate(sessionDbId);
this.eventBroadcaster.broadcastSessionCompleted(sessionDbId);
return;
```

Also update the log at `SessionRoutes.ts:319-326`: change the `action:` string
from `'Messages remain in pending state.'` to
`'Pending messages abandoned to prevent replay loop.'`.

### Verification

- `grep -n 'Messages remain in pending state' src/` → no matches.
- `grep -n 'markAllSessionMessagesAbandoned' src/services/worker/http/routes/SessionRoutes.ts`
  → should now find TWO call sites (existing L124 + new one in restart-trip).
- Manual trace: after trip, `pending_messages.status` for that session is
  `'failed'` (or whatever `markAllSessionMessagesAbandoned` sets it to —
  confirm by reading `PendingMessageStore.ts:293`).

### Anti-pattern guard

- Don't make `terminateSession` public. Replicate inline — the three calls are
  already public API.
- Don't skip `abortController.abort()` before abandonment — the SDK subprocess
  must be killed or it will keep consuming Claude.

---

## Phase 2 — Tighten RestartGuard (stops the loop from getting far enough to drip)

**Goal:** Require N=5 consecutive `recordSuccess()` calls before clearing the
restart history, and add an absolute lifetime cap of 50 restarts that, once
tripped, never resets.

**Target file:** `src/services/worker/RestartGuard.ts`

**Doc reference:**

- Current impl quoted in full in Phase 0. Consumers at:
  - `SessionRoutes.ts:314-315, 322-324, 336-337`
  - `worker-service.ts:824-825, 832-834, 854`
  - `ResponseProcessor.ts:211`
- Public surface must remain compatible: `recordRestart(): boolean`,
  `recordSuccess(): void`, getters `restartsInWindow`, `windowMs`,
  `maxRestarts`.

### Task 2.1 — Add constants and private fields

Add to top of file:

```ts
const REQUIRED_CONSECUTIVE_SUCCESSES_FOR_DECAY = 5;
const ABSOLUTE_LIFETIME_RESTART_CAP = 50;
```

Add to class:

```ts
private consecutiveSuccessCount = 0;
private totalRestartsAllTime = 0;
```

### Task 2.2 — Rewrite `recordRestart()` semantics

Behavior:

1. Increment `totalRestartsAllTime`.
2. If `totalRestartsAllTime > ABSOLUTE_LIFETIME_RESTART_CAP`, return `false`
   immediately (never resets — terminal).
3. Any restart resets `consecutiveSuccessCount` to 0 (a failure interrupts the
   success streak).
4. Existing decay check: only fire if
   `lastSuccessfulProcessing !== null` **AND** we had
   `consecutiveSuccessCount >= REQUIRED_CONSECUTIVE_SUCCESSES_FOR_DECAY` the
   last time `recordSuccess` was called **AND** 5 min elapsed. To make the
   logic clean: only gate decay on an existing flag `decayEligible` that is
   set to `true` by `recordSuccess` once the streak threshold is reached.
5. Otherwise preserve current window-based logic.

Simplest structure:

```ts
recordRestart(): boolean {
  this.totalRestartsAllTime += 1;
  this.consecutiveSuccessCount = 0;  // streak broken
  if (this.totalRestartsAllTime > ABSOLUTE_LIFETIME_RESTART_CAP) {
    return false;  // terminal — lifetime cap reached
  }

  const now = Date.now();
  if (this.decayEligible
      && this.lastSuccessfulProcessing !== null
      && now - this.lastSuccessfulProcessing >= DECAY_AFTER_SUCCESS_MS) {
    this.restartTimestamps = [];
    this.lastSuccessfulProcessing = null;
    this.decayEligible = false;
  }

  this.restartTimestamps = this.restartTimestamps.filter(
    ts => now - ts < RESTART_WINDOW_MS
  );
  this.restartTimestamps.push(now);
  return this.restartTimestamps.length <= MAX_WINDOWED_RESTARTS;
}
```

### Task 2.3 — Update `recordSuccess()` to require N consecutive calls

```ts
recordSuccess(): void {
  this.consecutiveSuccessCount += 1;
  this.lastSuccessfulProcessing = Date.now();
  if (this.consecutiveSuccessCount >= REQUIRED_CONSECUTIVE_SUCCESSES_FOR_DECAY) {
    this.decayEligible = true;
  }
}
```

Add private field `decayEligible = false`.

### Task 2.4 — Add introspection getters for logging (optional but useful)

```ts
get totalRestarts(): number { return this.totalRestartsAllTime; }
get lifetimeCap(): number { return ABSOLUTE_LIFETIME_RESTART_CAP; }
```

### Task 2.5 — Update log statements at trip sites to include new fields

- `SessionRoutes.ts:319-326`: add `totalRestarts: session.restartGuard.totalRestarts`
  and `lifetimeCap: session.restartGuard.lifetimeCap` to the error log payload.
- `worker-service.ts:828-835`: same additions.

### Verification

- `bun test tests/worker/RestartGuard.test.ts` (new file — see Phase 4).
- Behavior check: 49 failed restarts → still allowed; 50th → blocked; 51st →
  blocked (lifetime cap persists).
- Behavior check: 4 successes then restart → full window still counted.
  5th success then restart 5 min later → window cleared.

### Anti-pattern guard

- Don't make `recordSuccess` reset `totalRestartsAllTime` — the lifetime cap is
  meant to be terminal.
- Don't silently change the meaning of the existing getters — add new ones.

---

## Phase 3 — Extend `unrecoverablePatterns` (handle OAuth expiry)

**Goal:** When Max-plan OAuth tokens expire/are revoked, treat the SDK error as
unrecoverable so no restart is attempted.

**Target file:** `src/services/worker-service.ts:713-727`

**Doc reference:**

- Current array + match logic quoted in Phase 0 discovery.
- `OpenRouterAgent.ts:458` — error throw format is
  `` `OpenRouter API error: ${response.status} - ${errorText}` ``.
- `tests/worker/agents/fallback-error-handler.test.ts:75-77` — existing
  assertion `'401 Unauthorized'` is terminal, confirming it is safe to treat
  as unrecoverable.

### Task 3.1 — Add OAuth / OpenRouter auth strings

Add these entries (in a clear grouping comment) to the array at
`worker-service.ts:713-727`:

```ts
// OAuth / subscription-token expiry (Max plan users) — matches SDK
// subprocess error messages when the inherited CLAUDE_CODE_OAUTH_TOKEN
// is no longer valid.
'OAuth token expired',
'token has been revoked',
'Unauthorized',
// Parallel to 'Gemini API error: 401' — catches OpenRouter OAuth failures.
'OpenRouter API error: 401',
'OpenRouter API error: 403',
```

**Do not add bare `'401'`** — too broad. Anti-pattern confirmed by discovery.

### Verification

- `grep -n "'Unauthorized'" src/services/worker-service.ts` → should match.
- Run `bun test tests/worker/worker-service-unrecoverable.test.ts` (new file —
  see Phase 4) — assertions cover each new pattern.
- Run `bun test tests/worker/agents/fallback-error-handler.test.ts` — must
  still pass (no regressions).

### Anti-pattern guard

- No regex or `startsWith` — keep substring match semantics to avoid breaking
  existing entries.
- Don't unpack `error.code` or nested JSON bodies in this phase — discovery
  confirmed all current agent error throws embed the status/message in
  `.message`.

---

## Phase 4 — Tests (no tests existed for RestartGuard or unrecoverablePatterns)

**Goal:** Prevent regression on all three fixes.

**Test framework:** `bun test` (see `package.json` scripts).

### Task 4.1 — Create `tests/worker/RestartGuard.test.ts`

Test suites (doc: `src/services/worker/RestartGuard.ts` as modified in Phase 2):

- `recordRestart respects window`: push 10 restarts in <60s → allowed; 11th →
  blocked.
- `recordSuccess requires N consecutive before decay`: 4 successes then
  restart 6 min later → window still populated; 5 successes then restart 6 min
  later → window cleared.
- `restart breaks success streak`: 3 successes → 1 restart → 4 more successes
  (total 7 successes with gap) → streak counter is 4 at end, not 7 (decay
  NOT yet eligible).
- `lifetime cap is terminal`: 50 restarts → OK; 51st → blocked even if window
  is empty; recordSuccess cannot un-block it.
- `getters return expected values`: `totalRestarts`, `lifetimeCap`,
  `restartsInWindow`, `maxRestarts`, `windowMs`.

Use `Date.now` mocking via Bun's `spyOn(Date, 'now')` or an injected clock.
Check project-local patterns first — if other tests in `tests/worker/` already
use a specific clock helper, copy that pattern. Otherwise straight `spyOn`.

### Task 4.2 — Create `tests/worker/worker-service-unrecoverable.test.ts`

Focused unit test on the `.some(p => errorMessage.includes(p))` matcher for
each new pattern. If extracting `unrecoverablePatterns` into a standalone
exported helper makes testing easier, do that as part of this task (small
refactor — pull the array + predicate into a named export at the top of
`worker-service.ts` and import it in the `.catch` block). Verify:

- Each of `'OAuth token expired'`, `'token has been revoked'`,
  `'Unauthorized'`, `'OpenRouter API error: 401'`,
  `'OpenRouter API error: 403'` matches a realistic error message.
- Bare `'401'` by itself (e.g., `"request-id-401xyz"`) does NOT match — this
  test locks in the decision not to add bare `'401'`.
- All PRE-EXISTING patterns still match realistic messages (no regressions).

### Task 4.3 — Add SessionRoutes restart-trip integration test

If a test file already exists for `SessionRoutes` in `tests/worker/http/` or
`tests/server/`, extend it. Otherwise create
`tests/worker/http/SessionRoutes.restart-trip.test.ts`:

- Set up a session with pending messages and a `RestartGuard` pre-loaded near
  the window cap.
- Trigger the restart path (mock `pendingStore.getPendingCount` > 0).
- Assert: `pendingStore.markAllSessionMessagesAbandoned` was called with the
  session ID; `sessionManager.removeSessionImmediate` was called;
  `eventBroadcaster.broadcastSessionCompleted` was called.

If SessionRoutes has no existing test harness, keep scope small: lift the
restart-trip branch into a private helper method first, export it for
testing, and assert on the helper. Don't build a full HTTP harness for this.

### Verification

- `bun test tests/worker/RestartGuard.test.ts` — green.
- `bun test tests/worker/worker-service-unrecoverable.test.ts` — green.
- `bun test tests/worker/http/SessionRoutes.restart-trip.test.ts` — green.
- `bun test` (full suite) — no regressions.

### Anti-pattern guard

- Don't stub Claude Agent SDK in these tests — they are pure unit tests.
- Don't test behavior that would require spinning up the real worker daemon.

---

## Phase 5 — Final Verification

Run the full validation sequence:

1. `bun run build` — builds cleanly (no TS errors).
2. `bun test` — full suite green.
3. `grep -rn 'Messages remain in pending state' src/` — no matches (the phrase
   is gone from the codebase).
4. `grep -n "'OAuth token expired'" src/services/worker-service.ts` — matches.
5. `grep -n 'ABSOLUTE_LIFETIME_RESTART_CAP\|REQUIRED_CONSECUTIVE_SUCCESSES_FOR_DECAY' src/services/worker/RestartGuard.ts`
   — both match.
6. Sanity read of the diff — each of the three changes is isolated and local,
   no refactor creep.
7. Update `CHANGELOG.md` — actually, per repo CLAUDE.md the changelog is
   auto-generated. **Do not edit.**
8. Stage & commit on the existing branch
   `investigate/windows-infinite-loop-usage-drain`. Commit message:
   `fix: stop Max-plan drain loop on Windows (RestartGuard + SessionRoutes + OAuth patterns)`.

### Anti-pattern guard

- Do not touch `CHANGELOG.md` (auto-generated per CLAUDE.md).
- Do not bump version here — release flow handles it.
- Do not merge to main — the user wants a PR.

---

## Execution note

Each implementation phase (1, 2, 3, 4) is self-contained and cites the exact
files/lines discovered in Phase 0. Phases 1, 2, 3 can run in parallel;
Phase 4 depends on Phase 2 (RestartGuard API shape) and Phase 3 (optional
helper export from worker-service). Phase 5 depends on all prior phases.
