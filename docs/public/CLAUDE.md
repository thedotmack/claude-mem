# Claude-Mem Public Documentation

## What This Folder Is

This `docs/public/` folder contains the **Mintlify documentation site** - the official user-facing documentation for claude-mem. It's a structured documentation platform with a specific file format and organization.

## Folder Structure

```
docs/
├── public/          ← You are here (Mintlify MDX files)
│   ├── *.mdx       - User-facing documentation pages
│   ├── docs.json   - Mintlify configuration and navigation
│   ├── architecture/ - Technical architecture docs
│   ├── usage/      - User guides and workflows
│   └── *.webp, *.gif - Assets (logos, screenshots)
└── context/        ← Internal documentation (DO NOT put here)
    └── *.md        - Planning docs, audits, references
```

## File Requirements

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

**Planning documents, design docs, and reference materials go in `/docs/context/` instead:**

Files that belong in `/docs/context/` (NOT here):
- Planning documents (`*-plan.md`, `*-outline.md`)
- Implementation analysis (`*-audit.md`, `*-code-reference.md`)
- Error tracking (`typescript-errors.md`)
- Internal design documents
- PR review responses
- Reference materials (like `agent-sdk-ref.md`)
- Work-in-progress documentation

## How to Add Official Documentation

1. Create a new `.mdx` file in the appropriate subdirectory
2. Add the file path to `docs.json` navigation
3. Use Mintlify's frontmatter and components
4. Follow the existing documentation style
5. Test locally: `npx mintlify dev`

## Development Workflow

**For contributors working on claude-mem:**
- Read `/CLAUDE.md` in the project root for development instructions
- Place planning/design docs in `/docs/context/`
- Only add user-facing documentation to `/docs/public/`
- Test documentation locally with Mintlify CLI before committing

## Testing Documentation

```bash
# Validate docs structure
npx mintlify validate

# Check for broken links
npx mintlify broken-links

# Run local dev server
npx mintlify dev
```

## Summary

**Simple Rule**:
- `/docs/public/` = Official user documentation (Mintlify .mdx files) ← YOU ARE HERE
- `/docs/context/` = Internal docs, plans, references, audits