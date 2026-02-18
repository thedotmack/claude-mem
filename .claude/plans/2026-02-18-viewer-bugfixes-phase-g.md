# Implementation Plan: Phase G — Viewer Bug Fixes & UX Regressions

## Overview

Fix 8 bugs and UX regressions identified after Phases A-F of the viewer redesign, plus 2 user-requested amendments. All work stays within the existing viewer architecture (React components, hooks, CSS in viewer-template.html). Delivery on current branch `feature/viewer-redesign`.

## Requirements

1. Swap j/k session navigation to Arrow Up/Down; add Arrow Left/Right for day navigation (Amendment)
2. Remove redundant Enter key shortcut (Bug 1)
3. Prevent 'f' key from leaking into search field when opening filter panel (Bug 2)
4. Fix date filter range to show full date1-to-date2 range, not just date2 (Bug 3)
5. Ensure observations before first summary are visible in the UI (Bug 4)
6. Add day navigation arrows (clickable buttons) near "Today" label (Bug 5)
7. Make the date header sticky at top of session list (Bug 6)
8. Restore processing count on top of the animated processing icon (Bug 7)
9. Three distinct card styles: Prompt, Task Notification, Observation (Bug 8 — expanded)

## Delivery Strategy

current-branch (feature/viewer-redesign)

## Architecture Changes

One new component: `TaskNotificationCard` for rendering `<task-notification>` prompts with their own visual style.

Files modified:
- `src/ui/viewer/hooks/useKeyboardNavigation.ts` — swap j/k→ArrowUp/ArrowDown, add ArrowLeft/ArrowRight for day nav, add `preventDefault` on 'f'
- `src/ui/viewer/components/KeyboardShortcutHelp.tsx` — update shortcuts display
- `src/ui/viewer/hooks/useSearch.ts` — fix dateStart to start-of-day local time
- `src/ui/viewer/hooks/useSessionDetail.ts` — handle pre-summary observations
- `src/ui/viewer/components/TwoPanel.tsx` — add DayNavigator component, wire ArrowLeft/Right
- `src/ui/viewer/components/SessionList.tsx` — ensure sticky date header works
- `src/ui/viewer/components/Header.tsx` — restore processing count display
- `src/ui/viewer/components/PromptCard.tsx` — add "Prompt" type badge, distinct visual treatment
- `src/ui/viewer/components/TaskNotificationCard.tsx` — NEW: card for task notification prompts
- `src/ui/viewer/components/ObservationCard.tsx` — add observation type badge
- `src/ui/viewer/components/SessionDetail.tsx` — route task-notification prompts to TaskNotificationCard
- `src/ui/viewer/components/Feed.tsx` — route task-notification prompts to TaskNotificationCard
- `src/ui/viewer-template.html` — CSS for all changes

---

## Implementation Steps

### Phase 1: Keyboard & Quick Wins (No Dependencies)

#### G.1 Swap j/k to Arrow Up/Down for session navigation (Amendment)
- **Files**: `src/ui/viewer/hooks/useKeyboardNavigation.ts`, `src/ui/viewer/components/KeyboardShortcutHelp.tsx`
- **Action**:
  1. In `resolveKeyAction`: replace `case 'j': return 'next'` with `case 'ArrowDown': return 'next'`, and `case 'k': return 'prev'` with `case 'ArrowUp': return 'prev'`
  2. Add `case 'ArrowLeft': return 'prev-day'` and `case 'ArrowRight': return 'next-day'` (new actions for day navigation)
  3. Update the `KeyAction` type to include `'prev-day' | 'next-day'`
  4. In the hook's effect handler: add cases for `'prev-day'` and `'next-day'` that call a new callback prop `onDayNavigate(direction: 'prev' | 'next')`
  5. Add `event.preventDefault()` for ArrowUp/ArrowDown to prevent page scrolling
  6. In `KeyboardShortcutHelp.tsx`: update SHORTCUTS to show `↑ / ↓` for sessions and `← / →` for days
  7. Remove the Enter key entry entirely
- **Why**: Arrow keys are more intuitive than vim-style j/k; left/right for day navigation pairs naturally with up/down for session navigation
- **Dependencies**: None
- **Risk**: Low — ArrowUp/ArrowDown must be preventDefault'd to avoid scrolling the page

#### G.2 Prevent 'f' key leaking into search field (Bug 2)
- **File**: `src/ui/viewer/hooks/useKeyboardNavigation.ts`
- **Action**: Add `event.preventDefault()` in the `'toggle-palette'` case, same as the `'focus-search'` case already does
- **Why**: When 'f' is pressed, the browser queues the character. Focus shifts to command palette search input where 'f' appears.
- **Dependencies**: None
- **Risk**: Low
- **Tests**: Verify `event.preventDefault` is called when action is `toggle-palette`

