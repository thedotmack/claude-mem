# AGENTS.md

Context file for AI agents working on claude-mem.

**Dual Format**: This file combines Category A (Operations Manual) and Category B (Context Guide) for comprehensive agent guidance.

## Project Overview

claude-mem is a Typescript project using npm/Node.js.

**Key Info:**
- **Primary Language:** Typescript
- **Build System:** npm/Node.js
- **Test Framework:** Jest
- **Total Files:** 1912
- **Test Files:** 763
- **AI Readiness Score:** 84/100 (AI-Native-Plus)

---



## 🏗️ Architecture & Context Guide

This section provides architectural context and agent-understanding for the codebase.

### Prerequisites

- **Typescript:** 16+ (or applicable language version)
- **Package Manager:** npm or yarn
- **Test Runner:** Jest



### Project Structure

```
claude-mem/
├── package.json
├── package.json
├── package.json
├── src/                  # Source code
├── tests/                # Test suite (763 files)
└── README.md             # Project documentation
```

### Architecture Overview

#### Key Components
- **Main Entry:** Standard layout
- **Test Suite:** 763 test files
- **Build Configuration:** package.json, package.json, package.json

#### Design Principles

1. **Modularity** - Code organized by functionality with clear separation of concerns
2. **Testability** - Comprehensive test coverage across critical paths
3. **Clarity** - Explicit naming and structure for AI agent understanding
4. **Consistency** - Uniform patterns and conventions throughout codebase
5. **Maintainability** - Well-documented code with clear intent

### Directory Map

| Directory | Purpose |
|-----------|----------|
| `docs/` | Documentation |
| `scripts/` | Build and utility scripts |
| `src/` | Source code |
| `tests/` | Test suite |


### Development Workflow

#### Initial Setup

```bash
git clone https://github.com/YOUR_ORG/claude-mem.git
cd claude-mem
npm install
# or
yarn install
```

#### Development Commands

**Running Tests:**
```bash
npm test                  # Run all tests
npm run test -- --watch   # Watch mode
npm run lint              # Lint code
```

#### Code Quality
```bash
npm run format            # Format code (prettier)
npm run lint -- --fix     # Auto-fix lint issues
```

### Code Style & Conventions

- **Naming:** Use Typescript conventions (snake_case for functions, PascalCase for classes)
- **Type Hints:** Yes (strongly encouraged)
- **Error Handling:** Yes - handle errors at boundaries; let exceptions propagate when another layer owns recovery
- **Logging:** Yes
- **Testing:** Yes - write tests alongside code changes

### Testing Strategy

**Framework:** Jest
**Test Files:** 763 found

Before committing:
1. Run the full test suite: `npm test` or `yarn test`
2. Run linter: `npm run lint` or `yarn lint`
3. Format code: `npm run format` or `yarn format`
4. Type check (if TypeScript): `npm run type-check`

### Writing Documentation

When updating docs:
1. Always include explanatory text before code snippets
2. Describe *why* and *what* before showing *how*
3. Keep sections focused on a single concept
4. Use clear, concrete examples

### Contributing Guidelines

This project doesn't have a separate CONTRIBUTING.md yet. When contributing:
1. Review recent merged PRs to understand maintainer preferences
2. Follow the patterns established in the codebase
3. Ensure your contribution aligns with the project's design principles above

### Common Patterns

When contributing to this project:
1. Read existing code in the area you're modifying
2. Follow the established patterns and style
3. Write tests for new functionality
4. Use clear, descriptive variable and function names
5. Add docstrings for public APIs
6. Update tests when changing behavior

### What We Value

✅ Well-tested code with clear intent
✅ Consistent code style and naming conventions
✅ Code that is easy for AI agents to understand
✅ Clear, descriptive commit messages
✅ Modular, reusable components
✅ Comprehensive documentation

### What We Avoid

❌ Large functions doing multiple things
❌ Commented-out dead code
❌ Inconsistent naming or patterns
❌ Unclear error messages
❌ Unexplained magic numbers or strings
❌ Skipped tests or test TODOs

### AI Readiness Dimensions (Scoring)

This project is evaluated across 8 dimensions:

1. **Architecture** (10/100) - Code organization and modularity
2. **Testing** (15/100) - Test coverage and quality
3. **Dependencies** (12/100) - Dependency management
4. **Conventions** (10/100) - Consistent patterns
5. **Entry Points** (4/100) - Clear main/start locations
6. **Security** (15/100) - Input validation and error handling
7. **Build** (10/100) - Clear build/setup instructions
8. **Documentation** (8/100) - Code and project documentation

### Next Steps

Before making changes:
1. Read relevant source files to understand the existing code
2. Look at existing tests for similar functionality
3. Follow the patterns you see in the codebase
4. Write tests for your changes
5. Run `pytest` to verify nothing breaks
6. Run code quality checks: `ruff check . && mypy .`
7. Format your code: `ruff format .`

---

*Generated by Braxis - keeping AI agents in sync with your code*
