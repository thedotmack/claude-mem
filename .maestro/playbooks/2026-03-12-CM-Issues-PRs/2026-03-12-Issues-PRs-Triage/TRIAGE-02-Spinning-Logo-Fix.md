# TRIAGE-02: Spinning Logo Root Cause & Fix Plan

**Created**: 2026-03-12 7:55 PM PDT
**Branch**: feat/factory-ai
**Status**: Planned

---

## Root Cause Analysis

The spinning logo has **three independent failure modes** that cause "weird" behavior:

### Failure Mode 1: Phantom Spinning (spinner stays on with no work happening)

**Root cause**: `broadcastProcessingStatus()` is **reactive only** — it fires on session events (prompt received, observation queued, session completed). There is **no periodic heartbeat**. If the final `broadcastProcessingStatus()` call computes `isProcessing: true` (because a message was briefly in `processing` state) but the message completes before the next broadcast, the UI never receives the `isProcessing: false` update.

**Contributing factor**: `hasAnyPendingWork()` (`PendingMessageStore.ts:404`) resets stuck messages >5 minutes old as a side-effect, but this method is only called when `broadcastProcessingStatus()` runs — which requires an event trigger. No events = no self-healing check.

**Evidence**: The stale session reaper runs every 2 minutes (`worker-service.ts:476`) but does NOT call `broadcastProcessingStatus()` after reaping. Even when stale sessions are cleaned up, the UI isn't notified.

### Failure Mode 2: SSE Connection Goes Stale

**Root cause**: `SSEBroadcaster.broadcast()` (`SSEBroadcaster.ts:58`) calls `client.write(data)` with **no try/catch**. When a client's TCP connection dies silently (network change, laptop sleep), the `Response` object stays in the `sseClients` Set but writes fail silently. The dead client never receives status updates.

**Contributing factor**: No application-level heartbeat/ping. The HTTP `Connection: keep-alive` header (`ViewerRoutes.ts:74`) relies on TCP keepalive, which has OS-dependent timeouts (often 2+ hours on macOS).

**Evidence**: The `'close'` event listener (`SSEBroadcaster.ts:26-28`) only fires when the client explicitly closes the connection — not when the network drops.

### Failure Mode 3: Favicon Animation Jank on Background Tabs

**Root cause**: `useSpinningFavicon.ts:59` uses a **fixed rotation increment per frame** (`(2 * Math.PI) / 90`), assuming 60fps. Browsers throttle `requestAnimationFrame` to ~1fps on background tabs. Result: the favicon rotates 4° per second instead of 240°/s, appearing frozen or jerky.

**Non-issue**: The CSS `.spinning` animation on the header logomark is unaffected — CSS animations continue at normal speed even on background tabs.

---

## Phase 0: Documentation & API Discovery

### Verified APIs and Patterns

| Method | File:Line | Purpose |
|--------|-----------|---------|
| `broadcastProcessingStatus()` | `worker-service.ts:872` | Computes and broadcasts `isProcessing` + `queueDepth` |
| `isAnySessionProcessing()` | `SessionManager.ts:431` | Delegates to `PendingMessageStore.hasAnyPendingWork()` |
| `hasAnyPendingWork()` | `PendingMessageStore.ts:404` | SQL check + 5-min stuck reset side-effect |
| `resetStaleProcessingMessages()` | `PendingMessageStore.ts:160` | Resets stuck messages (configurable threshold) |
| `claimNextMessage()` | `PendingMessageStore.ts:93` | Has 60-second self-healing for per-session stuck messages |
| `SSEBroadcaster.broadcast()` | `SSEBroadcaster.ts:45` | Writes to all clients, no error handling |
| `SSEBroadcaster.addClient()` | `SSEBroadcaster.ts:21` | Registers client, listens for `close` event |
| `useSpinningFavicon()` | `useSpinningFavicon.ts:7` | Canvas rAF animation, frame-count rotation |
| `useSSE()` | `useSSE.ts:8` | EventSource with 3s reconnect on error |
| Stale session reaper | `worker-service.ts:476` | 2-minute interval, does NOT broadcast status |