#### G.3 Restore processing count on icon (Bug 7)
- **Files**: `src/ui/viewer/components/Header.tsx`, `src/ui/viewer-template.html`
- **Action**: Verify/fix the `queue-bubble` div rendering and CSS positioning. The div exists (lines 47-51) and renders when `queueDepth > 0`. Check CSS `.queue-bubble` positioning relative to `header__logo-wrapper`. Also verify `useSSE.ts` `processing_status` handler sets `queueDepth`.
- **Risk**: Low
- **Tests**: Existing E2E tests cover processing state

#### G.4 Three distinct card styles: Prompt, Task Notification, Observation (Bug 8 — expanded)
- **Files**: `src/ui/viewer/components/PromptCard.tsx`, `src/ui/viewer/components/TaskNotificationCard.tsx` (NEW), `src/ui/viewer/components/ObservationCard.tsx`, `src/ui/viewer/components/SessionDetail.tsx`, `src/ui/viewer/components/Feed.tsx`, `src/ui/viewer-template.html`
- **Action**:
  1. **Detection**: A prompt is a task notification when `prompt.prompt_text.trimStart().startsWith('<task-notification>')`. Create a helper `isTaskNotification(prompt: UserPrompt): boolean`.
  2. **TaskNotificationCard** (NEW component):
     - Parse the XML-like content to extract task-id, status, summary, result
     - Distinct visual style: neutral/muted background (gray tint), left border accent (e.g., orange/amber), "TASK" type badge
     - Collapsed by default, shows task-id, status, and summary. Expandable for full result.
  3. **PromptCard** updates:
     - Add `<span className="prompt-card__type-badge">Prompt</span>` in header
     - Add a speech-bubble icon or distinct left-border accent (purple)
     - Stronger background contrast from observations
  4. **ObservationCard** updates:
     - Add `<span className="observation-card__type-badge">{observation.type}</span>` in header
     - Keep existing blue tint background
  5. **Routing** in `SessionDetail.tsx` and `Feed.tsx`:
     - Before rendering a prompt, check `isTaskNotification(prompt)`. If true, render `<TaskNotificationCard>` instead of `<PromptCard>`.
  6. **CSS** in `viewer-template.html`:
     - `.task-notification-card` — gray/muted bg, amber left border, distinct from prompt and observation
     - `.prompt-card__type-badge` — purple badge
     - `.observation-card__type-badge` — blue badge
     - `.task-notification-card__type-badge` — amber/orange badge
- **Why**: Three types of content (user prompts, task notifications, observations) need three distinct visual treatments
- **Dependencies**: None
- **Risk**: Low-Medium

### Phase 2: Date & Navigation Fixes (Interconnected)

#### G.5 Fix date filter range regression (Bug 3)
- **File**: `src/ui/viewer/hooks/useSearch.ts`
- **Action**:
  1. Add function `inclusiveDateStart(dateStart: string): string` that converts "YYYY-MM-DD" to `${dateStart}T00:00:00` (local time, no Z suffix)
  2. Apply in `buildSearchParams`: `params.set('dateStart', inclusiveDateStart(filters.dateStart))`
  3. Also apply the same fix in `useActivityDensity.ts` for consistency
- **Why**: `new Date("YYYY-MM-DD")` parses as UTC midnight, which misses early-local-day observations for users behind UTC
- **Dependencies**: None
- **Risk**: Medium
- **Tests**: Unit tests for `inclusiveDateStart` and `inclusiveDateEnd`

#### G.6 Add DayNavigator component with arrow buttons (Bug 5)
- **Files**: `src/ui/viewer/components/TwoPanel.tsx`, `src/ui/viewer-template.html`
- **Action**:
  1. Add a `DayNavigator` inline component above the session list (or between session list and activity bar)
  2. Shows: `[←] date label [→]` with clickable arrow buttons
  3. Left arrow = previous day, Right arrow = next day (capped at today)
  4. Clicking date label resets to "All" (no date filter)
  5. Wire to the same date filter state that keyboard ArrowLeft/ArrowRight uses
  6. When no filter active: show "All sessions"
  7. When single day: show "Today" or formatted date (e.g., "Feb 17")
  8. When date range: show "Feb 15 – Feb 17"
- **CSS**: `.day-navigator`, `.day-navigator__btn`, `.day-navigator__label`
- **Dependencies**: G.5 (date filtering must work correctly), G.1 (ArrowLeft/Right actions)
- **Risk**: Medium
- **Tests**: Unit test for date calculation logic; E2E test for arrow click behavior

#### G.7 Make date header sticky in session list (Bug 6)
- **Files**: `src/ui/viewer/components/SessionList.tsx`, `src/ui/viewer-template.html`
- **Action**:
  1. The CSS already has `position: sticky; top: 0; z-index: 1;` on `.session-list__day-header`
  2. The `.session-list__group` wrapper breaks sticky positioning (sticky only sticks within containing block)
  3. **Fix**: Flatten the non-virtual rendering path — render headers and sessions as direct children of `.session-list` instead of wrapping in `.session-list__group`
  4. Virtual path: keep current behavior (100+ sessions threshold)
