# Smart Explore: How It Works

Technical reference for the smart-explore feature in claude-mem. This document covers the full stack: the user-facing skill, the MCP tool layer, the tree-sitter CLI parser, the search engine, and the build pipeline that connects them.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [The Skill Layer](#the-skill-layer)
4. [The MCP Tool Layer](#the-mcp-tool-layer)
5. [The Parser](#the-parser)
6. [The Search Engine](#the-search-engine)
7. [Build System Integration](#build-system-integration)
8. [Data Flow: End to End](#data-flow-end-to-end)
9. [Supported Languages](#supported-languages)
10. [Token Economics](#token-economics)
11. [File Index](#file-index)

---

## Overview

Smart-explore is a code exploration system that uses tree-sitter AST parsing to provide token-efficient structural views of source code. Instead of reading entire files (which costs thousands of tokens), it extracts function signatures, class hierarchies, import lists, and documentation strings -- then lets the user "unfold" specific symbols to see their full implementation.

The system is built on a 3-layer progressive disclosure workflow:

1. **Search** -- discover files and symbols across a directory tree
2. **Outline** -- get the structural skeleton of a single file
3. **Unfold** -- extract the full source code of one specific symbol

This replaces the traditional Glob-then-Grep-then-Read discovery cycle with a single tool call that returns ranked, structured results at a fraction of the token cost.

---

## Architecture

```
User (Claude Code session)
    |
    v
SKILL.md (plugin/skills/smart-explore/SKILL.md)
    |  Loaded into context when user invokes /smart-explore
    |  Contains workflow instructions, tool parameters, examples
    |
    v
MCP Server (src/servers/mcp-server.ts)
    |  Registers 3 tools: smart_search, smart_outline, smart_unfold
    |  Tools execute DIRECTLY in the MCP server process (no HTTP delegation)
    |
    +---> smart_search --> search.ts --> parser.ts --> tree-sitter CLI
    +---> smart_outline --> parser.ts --> tree-sitter CLI
    +---> smart_unfold --> parser.ts --> tree-sitter CLI
    |
    v
tree-sitter CLI binary (from tree-sitter-cli npm package)
    |  Shells out via execSync
    |  Grammar files resolved from tree-sitter-{lang} npm packages
    |
    v
Source code files on disk
```

Key architectural decisions:

- **Direct execution, not HTTP delegation.** Unlike the memory tools (search, timeline, get_observations) which proxy to the Worker HTTP API at localhost:37777, the smart_* tools call parser/search functions directly. There is no database, no state, and no reason for the HTTP round-trip.

- **CLI-based, not WASM or native bindings.** The parser shells out to the `tree-sitter` CLI binary via `execSync`. Grammar packages are resolved at runtime via `require.resolve()`. No compilation step, no WASM loading, no native Node.js addon building.

- **Batch processing.** When searching a directory, files are grouped by language and parsed in a single CLI invocation per language group, rather than one process per file.

---

## The Skill Layer

**File:** `/Users/alexnewman/Scripts/claude-mem/.claude/worktrees/musing-sammet/plugin/skills/smart-explore/SKILL.md`

The skill is a markdown file with YAML frontmatter that Claude Code loads into context when the user invokes `/smart-explore`. It does not contain any executable code. Its purpose is to:

1. Override the LLM's default code exploration behavior (Read, Grep, Glob)
2. Teach the 3-layer workflow: search -> outline -> unfold
3. Document all tool parameters
4. Provide concrete examples with expected token costs
5. Specify when standard tools should be used instead

The frontmatter:

```yaml
name: smart-explore
description: Token-optimized structural code search using tree-sitter AST parsing.
```

The skill instructs the LLM to use `smart_search` as the primary discovery tool (replacing Glob + Grep), `smart_outline` for file structure (replacing Read on large files), and `smart_unfold` for targeted code extraction (replacing Read with offset).

---

## The MCP Tool Layer

**File:** `/Users/alexnewman/Scripts/claude-mem/.claude/worktrees/musing-sammet/src/servers/mcp-server.ts`

Three tools are registered in the MCP server's `tools` array alongside the existing memory tools. Each tool definition includes a name, description, JSON Schema input definition, and an async handler function.

### smart_search

Searches a directory tree for symbols matching a query. Returns ranked symbol matches plus folded file views.

```typescript
// Parameters:
//   query (string, required) -- search term
//   path (string, optional) -- root directory, defaults to cwd
//   max_results (number, optional) -- default 20
//   file_pattern (string, optional) -- filter files by path substring

// Handler logic:
const rootDir = resolve(args.path || process.cwd());
const result = await searchCodebase(rootDir, args.query, {
  maxResults: args.max_results || 20,
  filePattern: args.file_pattern
});
const formatted = formatSearchResults(result, args.query);
```

### smart_outline

Parses a single file and returns its structural skeleton -- all symbols with signatures, but bodies folded away.

```typescript
// Parameters:
//   file_path (string, required) -- path to the source file

// Handler logic:
const filePath = resolve(args.file_path);
const content = await readFile(filePath, 'utf-8');
const parsed = parseFile(content, filePath);
return formatFoldedView(parsed);
```

### smart_unfold

Extracts the full source code of a specific named symbol from a file.

```typescript
// Parameters:
//   file_path (string, required) -- path to the source file
//   symbol_name (string, required) -- name of the symbol to extract

// Handler logic:
const filePath = resolve(args.file_path);
const content = await readFile(filePath, 'utf-8');
const unfolded = unfoldSymbol(content, filePath, args.symbol_name);
```

If the symbol is not found, the handler falls back to parsing the file and listing all available symbol names so the user can pick the correct one.

---

## The Parser

**File:** `/Users/alexnewman/Scripts/claude-mem/.claude/worktrees/musing-sammet/src/services/smart-file-read/parser.ts`

This is the core of the system -- 668 lines of TypeScript that extract structural information from source code using the tree-sitter CLI.

### How Parsing Works

1. **Language detection** -- file extension is mapped to a language name via `LANG_MAP`. Supported extensions include `.ts`, `.js`, `.py`, `.go`, `.rs`, `.rb`, `.java`, `.c`, `.cpp`, and variants.

2. **Grammar resolution** -- the language name is mapped to a tree-sitter grammar package name (e.g., `typescript` -> `tree-sitter-typescript/typescript`). The grammar path is resolved at runtime using `require.resolve()` to find the grammar's `package.json`, then taking its directory.

3. **Query pattern selection** -- each language family has a tree-sitter query pattern (written in S-expression syntax) that captures structural elements. For example, the JS/TS query captures:
   - `function_declaration` nodes (functions)
   - `lexical_declaration` with arrow functions (const functions)
   - `class_declaration` nodes
   - `method_definition` nodes
   - `interface_declaration` and `type_alias_declaration` nodes
   - `enum_declaration` nodes
   - `import_statement` and `export_statement` nodes

4. **CLI execution** -- the query pattern is written to a temp file, then `tree-sitter query` is called via `execSync` with the grammar path, query file, and source file(s) as arguments. The CLI outputs match results in a structured text format.

5. **Output parsing** -- the CLI output is parsed line by line. Each match contains captures with tag names, start/end positions, and text content. The parser reconstructs this into `RawMatch` objects.

6. **Symbol building** -- raw matches are converted into `CodeSymbol` objects with:
   - `name` -- the symbol's identifier
   - `kind` -- function, class, method, interface, type, enum, struct, trait, impl, etc.
   - `signature` -- the first line (or up to the opening brace) of the declaration
   - `jsdoc` -- any comment block above the symbol (JSDoc, `///`, `#`, Python docstrings)
   - `lineStart` / `lineEnd` -- position in the file
   - `exported` -- whether the symbol is publicly accessible (language-specific logic)
   - `children` -- for container kinds (class, struct, impl, trait), nested symbols are attached as children

7. **Nesting** -- methods found inside class/struct/impl/trait ranges are automatically nested under their parent container and their kind is changed from `function` to `method`.

### Key Types

```typescript
interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "method" | "interface" | "type" | "const"
      | "variable" | "export" | "struct" | "enum" | "trait" | "impl"
      | "property" | "getter" | "setter";
  signature: string;
  jsdoc?: string;
  lineStart: number;
  lineEnd: number;
  parent?: string;
  exported: boolean;
  children?: CodeSymbol[];
}

interface FoldedFile {
  filePath: string;
  language: string;
  symbols: CodeSymbol[];
  imports: string[];
  totalLines: number;
  foldedTokenEstimate: number;
}
```

### Batch Parsing

The `parseFilesBatch()` function groups files by language and runs one `tree-sitter query` CLI call per language group. For a codebase with 192 files across 3 languages, this means 3 process spawns instead of 192. The function signature:

```typescript
function parseFilesBatch(
  files: Array<{ absolutePath: string; relativePath: string; content: string }>
): Map<string, FoldedFile>
```

### Formatting

`formatFoldedView()` converts a `FoldedFile` into a human/LLM-readable text representation:

```
[file-icon] path/to/file.ts (typescript, 450 lines)

  [package-icon] Imports: 8 statements
    import { Server } from '@modelcontextprotocol/sdk/server/index.js'
    import { readFile } from 'node:fs/promises'
    ...

  f MyFunction [exported] (L12-L45)
    export function MyFunction(param: string): boolean
    [comment-icon] Performs the main operation

  [diamond] MyClass [exported] (L50-L200)
    f constructor (L52-L60)
    f processData (L62-L100)
    f cleanup (L102-L120)
```

### Symbol Unfolding

`unfoldSymbol()` parses a file, finds the named symbol (recursing into children), then extracts the full source code from `lineStart` to `lineEnd`, including any preceding comments, decorators, or JSDoc blocks:

```typescript
function unfoldSymbol(content: string, filePath: string, symbolName: string): string | null
```

The output is prefixed with a location marker: `// [pin-icon] path/to/file.ts L12-L45`.

### Export Detection

Export status is detected differently per language:
- **JS/TS** -- checks if the symbol's line range falls within an `export_statement` capture
- **Python** -- symbols starting with `_` are considered private
- **Go** -- symbols starting with an uppercase letter are exported
- **Rust** -- symbols starting with `pub` keyword are exported
- **Others** -- default to exported

### Comment Extraction

The parser looks backward from each symbol's start line to find:
- JSDoc blocks (`/** ... */`)
- Single-line comments (`//`, `///`, `//!`)
- Python decorators (`@`)
- Hash comments (`#`)
- Python docstrings (`"""`, `'''`)

---

## The Search Engine

**File:** `/Users/alexnewman/Scripts/claude-mem/.claude/worktrees/musing-sammet/src/services/smart-file-read/search.ts`

The search module orchestrates file discovery, batch parsing, and fuzzy symbol matching.

### Three-Phase Search Pipeline

**Phase 1: File Collection**

Recursively walks the target directory using an async generator (`walkDir`). Applies filtering:
- Skips hidden directories (starting with `.`)
- Skips common non-source directories: `node_modules`, `.git`, `dist`, `build`, `__pycache__`, `vendor`, etc.
- Includes only files with recognized code extensions (18 extensions across 14+ languages)
- Skips files larger than 512KB or files detected as binary (null bytes in first 1000 chars)
- Optionally filters by `filePattern` (case-insensitive substring match against relative path)

**Phase 2: Batch Parsing**

Passes all collected files to `parseFilesBatch()`, which groups them by language and runs one tree-sitter CLI call per language. Returns a `Map<string, FoldedFile>` keyed by relative path.

**Phase 3: Symbol Matching**

For each parsed file, scores every symbol against the query using a multi-signal ranking system:

```typescript
// Query is split into parts on whitespace, underscores, hyphens, dots, slashes
const queryParts = queryLower.split(/[\s_\-./]+/)

// Scoring per query part:
//   Exact match:     10 points
//   Substring match:  5 points
//   Fuzzy match:      1 point (all chars appear in order)

// Score multipliers:
//   Symbol name match:     score * 3
//   Signature match:       +2
//   JSDoc/docstring match: +1
//   File path match:       triggers file inclusion in results
```

Results are sorted by total score, trimmed to `maxResults`, and only files containing matching symbols are included in the folded views.

### Output Format

`formatSearchResults()` produces LLM-optimized output with two sections:

1. **Matching Symbols** -- compact list with kind, qualified name (e.g., `ClassName.methodName`), file path, line number, signature, and first line of JSDoc
2. **Folded File Views** -- structural outline of each file containing matches (reuses `formatFoldedView()` from parser)

The output ends with an "Actions" section pointing the user to `smart_unfold`.

---

## Build System Integration

**File:** `/Users/alexnewman/Scripts/claude-mem/.claude/worktrees/musing-sammet/scripts/build-hooks.js`

### esbuild Configuration

The MCP server is built with esbuild targeting CJS format for Node.js 18. Tree-sitter packages are externalized (not bundled) because the parser resolves grammar paths at runtime via `require.resolve()`:

```javascript
external: [
  'bun:sqlite',
  'tree-sitter-cli',
  'tree-sitter-javascript',
  'tree-sitter-typescript',
  'tree-sitter-python',
  'tree-sitter-go',
  'tree-sitter-rust',
  'tree-sitter-ruby',
  'tree-sitter-java',
  'tree-sitter-c',
  'tree-sitter-cpp',
],
```

### Runtime Dependencies

The build script generates `plugin/package.json` with tree-sitter packages as dependencies. These are installed at runtime via `smart-install.js` (which runs during `SessionStart`):

```json
{
  "dependencies": {
    "tree-sitter-cli": "^0.26.5",
    "tree-sitter-c": "^0.24.1",
    "tree-sitter-cpp": "^0.23.4",
    "tree-sitter-go": "^0.25.0",
    "tree-sitter-java": "^0.23.5",
    "tree-sitter-javascript": "^0.25.0",
    "tree-sitter-python": "^0.25.0",
    "tree-sitter-ruby": "^0.23.1",
    "tree-sitter-rust": "^0.24.0",
    "tree-sitter-typescript": "^0.23.2"
  }
}
```

The `tree-sitter-cli` package ships a pre-built native binary for each platform. Grammar packages contain compiled `.so`/`.dylib`/`.node` grammar files. No compilation happens at install time.

### Distribution Verification

The build script verifies that `plugin/skills/smart-explore/SKILL.md` exists as a required distribution file. Skills are source files (markdown), not build outputs.

---

## Data Flow: End to End

### smart_search("shutdown", path="./src")

```
1. MCP server receives tool call
2. Handler resolves path to absolute directory
3. searchCodebase() is called:
   a. walkDir() yields ~192 source files from ./src
   b. safeReadFile() reads each file (skipping >512KB, binary)
   c. Files grouped by language: {typescript: [...], javascript: [...]}
   d. parseFilesBatch() runs:
      - For typescript files: one `tree-sitter query` call with jsts query pattern
      - For javascript files: one `tree-sitter query` call with jsts query pattern
      - Each call returns matches grouped by file
   e. buildSymbols() converts matches into CodeSymbol arrays per file
   f. matchScore() scores each symbol against ["shutdown"]:
      - "performGracefulShutdown" -> name contains "shutdown" -> 5 * 3 = 15
      - "WorkerService.shutdown" -> exact name match -> 10 * 3 = 30
   g. Results sorted by score, trimmed to max_results
4. formatSearchResults() produces text output:
   - Matching Symbols section (ranked list)
   - Folded File Views section (structural outlines)
5. MCP response sent back to Claude Code
```

### smart_outline("services/worker-service.ts")

```
1. MCP server receives tool call
2. Handler resolves file path, reads content
3. parseFile() is called:
   a. detectLanguage() -> "typescript"
   b. resolveGrammarPath() -> node_modules/tree-sitter-typescript/typescript/
   c. Content written to temp file with .ts extension
   d. tree-sitter CLI query run against temp file
   e. buildSymbols() extracts ~36 symbols (12 top-level, 24 class members)
4. formatFoldedView() produces structural outline (~1,500 tokens)
5. Temp file cleaned up
6. MCP response sent back
```

### smart_unfold("services/worker-service.ts", "shutdown")

```
1. MCP server receives tool call
2. Handler resolves file path, reads content
3. unfoldSymbol() is called:
   a. parseFile() runs full AST parse
   b. findSymbol() recursively searches symbol tree for "shutdown"
   c. Found at lineStart=845, lineEnd=870
   d. Walks backward from line 845 to include JSDoc block (lines 838-844)
   e. Extracts lines 838-870 from source
4. Returns prefixed source: "// [pin] services/worker-service.ts L839-871\n..."
5. MCP response sent back (~200-2,000 tokens depending on symbol size)
```

---

## Supported Languages

| Language | Extension(s) | Grammar Package | Query Pattern |
|----------|-------------|----------------|---------------|
| JavaScript | .js, .mjs, .cjs | tree-sitter-javascript | jsts |
| TypeScript | .ts | tree-sitter-typescript/typescript | jsts |
| TSX | .tsx | tree-sitter-typescript/tsx | jsts |
| JSX | .jsx | tree-sitter-typescript/tsx | jsts |
| Python | .py, .pyw | tree-sitter-python | python |
| Go | .go | tree-sitter-go | go |
| Rust | .rs | tree-sitter-rust | rust |
| Ruby | .rb | tree-sitter-ruby | ruby |
| Java | .java | tree-sitter-java | java |
| C | .c, .h | tree-sitter-c | generic |
| C++ | .cpp, .cc, .cxx, .hpp, .hh | tree-sitter-cpp | generic |

Languages without dedicated query patterns (C, C++) fall back to a `generic` pattern that captures basic function declarations, class definitions, and imports.

The search module's `CODE_EXTENSIONS` set also includes `.cs`, `.swift`, `.kt`, `.php`, `.vue`, and `.svelte` for file discovery, but these lack grammar packages and will produce empty parse results (file structure won't be extracted, but files will still appear in path-based matches).

---

## Token Economics

Measured against the claude-mem codebase (~192 source files, largest file 1,225 lines):

| Approach | Tokens | Use Case |
|----------|--------|----------|
| smart_outline (single file) | ~1,500 | "What's in this file?" |
| smart_unfold (single symbol) | ~1,600 | "Show me this function" |
| smart_search (directory) | ~2,000-6,000 | "How does X work?" |
| Read (full large file) | ~12,000+ | When you need everything |
| Explore agent (multi-round) | ~20,000-40,000 | Same as smart_search, 6-12x more expensive |

The outline+unfold pattern for understanding a specific function in a large file costs approximately 3,100 tokens versus 12,000+ tokens for reading the entire file -- an 8x reduction.

---

## File Index

All files that make up the smart-explore system:

| File | Role |
|------|------|
| `plugin/skills/smart-explore/SKILL.md` | Skill definition (workflow instructions for the LLM) |
| `src/services/smart-file-read/parser.ts` | Tree-sitter CLI parser (AST extraction, folding, unfolding) |
| `src/services/smart-file-read/search.ts` | Directory walker, batch parsing, fuzzy matching |
| `src/servers/mcp-server.ts` | MCP tool registration (smart_search, smart_outline, smart_unfold) |
| `scripts/build-hooks.js` | Build configuration (esbuild externals, plugin package.json) |
| `plugin/scripts/mcp-server.cjs` | Built output (bundled MCP server) |
| `.plan/smart-file-read.md` | Integration plan (5-phase implementation guide) |
| `smart-file-read/index.ts` | Prototype standalone MCP server (reference implementation) |
| `smart-file-read/search.ts` | Prototype search module (original before integration) |
| `smart-file-read/test-run.mjs` | Prototype test runner |
| `smart-file-read/PRELIMINARY-RESULTS.md` | Test results and skill design |
| `smart-file-read/TEST-METHODOLOGY.md` | Test plan documentation |

All paths are relative to the project root:
`/Users/alexnewman/Scripts/claude-mem/.claude/worktrees/musing-sammet/`