### Anti-Patterns to Avoid
- Do NOT add try/catch blocks during initial development (fail-fast pillar)
- Do NOT add a polling mechanism in the UI — SSE push is the correct pattern
- Do NOT replace EventSource with WebSocket — SSE is simpler and sufficient

---

## Phase 1: Add Processing Status Heartbeat (Fixes Failure Mode 1)

**What**: Add a periodic `broadcastProcessingStatus()` call to self-correct stale spinner state.

### Tasks

1. **In `worker-service.ts`, after the stale session reaper setup (~line 485)**, add a processing status heartbeat interval:
   - Interval: 30 seconds
   - Call `this.broadcastProcessingStatus()`
   - Store interval handle for cleanup in `shutdown()`
   - Pattern: Copy the stale session reaper pattern at `worker-service.ts:476-485`

2. **In the stale session reaper callback (~line 478)**, add `this.broadcastProcessingStatus()` after reaping completes — so UI updates immediately when stale sessions are cleaned.

### Verification
- `grep -n 'broadcastProcessingStatus' src/services/worker-service.ts` shows the new interval setup
- Start worker, trigger processing, kill the agent mid-processing → spinner should self-correct within 30s (not 5 minutes)

---

## Phase 2: Harden SSE Broadcaster (Fixes Failure Mode 2)

**What**: Add write error handling and application-level heartbeat to SSEBroadcaster.

### Tasks

1. **In `SSEBroadcaster.ts:broadcast()` (~line 58)**, wrap `client.write(data)` in try/catch:
   - On write error: call `this.removeClient(client)` to clean up dead connections
   - Log at debug level (not warn — client disconnects are normal)

2. **In `SSEBroadcaster.ts:addClient()` (~line 21)**, start a heartbeat:
   - Send `:ping\n\n` (SSE comment) every 30 seconds
   - SSE comments are ignored by `EventSource` but keep the TCP connection alive
   - Store the interval per-client and clear it in `removeClient()`
   - Alternative: Single shared interval that pings all clients (simpler)

### Verification
- Open viewer UI, wait 60+ seconds → no disconnection in browser Network tab
- Kill worker → viewer reconnects within 3 seconds (existing behavior preserved)

---

## Phase 3: Fix Favicon Animation (Fixes Failure Mode 3)

**What**: Switch from frame-count rotation to timestamp-based rotation.

### Tasks

1. **In `useSpinningFavicon.ts`, replace the animation loop** (~lines 52-69):
   - Track `startTime` using `performance.now()` instead of `rotationRef.current += increment`
   - Compute rotation: `const elapsed = performance.now() - startTime; const rotation = (elapsed / 1500) * 2 * Math.PI;`
   - This makes the animation frame-rate independent — correct speed regardless of tab throttling

### Verification
- Open viewer, trigger processing, switch to another tab for 10 seconds, switch back → favicon should show smooth rotation (not frozen at the same angle)

---

## Phase 4: Type Safety Cleanup

**What**: Fix the `StreamEvent` interface gap.

### Tasks

1. **In `src/ui/viewer/types.ts`**, add `queueDepth?: number` to the `StreamEvent` interface (it's already used at `useSSE.ts:88` but not typed)

### Verification
- `npx tsc --noEmit` passes with no errors related to `queueDepth`

---

## Phase 5: Verification

1. **Manual test**: Open viewer → trigger processing → observe spinner starts → processing completes → spinner stops within 2 seconds
2. **Stuck message test**: Start processing → kill worker mid-processing → restart worker → spinner self-corrects within 30 seconds
3. **Background tab test**: Open viewer → trigger processing → switch tabs → switch back → favicon spinning smoothly
4. **Connection resilience test**: Open viewer → disconnect network briefly → reconnect → spinner shows correct state
5. **Run existing tests**: `npm test` passes
