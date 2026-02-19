---
type: analysis
title: "Issue #730: Vector-db folder grows to 1TB+ when multiple Docker containers share the same .claude-mem mount"
created: 2026-02-19
tags:
  - triage
  - issue
  - intent-bug
  - severity-critical
  - priority-urgent
related:
  - "[[Triage-Run-2026-02-19]]"
  - "[[Issue-730]]"
---
# Issue #730: Vector-db folder grows to 1TB+ when multiple Docker containers share the same .claude-mem mount

- Link: [GitHub](https://github.com/thedotmack/claude-mem/issues/730)
- Run: [[Triage-Run-2026-02-19]]

## Triage Summary

- Rank: 18
- Score: 4654
- Intent: bug
- Severity: critical
- Priority: urgent
- Inactivity Days: 6

## Draft Execution Plan

### Next Steps

- Review the latest issue timeline and confirm the current problem statement.
- Reproduce the failure and isolate the smallest safe fix.

### Risks

- Critical severity may need immediate coordination and rollback options.
- Ongoing discussion churn can change acceptance criteria mid-implementation.

### Validation Checks

- Run targeted tests for affected areas and verify no new failures.
- Re-check the original report scenario end-to-end.
