# Implementation Plan: Phase F — Polish & Integration Testing

## Overview

Phase F closes out the viewer redesign with code cleanup, edge case fixes, accessibility, visual polish, CSS organization, responsive verification, integration tests, and final reviews before merge. No new features — only refinement of existing functionality.

## Delivery Strategy

current-branch (feature/viewer-redesign)

## Architecture Changes

None. All modifications are within existing files.

---

## Implementation Tasks (Execution Order)

### Group 1: Code Cleanup (zero risk, do first)

#### F.1 Remove console.log statements from useSSE
- **File**: `src/ui/viewer/hooks/useSSE.ts`
- Remove all `console.log` statements (7 total, fire on every SSE event)
- Keep `console.error` for connection failures
- **Risk**: Low

#### F.2 Remove unused variables
- **File**: `src/ui/viewer/components/LogsModal.tsx` — remove unused `_componentConfig` variable
- **File**: `src/ui/viewer/App.tsx` — evaluate `_refreshStats` and `_resolvedTheme` (underscore-prefixed, may be intentional)
- **Risk**: Low

### Group 2: Critical Edge Case Fixes

#### F.3 Guard malformed JSON in ObservationCard
- **File**: `src/ui/viewer/components/ObservationCard.tsx`
- Wrap `JSON.parse` calls for `facts`, `concepts`, `files_read`, `files_modified` in try/catch
- Currently crashes the entire card tree on malformed JSON from API
- **Risk**: Low
- **Tests**: Add vitest cases for malformed JSON inputs

#### F.4 Handle API errors in useSettings
- **File**: `src/ui/viewer/hooks/useSettings.ts`
- Wrap `saveSettings` fetch in try/catch — network failures currently leave UI stuck in "Saving..."
- **Risk**: Low

#### F.5 Handle API errors in useContextPreview
- **File**: `src/ui/viewer/hooks/useContextPreview.ts`
- Wrap `refresh` fetch in try/catch — network failures currently throw unhandled rejections
- **Risk**: Low

#### F.6 Handle empty summary sections in SummaryCard
- **File**: `src/ui/viewer/components/SummaryCard.tsx`
- Show "No details available" when all section fields are empty/undefined
- **Risk**: Low
- **Tests**: Add vitest case for empty sections

### Group 3: Accessibility

#### F.7 Add focus-visible styles for all interactive elements
- **File**: `src/ui/viewer-template.html`
- Add `:focus-visible` rules for 12 selectors (session rows, observation cards, section headers, buttons, chips, settings/console/scroll-to-top FABs)
- Use: `outline: 2px solid var(--color-border-focus); outline-offset: 2px;`
- **Risk**: Low — CSS only

#### F.8 Add aria-label to unlabeled interactive elements
- **Files**: `Header.tsx`, `App.tsx`, `ObservationCard.tsx`, `SummaryCard.tsx`
- Add `aria-label` to settings button, console toggle, expandable observation cards, summary section headers
- **Risk**: Low

#### F.9 Add aria-live regions for dynamic content
- **Files**: `SessionDetail.tsx`, `SessionList.tsx`, `Feed.tsx`
- Add `aria-live="polite"` to loading/empty state containers so screen readers announce changes
- **Risk**: Low

#### F.10 Add landmark roles to layout regions
- **Files**: `Header.tsx`, `TwoPanel.tsx`, `SessionDetail.tsx`
- Change Header div to `<header>` with `role="banner"`, add `aria-label` to aside and session detail
- **Risk**: Low

### Group 4: Visual Polish

#### F.11 Hover states and transitions
- **File**: `src/ui/viewer-template.html`
- Add/verify hover states for: session list rows, prompt card toggle, observation cards
- Add smooth transition on summary section collapse/expand
- **Risk**: Low — CSS only

#### F.12 Text truncation for long content
- **File**: `src/ui/viewer-template.html`
- Card titles: 2-line clamp with ellipsis
- Session list request text: single-line truncation
- **Risk**: Low

### Group 5: Inline Style Extraction

