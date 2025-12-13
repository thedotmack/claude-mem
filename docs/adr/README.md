# Architecture Decision Records (ADRs)

This directory documents significant architectural decisions made in the Claude-Mem project using the [Architecture Decision Record](https://adr.github.io) format.

## ADRs

| ID | Title | Status | Date |
|----|-------|--------|------|
| [0001](0001-replace-pm2-with-bun.md) | Replace PM2 with Native Bun Process Management | ACCEPTED | 2025-12-13 |

## Purpose

ADRs capture the reasoning behind major architectural choices, including:

- **Context**: Why the decision was needed
- **Decision**: What was chosen and why
- **Consequences**: Trade-offs and implications
- **Alternatives**: Options that were considered

This helps future maintainers understand:
- What constraints existed at decision time
- Why certain approaches were preferred
- Known trade-offs of current architecture

## Format

Each ADR follows the standard template:

```markdown
# ADR NNNN: Title

**Status:** PROPOSED | ACCEPTED | DEPRECATED | SUPERSEDED

**Date:** YYYY-MM-DD

## Context
## Decision
## Consequences
## Alternatives Considered
## Related Documents
## References
```

**Status Definitions:**
- **PROPOSED**: Under discussion
- **ACCEPTED**: Decision made and implemented
- **DEPRECATED**: No longer followed
- **SUPERSEDED**: Replaced by newer ADR

## Adding New ADRs

1. Create file: `000N-short-title.md` (increment N)
2. Copy template from existing ADR
3. Write concisely but completely
4. Update table above
5. Link from related documentation

## References

- ADR GitHub: https://github.com/adr/adr
- ADR Tools: https://github.com/npryce/adr-tools
- Markdown ADR Template: https://adr.github.io/madr/
