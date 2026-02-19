---
type: analysis
title: "Issue #1183: v10.3.0+: backfill fails with MetadataValue conversion error via chroma-mcp"
created: 2026-02-19
tags:
  - triage
  - issue
  - intent-bug
  - severity-high
  - priority-high
related:
  - "[[Triage-Run-2026-02-19]]"
  - "[[Issue-1183]]"
  - "[[Issue-1182]]"
  - "[[Issue-1166]]"
---
# Issue #1183: v10.3.0+: backfill fails with MetadataValue conversion error via chroma-mcp

- Link: [GitHub](https://github.com/thedotmack/claude-mem/issues/1183)
- Run: [[Triage-Run-2026-02-19]]

## Triage Summary

- Rank: 35
- Score: 3560
- Intent: bug
- Severity: high
- Priority: high
- Inactivity Days: 0
- Related Items: [[Issue-1182]], [[Issue-1166]]

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
