# Processing Indicator "Fucking Stupid" Audit

## What It SHOULD Do (Simple Version)

1. **Page load**: Check if worker is already processing → spin or don't spin
2. **UserPromptSubmit**: Start spinning, set worker status "on"
3. **Summary complete**: Stop spinning, set worker status "off"

**Result**: One boolean. Simple. Clear.

---

## What It ACTUALLY Does (Overcomplicated Version)

### Problem 1: Set<string> Instead of Boolean

**Current**: `processingSessions: Set<string>` - tracks individual session IDs

**File**: `src/ui/viewer/hooks/useSSE.ts:12`
```typescript
const [processingSessions, setProcessingSessions] = useState<Set<string>>(new Set());
```

**Why it's stupid**: We don't care WHICH sessions are processing. We just need to know IF anything is processing. The conversion to boolean happens anyway:

**File**: `src/ui/viewer/App.tsx:92`
```typescript
isProcessing={processingSessions.size > 0}  // ← Converting Set to boolean!
```

**Fix**: Just use `const [isProcessing, setIsProcessing] = useState(false)`

---

### Problem 2: Complex Set Manipulation

**Current**: Add/remove session IDs from Set based on SSE events

**File**: `src/ui/viewer/hooks/useSSE.ts:90-104`
```typescript
case 'processing_status':
  if (data.processing) {
    const processing = data.processing;
    console.log('[SSE] Processing status:', processing);
    setProcessingSessions(prev => {
      const next = new Set(prev);
      if (processing.is_processing) {
        next.add(processing.session_id);  // ← Why track session ID?
      } else {
        next.delete(processing.session_id);  // ← Just need true/false
      }
      return next;
    });
  }
  break;
```

**Why it's stupid**: Creating new Sets, adding/removing items, all to track individual sessions when we only care about "any processing yes/no"

**Fix**: `setIsProcessing(data.is_processing)`

---

### Problem 3: Defensive Cleanup in Multiple Places

**Current**: Two places remove sessions from the Set

**Location 1** - `useSSE.ts:90-104` - Handles `processing_status` events
**Location 2** - `useSSE.ts:73-78` - Handles `new_summary` events

```typescript
// Mark session as no longer processing (summary is the final step)
setProcessingSessions(prev => {
  const next = new Set(prev);
  next.delete(summary.session_id);  // ← Defensive cleanup
  return next;
});
```

**Why it's stupid**: We're defensively cleaning up in case events arrive out of order. This is a band-aid for not having a single source of truth.

**Fix**: One place sets `isProcessing = false` (summary complete). No defensive cleanup needed.

---

### Problem 4: SSE Event Includes Session ID

**Current**: Processing status events include session ID

**File**: `src/services/worker-service.ts:277-285`
```typescript
private broadcastProcessingStatus(claudeSessionId: string, isProcessing: boolean): void {
  this.broadcastSSE({
    type: 'processing_status',
    processing: {
      session_id: claudeSessionId,  // ← Why send session ID?
      is_processing: isProcessing
    }
  });
}
```

**Why it's stupid**: We send session_id but never use it for the spinner decision. The logomark doesn't care WHICH session is processing.

**Fix**: `{ type: 'processing_status', isProcessing: boolean }` - That's it.

---

### Problem 5: TypeScript Interface Overcomplicated

**Current**: StreamEvent includes processing object with session_id

**File**: `src/ui/viewer/types.ts:54-57`
```typescript
processing?: {
  session_id: string;  // ← Unnecessary
  is_processing: boolean;
};
```

**Why it's stupid**: Adds complexity to type definitions when we only need the boolean.

**Fix**: `isProcessing?: boolean;`

---

### Problem 6: Multiple Broadcast Points (But No Initial State!)

**Current**: 3 places broadcast processing status in worker-service.ts

1. **Line 817**: `handleSummarize()` → `broadcastProcessingStatus(session.claudeSessionId, true)`
2. **Line 1153**: `processSummarizeMessage()` success → `broadcastProcessingStatus(session.claudeSessionId, false)`
3. **Line 1183**: `processSummarizeMessage()` no summary → `broadcastProcessingStatus(session.claudeSessionId, false)`

**Why it's stupid**: We broadcast changes but there's NO WAY TO GET INITIAL STATE on page load. If you open the viewer while processing is active, you won't see the spinner until the next status change.

**Fix**: Add `/api/processing-status` endpoint that returns current state. Call it on page load.

---

