---
type: analysis
title: "Issue #838: Bug: `session-init` hook fails with HTTP 400 when invoked from Cursor's `beforeSubmitPrompt`"
created: 2026-02-19
tags:
  - triage
  - issue
  - intent-bug
  - severity-high
  - priority-high
related:
  - "[[Triage-Run-2026-02-19]]"
  - "[[Issue-838]]"
---
# Issue #838: Bug: `session-init` hook fails with HTTP 400 when invoked from Cursor's `beforeSubmitPrompt`

- Link: [GitHub](https://github.com/thedotmack/claude-mem/issues/838)
- Run: [[Triage-Run-2026-02-19]]

## Triage Summary

- Rank: 45
- Score: 3557
- Intent: bug
- Severity: high
- Priority: high
- Inactivity Days: 3

## Draft Execution Plan

### Next Steps

- Review the latest issue timeline and confirm the current problem statement.
- Reproduce the failure and isolate the smallest safe fix.

### Risks

- High-severity changes can regress user-critical flows if scope drifts.
- Ongoing discussion churn can change acceptance criteria mid-implementation.

### Validation Checks

- Run targeted tests for affected areas and verify no new failures.
- Re-check the original report scenario end-to-end.
