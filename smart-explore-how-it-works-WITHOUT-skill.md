# Smart Explore: How It Works

A technical walkthrough of the smart-explore feature in claude-mem. This document covers every layer -- from the tree-sitter CLI invocations at the bottom, through the parser and search modules, up to the MCP tool registration and the skill definition that teaches Claude how to use the tools.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture Diagram](#architecture-diagram)
3. [The Parser Layer](#the-parser-layer)
4. [The Search Layer](#the-search-layer)
5. [MCP Tool Registration](#mcp-tool-registration)
6. [The Skill Layer](#the-skill-layer)
7. [Build System Integration](#build-system-integration)
8. [Data Flow: End to End](#data-flow-end-to-end)
9. [Token Economics](#token-economics)
10. [File Inventory](#file-inventory)

---

## Overview

Smart-explore is a token-optimized code exploration system that replaces brute-force file reading with structural, AST-based views. It uses tree-sitter (via the CLI binary, not WASM or native Node.js bindings) to parse source code into an Abstract Syntax Tree, then extracts symbols (functions, classes, methods, types, imports) and presents them as compact "folded" views.

The system exposes three MCP tools: `smart_search`, `smart_outline`, and `smart_unfold`. These tools are orchestrated by a skill definition (`smart-explore`) that teaches Claude a 3-layer progressive disclosure workflow: search, then outline, then unfold.

**Key design decisions:**

- **CLI-only tree-sitter**: No native Node.js bindings, no WASM. The `tree-sitter-cli` npm package provides a pre-built binary. Grammar packages provide language definition files. The parser shells out via `execSync`.
- **Direct execution in the MCP server**: Unlike the memory tools (search, timeline, get_observations) which delegate to the Worker HTTP API at localhost:37777, the smart_* tools execute directly inside the MCP server process. The rationale: these are stateless, read-only file operations with no database dependency and sub-second response times. HTTP round-trips would add latency for no benefit.
- **Batch processing**: When searching across many files, the system groups files by language and makes one CLI call per language instead of one per file.

---

## Architecture Diagram

```
User (Claude Code session)
    |
    v
SKILL: plugin/skills/smart-explore/SKILL.md
    |  (teaches Claude the 3-layer workflow)
    v
MCP SERVER: src/servers/mcp-server.ts
    |  (registers smart_search, smart_outline, smart_unfold as MCP tools)
    |  (handlers call parser/search functions directly -- no HTTP)
    v
+---------------------------------------------+
|  SEARCH MODULE: src/services/smart-file-read/search.ts  |
|  - walkDir(): recursive directory traversal            |
|  - searchCodebase(): 3-phase search pipeline           |
|  - matchScore(): relevance ranking                     |
|  - formatSearchResults(): LLM-friendly output          |
+---------------------------------------------+
    |
    v
+---------------------------------------------+
|  PARSER MODULE: src/services/smart-file-read/parser.ts  |
|  - parseFile(): single-file AST extraction             |
|  - parseFilesBatch(): multi-file batch parsing         |
|  - formatFoldedView(): structural summary              |
|  - unfoldSymbol(): targeted source extraction          |
+---------------------------------------------+
    |
    v  (execSync)
+---------------------------------------------+
|  tree-sitter CLI binary                              |
|  + Language grammar packages (TS, JS, Python, etc.)  |
|  Installed at plugin runtime via bun install         |
+---------------------------------------------+
```

---

## The Parser Layer

**File:** `src/services/smart-file-read/parser.ts` (668 lines)

This is the core engine. It extracts structural information from source code using tree-sitter's query system.

### Language Support

The parser supports 9 languages via a file-extension-to-language mapping:

| Extensions | Language |
|-----------|----------|
| `.js`, `.mjs`, `.cjs` | javascript |
| `.jsx` | tsx |
| `.ts` | typescript |
| `.tsx` | tsx |
| `.py`, `.pyw` | python |
| `.go` | go |
| `.rs` | rust |
| `.rb` | ruby |
| `.java` | java |
| `.c`, `.h` | c |
| `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh` | cpp |

Each language maps to a grammar package (e.g., `tree-sitter-typescript`) which is resolved at runtime via `require.resolve()` to find its installation path.

### Tree-Sitter Query Patterns

The parser defines S-expression query patterns per language family. These are tree-sitter's query language for matching AST nodes. For example, the JavaScript/TypeScript query:

```scheme
(function_declaration name: (identifier) @name) @func
(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)])) @const_func
(class_declaration name: (type_identifier) @name) @cls
(method_definition name: (property_identifier) @name) @method
(interface_declaration name: (type_identifier) @name) @iface
(type_alias_declaration name: (type_identifier) @name) @tdef
(enum_declaration name: (identifier) @name) @enm
(import_statement) @imp
(export_statement) @exp
```

Each pattern captures two things: a `@name` tag (the symbol's identifier) and a structural tag like `@func`, `@cls`, `@method` (the whole node span). Similar patterns exist for Python, Go, Rust, Ruby, Java, and C/C++, plus a `generic` fallback.

### CLI Execution Pipeline

The parser writes query patterns to temporary `.scm` files (cached after first creation) and invokes tree-sitter:

```
tree-sitter query -p <grammar-path> <query-file> <source-file> [<source-file2> ...]
```

For single files (`parseFile`), the source content is written to a temp file with the correct extension for language detection. For batch operations (`parseFilesBatch`), the actual on-disk file paths are passed directly.

The CLI output is parsed line by line. The format includes:
- File headers (for multi-file queries)
- Pattern match indicators (`pattern: N`)
- Capture details with coordinates and optional text snippets

### Symbol Building

Raw CLI captures are transformed into `CodeSymbol` objects:

```typescript
interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "method" | "interface" | "type" | "const" | "variable" | "export" | "struct" | "enum" | "trait" | "impl" | "property" | "getter" | "setter";
  signature: string;
  jsdoc?: string;
  lineStart: number;
  lineEnd: number;
  parent?: string;
  exported: boolean;
  children?: CodeSymbol[];
}
```

The builder does several post-processing steps:

1. **Signature extraction**: Grabs the first line of a symbol up to the opening brace, collapsing multi-line signatures into a single line (max 200 chars).
2. **Comment detection**: Looks above each symbol for JSDoc (`/** ... */`), line comments (`//`), or Python docstrings (`"""..."""`).
3. **Export detection**: Language-specific -- checks for `export` wrapper ranges in JS/TS, leading underscore convention in Python, uppercase-first in Go, `pub` keyword in Rust.
4. **Nesting**: Methods found inside container kinds (class, struct, impl, trait) are reparented as `children` of their container. Functions inside containers are reclassified as methods.

### Key Exported Functions

| Function | Input | Output | Purpose |
|----------|-------|--------|---------|
| `parseFile(content, filePath)` | File content string + path | `FoldedFile` | Parse a single file into structured symbols |
| `parseFilesBatch(files)` | Array of `{absolutePath, relativePath, content}` | `Map<string, FoldedFile>` | Batch parse, one CLI call per language |
| `formatFoldedView(file)` | `FoldedFile` | String | Human/LLM-readable structural summary |
| `unfoldSymbol(content, filePath, symbolName)` | Content + path + symbol name | `string | null` | Extract full source of a specific symbol |
| `detectLanguage(filePath)` | File path | Language string | Extension-based language detection |

### The FoldedFile Structure

```typescript
interface FoldedFile {
  filePath: string;
  language: string;
  symbols: CodeSymbol[];
  imports: string[];
  totalLines: number;
  foldedTokenEstimate: number;
}
```

The `foldedTokenEstimate` is computed as `Math.ceil(formattedText.length / 4)` -- a rough character-to-token ratio.

### Unfold Behavior

`unfoldSymbol` re-parses the file, finds the named symbol (including recursive search into children), then extracts lines from `lineStart` to `lineEnd`. It walks backward from the symbol start to include preceding comments, decorators, and JSDoc blocks. The output includes a location header:

```
// <location marker> <filePath> L<start>-<end>
<extracted source code>
```

---

## The Search Layer

**File:** `src/services/smart-file-read/search.ts` (317 lines)

The search module orchestrates file discovery, batch parsing, and relevance-ranked symbol matching.

### File Discovery

`walkDir()` is an async generator that recursively traverses directories. It:

- Skips hidden directories (starting with `.`) and common ignore directories (`node_modules`, `.git`, `dist`, `build`, `__pycache__`, `target`, `vendor`, etc.)
- Only yields files with recognized code extensions (the same set of ~20 extensions)
- Respects a max depth of 20 levels
- Handles permission errors gracefully (returns without yielding)

`safeReadFile()` provides additional safety:
- Skips files larger than 512KB
- Skips empty files
- Performs a binary check (null bytes in first 1000 characters)

### The 3-Phase Search Pipeline

`searchCodebase(rootDir, query, options)` executes in three phases:

**Phase 1: Collect files**
- Walks the directory tree
- Applies optional `filePattern` filter (case-insensitive substring match on relative paths)
- Reads file contents via `safeReadFile`

**Phase 2: Batch parse**
- Calls `parseFilesBatch()` from the parser module
- Files are grouped by language; one tree-sitter CLI invocation per language group
- Returns a `Map<relativePath, FoldedFile>`

**Phase 3: Match query against symbols**
- Splits the query into parts on whitespace, underscores, hyphens, dots, and slashes
- Scores each symbol against query parts using `matchScore()`:
  - **Name match**: Score multiplied by 3 (highest weight)
  - **Signature match**: +2 for full query substring match in the signature
  - **JSDoc match**: +1 for full query substring match in documentation
  - **Path match**: Non-zero path score adds the file to results
- Symbols with score > 0 become `SymbolMatch` entries

### Relevance Scoring

`matchScore(text, queryParts)` uses three tiers:

| Tier | Condition | Score |
|------|-----------|-------|
| Exact match | `text === part` | 10 |
| Substring match | `text.includes(part)` | 5 |
| Fuzzy match | All chars of `part` appear in order in `text` | 1 |

Scores accumulate across all query parts. This means a query like "session processor" would score highly for a symbol named `SessionQueueProcessor` (substring matches on both "session" and "processor").

### Result Formatting

`formatSearchResults()` produces a structured text output designed for LLM consumption:

1. **Header**: Query, file count, symbol count, token estimate
2. **Matching Symbols section**: Compact list with kind, name, file path, line number, signature, and first line of JSDoc
3. **Folded File Views section**: Full structural outlines for files containing matches (via `formatFoldedView`)
4. **Actions section**: Hint to use `smart_unfold` for full implementations

Results are sorted by relevance score (descending) and trimmed to `maxResults` (default 20). Only files containing matched symbols are included in the folded views.

---

## MCP Tool Registration

**File:** `src/servers/mcp-server.ts` (lines 267-378)

The three smart_* tools are registered alongside the existing memory tools in the claude-mem MCP server. They use the same `{ name, description, inputSchema, handler }` pattern but differ in one critical way: they execute directly instead of delegating to the Worker HTTP API.

### smart_search

**Name**: `smart_search`
**Input Schema**: `query` (string, required), `path` (string, optional), `max_results` (number, optional), `file_pattern` (string, optional)

**Handler logic**:
1. Resolve `path` to an absolute directory (defaults to `process.cwd()`)
2. Call `searchCodebase(rootDir, query, { maxResults, filePattern })`
3. Format results with `formatSearchResults(result, query)`
4. Return as MCP text content

### smart_outline

**Name**: `smart_outline`
**Input Schema**: `file_path` (string, required)

**Handler logic**:
1. Resolve `file_path` to absolute
2. Read file content with `readFile(filePath, 'utf-8')`
3. Call `parseFile(content, filePath)`
4. If symbols found, return `formatFoldedView(parsed)`
5. If no symbols, return an error message about unsupported language

### smart_unfold

**Name**: `smart_unfold`
**Input Schema**: `file_path` (string, required), `symbol_name` (string, required)

**Handler logic**:
1. Resolve `file_path` to absolute
2. Read file content
3. Call `unfoldSymbol(content, filePath, symbolName)`
4. If found, return the extracted source
5. If not found, fall back to `parseFile()` and list all available symbols with their kinds, providing actionable feedback

---

## The Skill Layer

**File:** `plugin/skills/smart-explore/SKILL.md`

The skill file is a Markdown document with YAML frontmatter. It is auto-discovered from the `plugin/skills/` directory by Claude Code's plugin system. It does not contain executable code -- it contains instructions that teach Claude when and how to use the three MCP tools.

### Frontmatter

```yaml
name: smart-explore
description: Token-optimized structural code search using tree-sitter AST parsing. Use instead of reading full files when you need to understand code structure, find functions, or explore a codebase efficiently.
```

### 3-Layer Workflow

The skill defines a strict progressive disclosure pattern:

**Step 1: Search** -- Use `smart_search` to find relevant symbols across a codebase. Returns ranked symbols with signatures and folded file views.

**Step 2: Outline** -- Optionally use `smart_outline` for deeper structure of a specific file not covered by search results. Returns all symbols with signatures but without implementations.

**Step 3: Unfold** -- Use `smart_unfold` to see the full source code of only the specific symbols needed. Returns the complete implementation with JSDoc and decorators.

### When-to-Use Decision Matrix

The skill explicitly guides Claude on tool selection:

| Scenario | Use | Do Not Use |
|----------|-----|-----------|
| Cross-cutting exploration ("How does shutdown work?") | smart_search | -- |
| File structure understanding ("What's in worker-service.ts?") | smart_outline | -- |
| Targeted implementation ("Show me startSessionProcessor") | smart_unfold | -- |
| Exact name lookup ("where is ensureWorkerStarted defined?") | -- | Use Grep instead |
| String literal search ("find all TODO comments") | -- | Use Grep instead |
| Small files under ~100 lines | -- | Use Read instead |
| Non-code files (JSON, markdown, config) | -- | Use Read instead |

---

## Build System Integration

**File:** `scripts/build-hooks.js`

### Externals

The MCP server build uses esbuild with the tree-sitter packages externalized:

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

These must be externalized because `parser.ts` uses `require.resolve()` at runtime to locate grammar files on disk. Bundling them inline would break path resolution.

### Runtime Dependencies

The build script generates `plugin/package.json` with all tree-sitter packages as dependencies:

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

At plugin install time, `bun install` (via the plugin's `smart-install.js`) installs these into `plugin/node_modules/`. The `tree-sitter-cli` package includes a pre-built platform-specific binary. The grammar packages are needed only for their grammar definition files (not their native bindings).

### Distribution Verification

The build script verifies that `plugin/skills/smart-explore/SKILL.md` exists as a required distribution file before completing successfully.

---

## Data Flow: End to End

Here is what happens when Claude calls `smart_search(query="shutdown", path="./src")`:

1. **Claude Code** invokes the `smart_search` MCP tool via the stdio transport.
2. **MCP server** (`mcp-server.ts`) matches the tool name, calls the handler.
3. **Handler** resolves `./src` to an absolute path, calls `searchCodebase()`.
4. **Phase 1** (search.ts): `walkDir()` finds all code files under `./src`, `safeReadFile()` reads each one.
5. **Phase 2** (search.ts -> parser.ts): `parseFilesBatch()` groups files by language, then for each language group:
   a. Resolves the grammar path via `require.resolve("tree-sitter-<lang>/package.json")`
   b. Retrieves the cached query file (`.scm` with S-expression patterns)
   c. Calls `tree-sitter query -p <grammar> <query.scm> <file1> <file2> ...` via `execSync`
   d. Parses the CLI output into `RawMatch[]` per file
   e. Builds `CodeSymbol[]` and `FoldedFile` structures
6. **Phase 3** (search.ts): Matches "shutdown" against all extracted symbol names, signatures, and JSDoc. Scores and ranks results.
7. **Formatting** (search.ts): `formatSearchResults()` produces the text output with matching symbols and folded file views.
8. **Response**: The handler wraps the text in `{ content: [{ type: 'text', text: ... }] }` and returns it via MCP.
9. **Claude** reads the result, sees symbols like `performGracefulShutdown`, `httpShutdown`, `WorkerService.shutdown` across multiple files. If it needs to see an implementation, it calls `smart_unfold`.

---

## Token Economics

The core value proposition is token efficiency. Measured against the claude-mem codebase:

| Approach | Approximate Tokens | Use Case |
|----------|-------------------|----------|
| `smart_outline` | ~1,500 per file | "What's in this file?" |
| `smart_unfold` | ~1,600 per symbol | "Show me this function" |
| `smart_search` | ~2,000-6,000 | "How does X work?" (cross-cutting) |
| Read (full file) | ~12,000+ | When you truly need all source code |
| Explore agent (multi-round) | ~20,000-40,000 | Same info as smart_search, 6-12x more expensive |

**Concrete example**: Understanding `worker-service.ts` (1,225 lines):
- `smart_outline`: 1,466 tokens -- shows 12 top-level symbols, WorkerService class with 24 members
- `smart_unfold` on `startSessionProcessor`: 1,610 tokens -- just the method you need
- **Total**: ~3,076 tokens vs ~12,000 to Read the full file (4x savings)

**Cross-cutting search**: "shutdown" across the whole codebase:
- `smart_search`: 5,898 tokens -- 14 symbols across 7 files, ranked by relevance
- **Compared to** an Explore agent doing Grep -> Read -> Grep -> Read cycles: 20,000-40,000 tokens (6-12x savings)

---

## File Inventory

### Production Files (Source)

| File | Lines | Role |
|------|-------|------|
| `src/services/smart-file-read/parser.ts` | 668 | Core AST parser -- tree-sitter CLI, symbol extraction, formatting, unfold |
| `src/services/smart-file-read/search.ts` | 317 | Directory walker, batch parsing orchestration, relevance ranking, result formatting |
| `src/servers/mcp-server.ts` | 491 | MCP server -- registers smart_search, smart_outline, smart_unfold tools (lines 267-378) |
| `plugin/skills/smart-explore/SKILL.md` | 134 | Skill definition -- teaches Claude the 3-layer workflow |
| `scripts/build-hooks.js` | 216 | Build configuration -- esbuild externals, plugin package.json generation |

### Prototype / Reference Files (Not deployed)

| File | Role |
|------|------|
| `smart-file-read/parser.ts` | Original prototype parser (identical to production copy) |
| `smart-file-read/search.ts` | Original prototype search (identical to production copy) |
| `smart-file-read/index.ts` | Standalone MCP server prototype (used Zod schemas; production uses raw JSON Schema) |
| `smart-file-read/test-run.mjs` | Manual test runner for the prototype |
| `smart-file-read/package.json` | Prototype package with all dependencies |
| `smart-file-read/PRELIMINARY-RESULTS.md` | Test results and skill design document |
| `smart-file-read/TEST-METHODOLOGY.md` | Testing plan and methodology |

### Planning Files

| File | Role |
|------|------|
| `.plan/smart-file-read.md` | 5-phase integration plan (discovery, source integration, MCP registration, build, skill, testing) |
