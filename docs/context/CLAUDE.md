# Claude-Mem Context Documentation

## What This Folder Is

This `docs/context/` folder contains **internal documentation** - planning documents, design references, audits, and work-in-progress materials that support development but are NOT user-facing.

## Folder Structure

```
docs/
├── public/         ← User-facing Mintlify docs (DO NOT put internal docs there)
│   └── *.mdx       - Official documentation
└── context/        ← You are here (Internal documentation)
    ├── *.md        - Planning docs, audits, references
    ├── *-plan.md   - Implementation plans
    ├── *-audit.md  - Code audits and reviews
    ├── agent-sdk-*.md - SDK reference materials
    └── subdirs/    - Organized by topic
```

## What Belongs Here

**Internal Documentation** (`.md` format):
- Planning documents (`*-plan.md`, `*-outline.md`)
- Implementation analysis (`*-audit.md`, `*-code-reference.md`)
- Error tracking (`typescript-errors.md`)
- Design documents not ready for public docs
- PR review responses
- Reference materials (like `agent-sdk-ref.md`)
- Work-in-progress documentation
- Technical investigations and postmortems
- Architecture analysis documents

**Examples from this folder:**
- `mem-search-technical-architecture.md` - Deep technical reference
- `search-architecture-analysis.md` - Implementation analysis
- `agent-sdk-ref.md` - SDK reference for developers
- `typescript-errors.md` - Error tracking during development
- `worker-service-architecture.md` - Internal architecture notes
- `processing-indicator-audit.md` - Code audit document

## What Does NOT Belong Here

**User-Facing Documentation** goes in `/docs/public/`:
- User guides and tutorials
- Official architecture documentation
- Installation instructions
- Configuration guides
- Best practices for users
- Troubleshooting guides

**Rule of Thumb:**
- If a user would read it → `/docs/public/` (as `.mdx`)
- If only developers/contributors need it → `/docs/context/` (as `.md`)

## File Organization

### By Type
- `*-plan.md` - Implementation plans for features
- `*-audit.md` - Code audits and reviews
- `*-postmortem.md` - Analysis of issues or incidents
- `*-reference.md` - Technical reference materials
- `*-analysis.md` - Architecture or design analysis

### By Topic
- Create subdirectories for related documents
- Example: `claude-code/` for Claude Code specific docs
- Example: `architecture/` for internal architecture notes

## Development Workflow

### When to Create Context Docs

1. **Planning Phase** - Before implementing a feature
   - Create `feature-name-plan.md`
   - Outline implementation steps
   - Document decisions and tradeoffs

2. **During Development** - Track issues and decisions
   - Create `feature-name-audit.md` for code reviews
   - Update `typescript-errors.md` for build issues
   - Document gotchas in topic-specific files

3. **After Implementation** - Preserve knowledge
   - Create `feature-name-postmortem.md` if issues occurred
   - Update architecture analysis documents
   - Archive plan docs (don't delete - useful for history)

### Graduating to Public Docs

When internal docs are polished enough for users:
1. Convert `.md` to `.mdx` format
2. Add Mintlify frontmatter
3. Move to appropriate `/docs/public/` subdirectory
4. Add to `docs.json` navigation
5. Keep original in `/docs/context/` for reference

## Summary

**Simple Rule**:
- `/docs/context/` = Internal docs, plans, references, audits ← YOU ARE HERE
- `/docs/public/` = Official user documentation (Mintlify .mdx files)

**Purpose**: This folder preserves development context, design decisions, and technical knowledge that helps contributors understand WHY things work the way they do, even if users don't need those details.
