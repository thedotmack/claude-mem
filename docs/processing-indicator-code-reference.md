# Processing Indicator: Complete Code Reference

This document provides a line-by-line breakdown of every piece of code related to the processing/activity indicator (the spinning logomark in the top left corner of the viewer UI).

## Overview

The processing indicator is a visual cue that shows when the worker service is actively processing memories (observations or summaries). It consists of:

1. **Logomark Image**: `claude-mem-logomark.webp` in the header
2. **Spinning Animation**: Applied via CSS class when processing is active
3. **State Management**: Tracked via Server-Sent Events (SSE) from the worker
4. **Processing Sessions Set**: Maintains active session IDs being processed

## Data Flow

```
Worker Service
  └─> broadcastProcessingStatus(sessionId, isProcessing)
      └─> broadcastSSE({ type: 'processing_status', ... })
          └─> SSE Event Stream (/stream)
              └─> useSSE Hook (React)
                  └─> processingSessions Set<string>
                      └─> App.tsx: isProcessing={processingSessions.size > 0}
                          └─> Header.tsx: className={isProcessing ? 'spinning' : ''}
                              └─> CSS Animation: @keyframes spin
```

---

## 1. TypeScript Types

### File: `src/ui/viewer/types.ts`

**Lines 45-58: StreamEvent interface with processing_status type**

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
  processing?: {
    session_id: string;
    is_processing: boolean;
  };
}
```

**Purpose**: Defines the structure of SSE events. The `processing_status` type includes a `processing` object that indicates whether a session is currently being processed.

---

## 2. Worker Service (Backend)

### File: `src/services/worker-service.ts`

**Lines 247-272: broadcastSSE() - Core SSE broadcasting**

```typescript
/**
 * Broadcast SSE event to all connected clients
 */
private broadcastSSE(event: any): void {
  if (this.sseClients.size === 0) {
    return; // No clients connected, skip broadcast
  }

  const data = `data: ${JSON.stringify(event)}\n\n`;
  const clientsToRemove: Response[] = [];

  for (const client of this.sseClients) {
    try {
      client.write(data);
    } catch (error) {
      // Client disconnected, mark for removal
      clientsToRemove.push(client);
    }
  }

  // Clean up disconnected clients
  for (const client of clientsToRemove) {
    this.sseClients.delete(client);
  }

  if (clientsToRemove.length > 0) {
    logger.info('WORKER', `SSE cleaned up disconnected clients`, { count: clientsToRemove.length });
  }
}
```

**Purpose**: Broadcasts SSE events to all connected UI clients. Handles disconnected clients gracefully.

---

**Lines 274-285: broadcastProcessingStatus() - Processing indicator control**

```typescript
/**
 * Broadcast processing status to SSE clients
 */
private broadcastProcessingStatus(claudeSessionId: string, isProcessing: boolean): void {
  this.broadcastSSE({
    type: 'processing_status',
    processing: {
      session_id: claudeSessionId,
      is_processing: isProcessing
    }
  });
}
```

**Purpose**: Dedicated method for broadcasting processing status changes. Called when sessions start/stop processing.

---

**Line 817: Summarize request triggers processing start**

```typescript
// Notify UI that processing is active
this.broadcastProcessingStatus(session.claudeSessionId, true);
```

**Context**: In `handleSummarize()` method - when a summary request is queued, processing starts.

**File location**: `src/services/worker-service.ts:817`

---

**Line 1153: Summary generation complete - processing stops**

```typescript
// Notify UI that processing is complete (summary is the final step)
this.broadcastProcessingStatus(session.claudeSessionId, false);
```

**Context**: In `processSummarizeMessage()` after successfully generating and saving a summary.

**File location**: `src/services/worker-service.ts:1153`

---

**Line 1183: No summary generated - still mark processing complete**

```typescript
// Still mark processing as complete even if no summary was generated
this.broadcastProcessingStatus(session.claudeSessionId, false);
```

**Context**: In `processSummarizeMessage()` when no summary tags are found in the AI response.

**File location**: `src/services/worker-service.ts:1183`

---

## 3. React Hook: SSE Connection

### File: `src/ui/viewer/hooks/useSSE.ts`

**Line 12: processingSessions state initialization**

```typescript
const [processingSessions, setProcessingSessions] = useState<Set<string>>(new Set());
```

**Purpose**: Maintains a Set of session IDs currently being processed. Used to determine if any processing is active.

---

**Lines 90-104: processing_status event handler**

```typescript
case 'processing_status':
  if (data.processing) {
    const processing = data.processing;
    console.log('[SSE] Processing status:', processing);
    setProcessingSessions(prev => {
      const next = new Set(prev);
      if (processing.is_processing) {
        next.add(processing.session_id);
      } else {
        next.delete(processing.session_id);
      }
      return next;
    });
  }
  break;