- **Why**: The sticky CSS exists but the group wrapper breaks it
- **Dependencies**: None
- **Risk**: Medium
- **Tests**: E2E test for sticky header visibility when scrolling

### Phase 3: Pre-Summary Observations (Bug 4)

#### G.8 Show observations before first summary (Bug 4)
- **Files**: `src/ui/viewer/App.tsx`, `src/ui/viewer/hooks/useSessionDetail.ts`, `src/ui/viewer/hooks/useSessionList.ts`
- **Action**:
  1. **Investigation**: The TwoPanel session list is populated from summaries only. Before any summary exists, observations from SSE events exist in memory but aren't shown.
  2. The `getSummaryTimeWindow` method uses `epochAfter = 0` for the first summary, which includes ALL observations from session start. So observations ARE included once the first summary arrives.
  3. **Likely fix**: Ensure the observation count in session list items includes pre-summary observations. Verify `summary.observation_count` in `mapSummaryToSessionListItem`.
  4. **If deeper issue found**: Consider showing a temporary "in progress" session list entry for sessions with observations but no summary yet.
- **Why**: Users think observations are lost when they're deferred until summary creation
- **Dependencies**: None (investigation-driven)
- **Risk**: Low-Medium

### Phase 4: Testing & Verification

#### G.9 Unit tests for all bug fixes
- **Files**:
  - `tests/ui/components/KeyboardShortcutHelp.test.ts` — Enter removed, arrow keys shown
  - `tests/ui/hooks/useKeyboardNavigation.test.ts` — ArrowUp/Down/Left/Right, preventDefault on 'f' and arrows
  - `tests/ui/components/PromptCard.test.ts` — type badge renders
  - `tests/ui/components/TaskNotificationCard.test.ts` (NEW) — parses and renders task notifications
  - `tests/ui/components/ObservationCard.test.ts` — type badge renders
  - `tests/ui/hooks/useSearch.test.ts` (NEW) — `inclusiveDateStart`, `inclusiveDateEnd`
- **Dependencies**: G.1-G.8

#### G.10 E2E tests
- **File**: `tests/ui/viewer-bugfixes.spec.ts` (NEW)
- Tests:
  - Day navigator arrows change date display
  - Sticky date header remains visible on scroll
  - 'f' key opens filter without typing 'f' in search
  - Prompt, task notification, and observation cards are visually distinct
  - Arrow Up/Down navigate sessions
- **Dependencies**: G.1-G.8

#### G.11 Build verification
- `npm run build-and-sync` — clean build
- Full vitest suite — no regressions
- Playwright suite — all pass including new tests
- **Dependencies**: G.9, G.10

---

## Testing Strategy

- **Unit tests**: KeyboardShortcutHelp, useKeyboardNavigation (arrow keys, preventDefault), useSearch date helpers, PromptCard badge, TaskNotificationCard parsing/rendering, ObservationCard badge, isTaskNotification helper
- **E2E tests (Playwright)**: Day navigation arrows, sticky header, 'f' key filter, card visual distinction, arrow key session navigation
- **Visual verification (playwright-cli)**: Use the `playwright-cli` MCP skill to manually navigate the viewer at localhost:37777 after each phase. Confirm:
  - Card visual distinction (Prompt purple, Task Notification amber, Observation blue)
  - Processing count bubble positioning on the icon
  - Sticky date header behavior when scrolling
  - Day navigator arrows rendering and click behavior
  - Date range filter showing correct results
  - 'f' key not leaking into search
  - Arrow key navigation working correctly

## Risks & Mitigations

- **Risk**: ArrowUp/ArrowDown may conflict with page scrolling
  - Mitigation: `event.preventDefault()` when not in an input element

- **Risk**: Date filter fix (G.5) may have timezone edge cases
  - Mitigation: Use explicit local-time ISO strings; test with various UTC offsets

- **Risk**: Sticky header fix (G.7) may break virtual scrolling layout
  - Mitigation: Only change the non-virtual rendering path

- **Risk**: Task notification XML parsing may be fragile
  - Mitigation: Use regex extraction with fallback to showing raw text

- **Risk**: Day navigator (G.6) adds a new UI element
  - Mitigation: Minimal design using existing design tokens

## Success Criteria

- [ ] Arrow Up/Down navigate sessions (not j/k)
- [ ] Arrow Left/Right navigate days
- [ ] Enter key not shown in keyboard shortcuts
- [ ] 'f' key opens filter panel without typing 'f' into search
- [ ] Date range filter returns results for all days in range
- [ ] Observations before first summary visible once summary arrives
- [ ] Day navigation arrows allow quick single-day navigation
- [ ] Date header stays fixed at top of session list when scrolling
- [ ] Processing count shows on animated processing icon
- [ ] Three distinct card styles: Prompt (purple), Task Notification (amber), Observation (blue)
- [ ] Task notifications detected via `<task-notification>` prefix
- [ ] All existing tests pass (no regressions)
- [ ] New unit + E2E tests pass
- [ ] Build succeeds: `npm run build-and-sync`