### Problem 7: Skeleton Cards Require Session Tracking

**Current**: Feed.tsx creates skeleton cards for each processing session

**File**: `src/ui/viewer/components/Feed.tsx:66-80`
```typescript
const skeletons: FeedItem[] = [];
processingSessions.forEach(sessionId => {  // ← Iterating over Set
  if (!sessionsWithSummaries.has(sessionId)) {
    const prompt = sessionPrompts.get(sessionId);
    skeletons.push({
      itemType: 'skeleton',
      id: sessionId,
      session_id: sessionId,  // ← Using individual session IDs
      project: prompt?.project,
      created_at_epoch: Date.now()
    });
  }
});
```

**Why it's relevant**: This is the ONLY place that actually uses individual session IDs. If we want per-session skeleton cards, we need session tracking.

**Question for you**: Do we still want skeleton cards in the feed? Or just the logomark spinner?

**Option A**: Keep skeleton cards → Need to track session IDs (current complexity justified)
**Option B**: Remove skeleton cards → Use simple boolean for logomark only

---

### Problem 8: No Synchronization Between Worker State and UI State

**Current**: Worker doesn't maintain processing state. It just broadcasts events.

**Why it's stupid**: If the UI disconnects/reconnects, it loses processing state. Worker should be the source of truth.

**Fix**: Worker maintains `private isProcessing: boolean = false`
- Set to true on summarize request
- Set to false when summary completes
- Expose via `/api/processing-status` endpoint
- Broadcast changes via SSE

---

## The "Fucking Stupid" Score

| Issue | Complexity Cost | Why It's Stupid |
|-------|----------------|-----------------|
| Set<string> instead of boolean | HIGH | We convert it to boolean anyway |
| Complex Set manipulation | HIGH | 10+ lines of code to add/remove from Set |
| Defensive cleanup in 2 places | MEDIUM | Band-aid for lack of single source of truth |
| SSE includes unused session_id | LOW | Minor overhead, but conceptually wrong |
| Overcomplicated TypeScript types | LOW | Makes code harder to read |
| No initial state endpoint | HIGH | Broken user experience (no spinner on page load during active processing) |
| Session tracking for skeletons | ??? | Depends if we want per-session skeletons or not |
| Worker has no state | HIGH | UI is source of truth, should be worker |

---

## Proposed Simple Architecture

### Worker Service (Source of Truth)

```typescript
class WorkerService {
  private isProcessing: boolean = false;  // Single source of truth

  // New endpoint: GET /api/processing-status
  private handleGetProcessingStatus(req: Request, res: Response): void {
    res.json({ isProcessing: this.isProcessing });
  }

  // On summarize request
  private handleSummarize(req: Request, res: Response): void {
    // ... existing code ...
    this.isProcessing = true;
    this.broadcastSSE({ type: 'processing_status', isProcessing: true });
    // ...
  }

  // On summary complete
  private processSummarizeMessage(session: SessionState, message: Message): void {
    // ... existing code ...

    // After summary is saved/failed:
    this.isProcessing = false;
    this.broadcastSSE({ type: 'processing_status', isProcessing: false });
  }
}
```

### React Hook (Simple Boolean)

```typescript
export function useSSE() {
  const [isProcessing, setIsProcessing] = useState(false);

  // On mount: Get initial state
  useEffect(() => {
    fetch('/api/processing-status')
      .then(res => res.json())
      .then(data => setIsProcessing(data.isProcessing));
  }, []);

  // Listen for changes
  useEffect(() => {
    const eventSource = new EventSource('/stream');

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'processing_status') {
        setIsProcessing(data.isProcessing);  // Simple!
      }
    };

    return () => eventSource.close();
  }, []);

  return { isProcessing, /* other state */ };
}
```

### TypeScript Types (Simplified)

```typescript
export interface StreamEvent {
  type: 'initial_load' | 'new_observation' | 'new_summary' | 'new_prompt' | 'processing_status';
  observations?: Observation[];
  summaries?: Summary[];
  prompts?: UserPrompt[];
  projects?: string[];
  observation?: Observation;
  summary?: Summary;
  prompt?: UserPrompt;
  isProcessing?: boolean;  // Simple!
}
```

### React Components (No Changes Needed!)

```typescript
// App.tsx
const { isProcessing } = useSSE();  // Already a boolean now!

<Header isProcessing={isProcessing} />  // Just pass it through

// Header.tsx (no changes needed)
<img className={`logomark ${isProcessing ? 'spinning' : ''}`} />
```