```

**Purpose**: Listens for `processing_status` SSE events and updates the processingSessions Set:
- `is_processing: true` → Adds session ID to Set
- `is_processing: false` → Removes session ID from Set

**File location**: `src/ui/viewer/hooks/useSSE.ts:90-104`

---

**Lines 73-78: Summary completion also clears processing status**

```typescript
// Mark session as no longer processing (summary is the final step)
setProcessingSessions(prev => {
  const next = new Set(prev);
  next.delete(summary.session_id);
  return next;
});
```

**Purpose**: When a `new_summary` event arrives, remove the session from processingSessions (defensive cleanup in case the processing_status event was missed).

**File location**: `src/ui/viewer/hooks/useSSE.ts:73-78`

---

**Line 125: Hook return value includes processingSessions**

```typescript
return { observations, summaries, prompts, projects, processingSessions, isConnected };
```

**Purpose**: Exposes processingSessions Set to consuming components.

---

## 4. React Component: App

### File: `src/ui/viewer/App.tsx`

**Line 20: Destructure processingSessions from useSSE**

```typescript
const { observations, summaries, prompts, projects, processingSessions, isConnected } = useSSE();
```

**Purpose**: Gets the processingSessions Set from the SSE hook.

---

**Line 92: Convert Set to boolean for Header component**

```typescript
isProcessing={processingSessions.size > 0}
```

**Purpose**: Passes `true` to Header if ANY session is being processed (Set has items), `false` otherwise.

**File location**: `src/ui/viewer/App.tsx:92`

---

## 5. React Component: Header

### File: `src/ui/viewer/components/Header.tsx`

**Line 12: isProcessing prop definition**

```typescript
interface HeaderProps {
  isConnected: boolean;
  projects: string[];
  currentFilter: string;
  onFilterChange: (filter: string) => void;
  onSettingsToggle: () => void;
  sidebarOpen: boolean;
  isProcessing: boolean;  // ← Processing indicator prop
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}
```

**Purpose**: Defines the isProcessing boolean prop for the Header component.

---

**Line 24: isProcessing destructured from props**

```typescript
export function Header({
  isConnected,
  projects,
  currentFilter,
  onFilterChange,
  onSettingsToggle,
  sidebarOpen,
  isProcessing,  // ← Received from App.tsx
  themePreference,
  onThemeChange
}: HeaderProps) {
```

---

**Line 31: Logomark with conditional spinning class**

```typescript
<img src="claude-mem-logomark.webp" alt="" className={`logomark ${isProcessing ? 'spinning' : ''}`} />
```

**Purpose**: The core of the processing indicator. When `isProcessing` is `true`, adds the `spinning` CSS class to the logomark image, triggering the rotation animation.

**File location**: `src/ui/viewer/components/Header.tsx:31`

**Rendered HTML Examples**:
- Not processing: `<img src="claude-mem-logomark.webp" alt="" className="logomark" />`
- Processing: `<img src="claude-mem-logomark.webp" alt="" className="logomark spinning" />`

---

## 6. CSS Styling & Animation

### File: `plugin/ui/viewer.html` (compiled output)

**Lines 342-349: Logomark and spinning class styles**

```css
.logomark {
  height: 32px;
  width: auto;
}

.logomark.spinning {
  animation: spin 1.5s linear infinite;
}
```

**Purpose**:
- `.logomark`: Base styles for the logo image (32px height, auto width)
- `.logomark.spinning`: Applies the spin animation when processing is active
  - **Duration**: 1.5 seconds per rotation
  - **Timing**: Linear (constant speed)
  - **Iteration**: Infinite (continues until class is removed)

**File location**: `plugin/ui/viewer.html:342-349`

---

**Lines 701-705: Spin animation keyframes**

```css
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
```

**Purpose**: Defines the rotation animation. Rotates the element from 0° (implicit) to 360° (full circle).

**File location**: `plugin/ui/viewer.html:701-705`

---

## 7. API Endpoint: Stream

### File: `src/ui/viewer/constants/api.ts`

**Line 11: SSE stream endpoint**

```typescript
export const API_ENDPOINTS = {
  OBSERVATIONS: '/api/observations',
  SUMMARIES: '/api/summaries',
  PROMPTS: '/api/prompts',
  SETTINGS: '/api/settings',
  STATS: '/api/stats',
  STREAM: '/stream',  // ← SSE endpoint for processing events
} as const;
```

**Purpose**: Centralized API endpoint constant. The `/stream` endpoint is used by `useSSE.ts` to establish the EventSource connection.

---

## Bonus: Feed Skeleton Processing Indicator

While not part of the logomark spinner, the feed also shows processing state with skeleton cards and a smaller spinner.

### File: `src/ui/viewer/components/Feed.tsx`

**Lines 66-80: Create skeleton items for processing sessions**

```typescript
// Create skeleton items for sessions being processed that don't have summaries yet
const skeletons: FeedItem[] = [];
processingSessions.forEach(sessionId => {
  if (!sessionsWithSummaries.has(sessionId)) {
    const prompt = sessionPrompts.get(sessionId);
    skeletons.push({
      itemType: 'skeleton',
      id: sessionId,
      session_id: sessionId,
      project: prompt?.project,
      // Always use current time so skeletons appear at top of feed
      created_at_epoch: Date.now()
    });
  }
});
```

**Purpose**: Creates temporary skeleton cards for sessions currently being processed (from `processingSessions` Set).

---

**Line 104: Render SummarySkeleton component**

```typescript
} else if (item.itemType === 'skeleton') {
  return <SummarySkeleton key={key} sessionId={item.session_id} project={item.project} />;
```

---

### File: `src/ui/viewer/components/SummarySkeleton.tsx`

**Lines 14-17: Processing indicator in skeleton card**

```typescript
<div className="processing-indicator">
  <div className="spinner"></div>
  <span>Generating...</span>
</div>
```

**Purpose**: Shows a smaller inline spinner with "Generating..." text in skeleton summary cards.

---

### CSS for Feed Spinner

**Lines 682-690: Processing indicator container**

```css
.processing-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--color-accent-focus);
  font-size: 11px;
  font-weight: 500;
  margin-left: auto;
}
```

---

**Lines 692-700: Small spinner for skeleton cards**

```css
.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--color-border-primary);
  border-top-color: var(--color-accent-focus);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
