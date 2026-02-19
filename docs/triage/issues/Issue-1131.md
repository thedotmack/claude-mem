---
type: analysis
title: "Issue #1131: chroma-mcp subprocess leak: ensureConnection() never closes old transport before reconnect"
created: 2026-02-19
tags:
  - triage
  - issue
  - intent-bug
  - severity-critical
  - priority-urgent
related:
  - "[[Triage-Run-2026-02-19]]"
  - "[[Issue-1131]]"
  - "[[Issue-1077]]"
---
# Issue #1131: chroma-mcp subprocess leak: ensureConnection() never closes old transport before reconnect

- Link: [GitHub](https://github.com/thedotmack/claude-mem/issues/1131)
- Run: [[Triage-Run-2026-02-19]]

## Triage Summary

- Rank: 12
- Score: 4657
- Intent: bug
- Severity: critical
- Priority: urgent
- Inactivity Days: 3
- Related Items: [[Issue-1077]]

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
