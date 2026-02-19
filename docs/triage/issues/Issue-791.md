---
type: analysis
title: "Issue #791: [Windows] Keyword search (FTS5) returns 'No results' despite data existing in database (v9.0.6)"
created: 2026-02-19
tags:
  - triage
  - issue
  - intent-bug
  - severity-high
  - priority-high
related:
  - "[[Triage-Run-2026-02-19]]"
  - "[[Issue-791]]"
---
# Issue #791: [Windows] Keyword search (FTS5) returns 'No results' despite data existing in database (v9.0.6)

- Link: [GitHub](https://github.com/thedotmack/claude-mem/issues/791)
- Run: [[Triage-Run-2026-02-19]]

## Triage Summary

- Rank: 69
- Score: 3549
- Intent: bug
- Severity: high
- Priority: high
- Inactivity Days: 11

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