---

## Breaking Changes & Decisions

### Decision 1: What About Skeleton Cards?

**Current**: Skeleton cards in feed show "Generating..." for each processing session

**Options**:

**A) Keep skeleton cards** (requires session tracking)
- Need to track individual session IDs
- Justifies the Set<string> complexity
- Provides per-session feedback in feed

**B) Remove skeleton cards** (simplest)
- Only logomark spins (global processing indicator)
- No need to track individual sessions
- Simpler architecture

**C) Hybrid: Single skeleton card** (middle ground)
- Show ONE skeleton card when `isProcessing === true`
- Don't tie it to specific sessions
- Keep it simple but provide feed feedback

**What do you want?**

---

### Decision 2: Multiple Concurrent Sessions?

**Question**: Can multiple sessions be processing simultaneously?

**Current assumption**: Yes (hence the Set<string>)

**Reality check**: Worker processes messages from a queue. Can it actually process multiple sessions at once, or is it sequential?

**If sequential**: We DEFINITELY don't need session tracking. One boolean is perfect.

**If concurrent**: We still might not need session tracking for the logomark (just spin if ANY processing), but skeleton cards would need session IDs.

---

## Recommended Implementation Plan

### Phase 1: Add Initial State (Quick Win)

**File**: `src/services/worker-service.ts`
- Add `private isProcessing: boolean = false;`
- Add GET `/api/processing-status` endpoint
- Set `this.isProcessing = true` on line 817
- Set `this.isProcessing = false` on lines 1153, 1183

**File**: `src/ui/viewer/hooks/useSSE.ts`
- Add `fetch('/api/processing-status')` on mount
- Initialize `isProcessing` state from response

**Impact**: Fixes the "no spinner on page load" bug without breaking changes.

---

### Phase 2: Simplify State (Breaking Change)

**File**: `src/services/worker-service.ts`
- Change `broadcastProcessingStatus()` to send `{ type: 'processing_status', isProcessing: boolean }`
- Remove session_id from broadcast

**File**: `src/ui/viewer/hooks/useSSE.ts`
- Change `processingSessions` Set to `isProcessing` boolean
- Simplify event handler: `setIsProcessing(data.isProcessing)`
- Remove defensive cleanup from `new_summary` handler

**File**: `src/ui/viewer/types.ts`
- Simplify `StreamEvent.processing` to just `isProcessing?: boolean`

**File**: `src/ui/viewer/App.tsx`
- Change `processingSessions.size > 0` to just `isProcessing`

**File**: `src/ui/viewer/components/Feed.tsx`
- **Decision needed**: Remove skeleton cards or show single generic skeleton?

**Impact**: Cleaner code, easier to maintain, fewer bugs.

---

## Files That Need Changes

### Worker Service
- `src/services/worker-service.ts` (add state, endpoint, update broadcasts)

### React
- `src/ui/viewer/hooks/useSSE.ts` (boolean instead of Set, fetch initial state)
- `src/ui/viewer/types.ts` (simplify StreamEvent)
- `src/ui/viewer/App.tsx` (pass boolean instead of Set.size > 0)
- `src/ui/viewer/components/Feed.tsx` (handle skeleton cards decision)
- `src/ui/viewer/constants/api.ts` (add PROCESSING_STATUS endpoint)

### No Changes Needed
- `src/ui/viewer/components/Header.tsx` (already receives boolean)
- `src/ui/viewer/components/SummarySkeleton.tsx` (might be removed)
- CSS/animations (work the same with boolean)

---

## Summary: What's Fucking Stupid

1. **Set<string> when we only need boolean** ← Biggest offender
2. **No initial state on page load** ← Broken UX
3. **Complex Set manipulation** ← 10+ lines for add/remove
4. **Defensive cleanup in multiple places** ← No single source of truth
5. **Session IDs in SSE events** ← Data we don't use
6. **Worker doesn't maintain state** ← UI is source of truth (backwards!)

**Complexity Score**: 7/10 stupid

**After refactor**: 2/10 (the remaining complexity is React/SSE boilerplate)

---

## What Do You Want To Do?

Tell me:
1. **Skeleton cards**: Keep (per-session), remove entirely, or show one generic skeleton?
2. **Breaking changes**: OK to simplify now, or do you want backwards compatibility?
3. **Implementation**: Want me to do Phase 1 (quick fix), Phase 2 (full refactor), or both?