#### F.13 Extract ErrorBoundary inline styles to CSS tokens
- **Files**: `src/ui/viewer/components/ErrorBoundary.tsx`, `src/ui/viewer-template.html`
- Replace hardcoded dark colors (#1a1a1a, #0d1117) with design token CSS classes
- Currently the only component that doesn't respect light/dark theming
- **Risk**: Low

#### F.14 Extract TerminalPreview inline styles to CSS (optional)
- **Files**: `src/ui/viewer/components/TerminalPreview.tsx`, `src/ui/viewer-template.html`
- Extract static styles to CSS classes, keep dynamic ones (wordWrap) inline
- **Risk**: Low-Medium — requires visual verification
- **Priority**: Lower — skip if time-constrained

### Group 6: CSS Organization & Responsive Verification

#### F.15 CSS final cleanup and organization
- **File**: `src/ui/viewer-template.html`
- Organize CSS into logical sections with comment headers
- Remove dead CSS from deleted/refactored components
- Consolidate media queries by breakpoint
- **Risk**: Low

#### F.16 Responsive design verification
- **File**: `src/ui/viewer-template.html`
- Verify desktop (1200px+), tablet (768-1199px), mobile (<768px) breakpoints
- Adjust if needed: session list width, command palette sizing, card layout
- **Risk**: Medium

### Group 7: Unit Tests

#### F.17 Unit tests for ObservationCard malformed JSON
- **File**: `tests/ui/components/ObservationCard.test.ts`
- Test: malformed facts/concepts JSON, null optional fields, empty title
- **Dependencies**: F.3

#### F.18 Unit tests for SummaryCard empty sections
- **File**: `tests/ui/components/SummaryCard.test.ts`
- Test: all section fields empty/undefined shows "No details available"
- **Dependencies**: F.6

#### F.19 Unit tests for data utility edge cases
- **File**: `tests/ui/utils/data.test.ts`
- Test: `mergeAndDeduplicateByProject` with empty arrays, overlapping IDs, missing project field
- **Dependencies**: None

### Group 8: Integration Tests (Playwright)

#### F.20 Settings modal interaction flow
- **File**: `tests/ui/viewer-polish.spec.ts` (NEW)
- Test: open, change value, save, verify success message, close via Escape/backdrop
- **Dependencies**: None

#### F.21 Console drawer tests
- **File**: `tests/ui/viewer-polish.spec.ts`
- Test: open/close drawer, log content or empty state, filter by level
- **Dependencies**: None

#### F.22 Focus-visible verification
- **File**: `tests/ui/viewer-polish.spec.ts`
- Test: Tab to session rows, settings button, filter button — verify outline appears
- **Dependencies**: F.7

#### F.23 Empty state variations
- **File**: `tests/ui/viewer-polish.spec.ts`
- Test: no-session-selected message, zero search results, empty project
- **Dependencies**: F.6

#### F.24 Activity bar interaction
- **File**: `tests/ui/viewer-polish.spec.ts`
- Test: tooltip on hover, date range select/deselect on click
- **Dependencies**: None

#### F.25 Search-to-filter mode transition
- **File**: `tests/ui/viewer-polish.spec.ts`
- Test: type in search → feed mode, results badge, clear → two-panel mode
- **Dependencies**: None

### Group 9: Final Verification & Review

#### F.26 Full regression run
- Run full vitest suite (target: 1140+ pass, 0 new failures)
- Run full Playwright suite (target: 75+ pass including new tests)

#### F.27 Code review
- Invoke `magic-claude:code-reviewer` on all Phase F changes
- Address any CRITICAL or HIGH issues

#### F.28 Security review
- Invoke `magic-claude:ts-security-reviewer`
- Check XSS in card rendering, secure event handling, no exposed secrets

#### F.29 Build verification and commit
- `npm run build-and-sync` — clean build
- Final commit on feature/viewer-redesign

---

## Success Criteria

- [ ] ObservationCard handles malformed JSON without crashing
- [ ] Settings/context preview handle network failures gracefully
- [ ] All interactive elements have :focus-visible styles
- [ ] aria-label on all icon-only buttons
- [ ] aria-live on dynamic content regions
- [ ] Semantic landmarks on layout regions
- [ ] Hover states on interactive elements
- [ ] Long text truncated with ellipsis
- [ ] ErrorBoundary respects theme tokens
- [ ] console.log removed from useSSE
- [ ] CSS organized with section headers
- [ ] Responsive at desktop/tablet/mobile
- [ ] All existing tests pass (no regressions)
- [ ] 15-20 new Playwright E2E tests pass
- [ ] 8-12 new vitest unit tests pass
- [ ] Code review: no CRITICAL/HIGH issues
- [ ] Security review: no issues