```

**Purpose**: Smaller circular spinner (12px) with faster rotation (0.8s) used in skeleton cards. Uses the same `@keyframes spin` animation.

---

**Lines 711-715: Skeleton card opacity**

```css
.summary-skeleton {
  opacity: 0.7;
}

.summary-skeleton .processing-indicator {
  margin-left: auto;
}
```

---

**Lines 715-740: Skeleton line animations (shimmer effect)**

```css
.skeleton-line {
  height: 16px;
  background: linear-gradient(90deg, var(--color-skeleton-base) 25%, var(--color-skeleton-highlight) 50%, var(--color-skeleton-base) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: 4px;
  margin-bottom: 8px;
}

.skeleton-title {
  height: 20px;
  width: 80%;
  margin-bottom: 10px;
}

.skeleton-subtitle {
  height: 16px;
  width: 90%;
}

.skeleton-subtitle.short {
  width: 60%;
}

@keyframes shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}
```

**Purpose**: Creates animated placeholder lines with a shimmer effect while summary is being generated.

---

## Summary: Complete Processing Flow

1. **User submits prompt** → Claude Code session starts
2. **Worker receives summarize request** → `worker-service.ts:817` calls `broadcastProcessingStatus(sessionId, true)`
3. **SSE broadcasts** → `{ type: 'processing_status', processing: { session_id: '...', is_processing: true } }`
4. **React receives event** → `useSSE.ts:90-104` adds sessionId to `processingSessions` Set
5. **State flows down** → `App.tsx:92` converts Set size to boolean → `Header.tsx:31` receives `isProcessing={true}`
6. **CSS class applied** → `className="logomark spinning"` triggers animation
7. **Logomark spins** → CSS animation `@keyframes spin` rotates 360° every 1.5s
8. **Feed shows skeleton** → `Feed.tsx:66-80` creates skeleton cards for processing sessions
9. **Summary completes** → `worker-service.ts:1153` calls `broadcastProcessingStatus(sessionId, false)`
10. **SSE broadcasts** → `{ type: 'processing_status', processing: { session_id: '...', is_processing: false } }`
11. **React clears state** → `useSSE.ts:90-104` removes sessionId from Set
12. **Animation stops** → `isProcessing={false}` removes `spinning` class, logomark stops rotating

---

## File Summary

| File | Lines | Purpose |
|------|-------|---------|
| `src/ui/viewer/types.ts` | 45-58 | Defines `StreamEvent` interface with `processing_status` type |
| `src/services/worker-service.ts` | 247-285, 817, 1153, 1183 | Broadcasts processing status via SSE |
| `src/ui/viewer/hooks/useSSE.ts` | 12, 73-78, 90-104, 125 | Manages `processingSessions` Set from SSE events |
| `src/ui/viewer/App.tsx` | 20, 92 | Converts Set to boolean, passes to Header |
| `src/ui/viewer/components/Header.tsx` | 12, 24, 31 | Applies `spinning` class to logomark |
| `plugin/ui/viewer.html` (CSS) | 342-349, 701-705 | Styles logomark and defines spin animation |
| `src/ui/viewer/components/Feed.tsx` | 66-80, 104 | Creates skeleton cards for processing sessions |
| `src/ui/viewer/components/SummarySkeleton.tsx` | 14-17 | Renders inline spinner in skeleton cards |
| `plugin/ui/viewer.html` (CSS) | 682-740 | Styles for skeleton cards and inline spinner |

---

## Key Design Decisions

1. **Set vs Boolean**: Using a `Set<string>` for `processingSessions` allows tracking multiple concurrent sessions. The UI shows spinning as long as *any* session is processing.

2. **Defensive Cleanup**: Both `processing_status` events AND `new_summary` events clear processing state, ensuring the spinner stops even if events arrive out of order.

3. **CSS-Only Animation**: No JavaScript animation loops - pure CSS transforms provide smooth, GPU-accelerated rotation with minimal performance impact.

4. **Dual Indicators**: Header logomark (global processing state) + skeleton cards (per-session processing state) provide both overview and detail-level feedback.

5. **SSE Architecture**: Server-Sent Events provide real-time updates without polling, keeping UI responsive with minimal network overhead.
