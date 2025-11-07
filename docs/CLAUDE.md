# Claude-Mem Documentation Folder

## What This Folder Is

This `docs/` folder is a **Mintlify documentation site** - the official user-facing documentation for claude-mem. It's a structured documentation platform with a specific file format and organization.

## File Structure Requirements

### Mintlify Documentation Files (.mdx)
All official documentation files must be:
- Written in `.mdx` format (Markdown with JSX support)
- Listed in `docs.json` navigation structure
- Follow Mintlify's schema and conventions

The documentation is organized into these sections:
- **Get Started**: Introduction, installation, usage guides
- **Best Practices**: Context engineering, progressive disclosure
- **Configuration & Development**: Settings, dev workflow, troubleshooting
- **Architecture**: System design, components, technical details

### Configuration File
`docs.json` defines:
- Site metadata (name, description, theme)
- Navigation structure
- Branding (logos, colors)
- Footer links and social media

## What Does NOT Belong Here

**Planning documents, design docs, and reference materials should go in `/context/` instead:**

Files that should be in `/context/` (not `/docs/`):
- Planning documents (`*-plan.md`, `*-outline.md`)
- Implementation analysis (`*-audit.md`, `*-code-reference.md`)
- Error tracking (`typescript-errors.md`)
- Design documents not part of official docs
- PR review responses
- Reference materials (like `agent-sdk-ref.md`)

**Example**: The deleted `VIEWER.md` was moved because it was implementation documentation, not user-facing docs.

## Current Files That Should Be Moved

These `.md` files currently in `docs/` should probably be moved to `context/`:
- `typescript-errors.md` - Error tracking
- `worker-service-architecture.md` - Implementation details (not user-facing architecture)
- `processing-indicator-audit.md` - Implementation audit
- `processing-indicator-code-reference.md` - Code reference
- `worker-service-rewrite-outline.md` - Planning document
- `worker-service-overhead.md` - Analysis document
- `CHROMA.md` - Implementation reference (if not user-facing)
- `chroma-search-completion-plan.md` - Planning document

## How to Add Official Documentation

1. Create a new `.mdx` file in the appropriate subdirectory
2. Add the file path to `docs.json` navigation
3. Use Mintlify's frontmatter and components
4. Follow the existing documentation style

## Development Workflow

**For contributors working on claude-mem:**
- Read `/CLAUDE.md` in the project root for development instructions
- Place planning/design docs in `/context/`
- Only add user-facing documentation to `/docs/`
- Test documentation locally with Mintlify CLI if available

## Summary

**Simple Rule**:
- `/docs/` = Official user documentation (Mintlify .mdx files)
- `/context/` = Development context, plans, references, internal docs
