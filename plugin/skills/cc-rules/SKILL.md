---
name: cc-rules
description: Guide for creating and organizing Claude Code rules (.claude/rules/ and ~/.claude/rules/). Use when users ask "how do I add rules?", "how do path-specific rules work?", "how do I organize project instructions?", or need help setting up modular rule files at user or project level.
disable-model-invocation: true
argument-hint: [topic or description of rules to create]
---

# Claude Code Rules Creator

Create and organize modular rule files for Claude Code. Rules let you split a large CLAUDE.md into focused, topic-specific files that load automatically.

## Workflow

### Step 1: Choose the Scope

| Scope | Path | Loaded | Shared With |
|-------|------|--------|-------------|
| **User rules** | `~/.claude/rules/*.md` | All projects, loaded first (lower priority) | Only you |
| **Project rules** | `.claude/rules/*.md` | This project, loaded after user rules (higher priority) | Team via version control |

**User rules** = personal preferences across all projects (your coding style, preferred patterns).
**Project rules** = team standards for this codebase (API conventions, test requirements, security).

Project rules take priority over user rules when they conflict.

### Step 2: Choose Between Unconditional and Path-Specific

**Unconditional rules** (no frontmatter) load for EVERY file Claude works with:

```markdown
# Testing Standards

- Every public function must have unit tests
- Use describe/it pattern for test organization
- Mock external services, never call real APIs in tests
- Aim for 80% code coverage minimum
```

**Path-specific rules** (with `paths:` frontmatter) load ONLY when Claude works with matching files:

```markdown
---
paths: src/api/**/*.ts
---

# API Development Rules

- All endpoints must include input validation
- Use the standard error response format
- Include OpenAPI documentation comments
- Require authentication on all endpoints
```

**When to use path-specific rules:**
- Rules that only make sense for certain file types (e.g., React rules for `.tsx` files)
- Different standards for different parts of the codebase (frontend vs backend)
- Reducing noise: don't load API rules when working on CSS

### Step 3: Create the Rule File

Generate a `.md` file in the appropriate rules directory.

**File naming:** Use descriptive names that indicate what the rules cover.
- `code-style.md` (good)
- `rules1.md` (bad)
- `frontend/react.md` (good - organized in subdirectory)

### Step 4: Organize with Subdirectories (if needed)

For larger projects, group related rules:

```
.claude/rules/
  frontend/
    react.md          # React component patterns
    styles.md         # CSS/styling conventions
  backend/
    api.md            # API endpoint rules
    database.md       # Database query patterns
  testing.md          # Cross-cutting test standards
  security.md         # Security requirements
  general.md          # General coding standards
```

All `.md` files are discovered recursively from `.claude/rules/`.

## Glob Pattern Reference for `paths:`

| Pattern | Matches |
|---------|---------|
| `**/*.ts` | All TypeScript files in any directory |
| `src/**/*` | All files under `src/` |
| `*.md` | Markdown files in project root only |
| `src/components/*.tsx` | React components in specific directory |
| `src/**/*.{ts,tsx}` | Both `.ts` and `.tsx` files under `src/` |
| `{src,lib}/**/*.ts` | TypeScript files in either `src/` or `lib/` |
| `tests/**/*.test.ts` | Test files matching naming pattern |

Multiple patterns can be combined with commas:

```yaml
---
paths: src/**/*.ts, lib/**/*.ts, tests/**/*.test.ts
---
```

## Common Rule Templates

### Code Style (unconditional)

```markdown
# Code Style

- Use 2-space indentation
- Prefer const over let; avoid var
- Use meaningful variable names (no single letters except in loops)
- Maximum line length: 100 characters
- Use early returns to reduce nesting
```

### TypeScript Rules (path-specific)

```markdown
---
paths: **/*.{ts,tsx}
---

# TypeScript Rules

- Always add explicit return types to exported functions
- Use interface over type for object shapes
- Prefer unknown over any
- Use discriminated unions for state management
- Enable strict mode in tsconfig.json
```

### React Component Rules (path-specific)

```markdown
---
paths: src/components/**/*.tsx
---

# React Component Rules

- Use functional components with hooks
- Extract custom hooks for reusable logic
- Props interfaces named ComponentNameProps
- Use React.memo only when measured performance benefit
- Colocate styles with components
```

### API Rules (path-specific)

```markdown
---
paths: src/api/**/*.ts
---

# API Development

- RESTful naming: plural nouns for resources
- Standard error format: { error: { code, message, details } }
- Validate all input with Zod schemas
- Return appropriate HTTP status codes
- Document with OpenAPI/JSDoc comments
```

### Test Rules (path-specific)

```markdown
---
paths: **/*.test.{ts,tsx,js,jsx}, **/*.spec.{ts,tsx,js,jsx}
---

# Testing Standards

- Use describe blocks for grouping, it blocks for individual tests
- Test behavior, not implementation details
- One assertion per test when possible
- Mock external dependencies
- Use factories for test data, not raw literals
```

### Security Rules (unconditional)

```markdown
# Security

- NEVER commit secrets, API keys, or credentials
- Validate and sanitize all user input
- Use parameterized queries for database access
- Apply principle of least privilege
- Log security-relevant events
```

## Sharing Rules Across Projects with Symlinks

```bash
# Symlink a shared rules directory
ln -s ~/shared-claude-rules .claude/rules/shared

# Symlink individual rule files
ln -s ~/company-standards/security.md .claude/rules/security.md
```

Symlinks are resolved normally. Circular symlinks are detected and handled.

## User-Level Rules (`~/.claude/rules/`)

Personal rules that apply to every project you work on:

```
~/.claude/rules/
  preferences.md    # Your coding style preferences
  workflows.md      # Your preferred workflows
  git.md            # Your git conventions
```

**Good candidates for user rules:**
- Personal code style preferences
- Preferred testing patterns
- Git commit message format
- Language-specific conventions you always follow

**Bad candidates for user rules (use project rules instead):**
- Project-specific architecture decisions
- Team coding standards
- Build/deploy commands

## Best Practices

- **Keep rules focused**: One topic per file
- **Use descriptive filenames**: `testing.md` not `rules2.md`
- **Use path-specific rules sparingly**: Only when rules genuinely apply to specific files
- **Organize with subdirectories**: Group related rules (`frontend/`, `backend/`)
- **Review periodically**: Update as your project evolves
- **Don't duplicate**: If it's in CLAUDE.md, don't repeat it in rules
