# Smart Explore: How It Works

A technical document explaining the architecture, data flow, and implementation of the smart-explore feature in claude-mem.

---

## Overview

Smart-explore is a token-optimized code exploration system built into the claude-mem plugin. It uses tree-sitter AST (Abstract Syntax Tree) parsing to provide structural views of codebases, allowing Claude to understand code without reading full files. The system exposes three MCP tools -- `smart_search`, `smart_outline`, and `smart_unfold` -- orchestrated by a skill document that teaches Claude a progressive-disclosure workflow.

The core value proposition: **8x fewer tokens** for file understanding compared to reading full files, and **6-12x fewer tokens** compared to using an explore agent.

---

## Architecture

Smart-explore consists of four layers:

```
+------------------------------------------------------+
|  SKILL LAYER                                         |
|  plugin/skills/smart-explore/SKILL.md                |
|  Teaches Claude the 3-step workflow                  |
+------------------------------------------------------+
           |
           | references tools by name
           v
+------------------------------------------------------+
|  MCP TOOL LAYER                                      |
|  src/servers/mcp-server.ts                           |
|  3 tool definitions: smart_search, smart_outline,    |
|  smart_unfold -- executed directly (no HTTP)         |
+------------------------------------------------------+
           |
           | calls functions directly
           v
+------------------------------------------------------+
|  SERVICE LAYER                                       |
|  src/services/smart-file-read/search.ts              |
|  src/services/smart-file-read/parser.ts              |
|  Directory walking, batch parsing, symbol matching   |
+------------------------------------------------------+
           |
           | shells out via execSync
           v
+------------------------------------------------------+
|  TREE-SITTER CLI LAYER                               |
|  tree-sitter-cli binary + grammar packages           |
|  AST parsing via `tree-sitter query` command         |
+------------------------------------------------------+
```

### Key Design Decision: Direct Execution

Unlike other claude-mem MCP tools (e.g., `search`, `timeline`) which delegate to the Worker HTTP API at localhost:37777, the smart-explore tools execute directly in the MCP server process. The rationale:

- Smart-explore is read-only file I/O + AST parsing -- no database, no state.
- Sub-second response times -- HTTP round-trip latency is unnecessary overhead.
- No worker dependency -- works independently of the memory system.

This is enforced by the fact that `smart_search`, `smart_outline`, and `smart_unfold` have no entries in the `TOOL_ENDPOINT_MAP` in `mcp-server.ts`.

---

## The 3-Layer Workflow

The skill document (`plugin/skills/smart-explore/SKILL.md`) teaches Claude a strict progressive-disclosure pattern:

### Step 1: Search (broad discovery)

**Tool**: `smart_search(query, path?, max_results?, file_pattern?)`

Scans a directory tree, parses all code files using tree-sitter, and returns ranked symbol matches plus folded file views. Typical cost: 2,000-6,000 tokens.

### Step 2: Outline (file structure)

**Tool**: `smart_outline(file_path)`

Parses a single file and returns a complete structural skeleton -- all functions, classes, methods, properties, and imports with signatures but bodies folded. Typical cost: ~1,500 tokens.

This step is often skippable when Step 1 already provides enough structural context.

### Step 3: Unfold (targeted implementation)

**Tool**: `smart_unfold(file_path, symbol_name)`

Extracts and returns the full source code of a single symbol (function, class, method), including JSDoc comments, decorators, and the complete implementation body. Typical cost: ~1,600 tokens.

---

## Implementation Details

### Parser (`src/services/smart-file-read/parser.ts`, ~668 lines)

The parser is the core engine. It performs AST-based code structure extraction by shelling out to the tree-sitter CLI.

#### Language Support

The parser supports 9 languages via a file-extension-to-language mapping:

| Extensions | Language |
|---|---|
| .js, .mjs, .cjs | javascript |
| .jsx | tsx |
| .ts | typescript |
| .tsx | tsx |
| .py, .pyw | python |
| .go | go |
| .rs | rust |
| .rb | ruby |
| .java | java |
| .c, .h | c |
| .cpp, .cc, .cxx, .hpp, .hh | cpp |

Each language maps to a grammar package (e.g., `tree-sitter-typescript`) that is resolved at runtime via `require.resolve()` to find the grammar path on disk.

#### Tree-Sitter Query Patterns

The parser defines S-expression query patterns for each language family. These patterns tell tree-sitter which AST nodes to capture. For example, the JavaScript/TypeScript query extracts:

- Function declarations
- Arrow functions and function expressions assigned to `const`/`let`
- Class declarations
- Method definitions
- Interface declarations
- Type alias declarations
- Enum declarations
- Import and export statements

Each language family has its own tailored query. There is also a `generic` fallback for unsupported languages.

#### CLI Execution Flow

1. **Binary resolution**: `getTreeSitterBin()` finds the `tree-sitter` binary from the `tree-sitter-cli` npm package, falling back to PATH.

2. **Query file preparation**: Query patterns are written to temporary `.scm` files in a temp directory. These are cached for the process lifetime.

3. **Command execution**: The parser runs:
   ```
   tree-sitter query -p <grammar-path> <query-file> <source-files...>
   ```
   via `execSync` with a 30-second timeout.

4. **Output parsing**: `parseMultiFileQueryOutput()` parses the CLI's structured text output into `RawMatch` objects containing capture tags, positions, and text snippets.

#### Symbol Building

`buildSymbols()` transforms raw AST matches into structured `CodeSymbol` objects:

- **Kind mapping**: AST capture tags (e.g., `func`, `cls`, `method`) map to semantic kinds (`function`, `class`, `method`, etc.).
- **Signature extraction**: The parser reads the first line(s) of each symbol up to the opening brace to produce a clean signature string.
- **JSDoc/comment detection**: Scans backwards from each symbol to find preceding comments (JSDoc `/** */`, line comments `//`, Python docstrings `"""`).
- **Export detection**: Language-specific rules determine visibility:
  - JS/TS: checks if the symbol falls within an `export` AST range.
  - Python: checks for leading underscore convention.
  - Go: checks if the name starts with an uppercase letter.
  - Rust: checks for `pub` keyword.
- **Nesting**: Methods are nested inside their containing class/struct/impl/trait based on line ranges.

#### Batch Parsing

`parseFilesBatch()` groups files by language, then runs a single `tree-sitter query` invocation per language group. This is significantly faster than per-file parsing (one process spawn per language vs. per file). The batch results are parsed and split back into per-file `FoldedFile` objects.

#### Output Types

**`CodeSymbol`**: Represents a single code entity:
```typescript
interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "method" | "interface" | "type" | ...;
  signature: string;      // e.g., "export async function searchCodebase(rootDir, query, options)"
  jsdoc?: string;         // preceding comments
  lineStart: number;
  lineEnd: number;
  exported: boolean;
  children?: CodeSymbol[];  // nested methods for container types
}
```

**`FoldedFile`**: Represents a parsed file's structure:
```typescript
interface FoldedFile {
  filePath: string;
  language: string;
  symbols: CodeSymbol[];
  imports: string[];
  totalLines: number;
  foldedTokenEstimate: number;  // estimated tokens for the folded view
}
```

#### Formatting

`formatFoldedView()` renders a `FoldedFile` as a human-readable structural outline with icons:
- `f` for functions/methods
- diamond for classes/structs
- hollow diamond for interfaces/traits/types
- filled circle for constants
- Speech bubble for JSDoc summaries

Each symbol shows its name, export status, line range, and signature.

#### Unfolding

`unfoldSymbol()` extracts the full source code of a named symbol:
1. Parses the file to find the symbol by name (searching recursively through children).
2. Scans backwards to include preceding comments, decorators, and blank lines.
3. Returns the complete source from comment start through symbol end, prefixed with a location marker.

### Search (`src/services/smart-file-read/search.ts`, ~316 lines)

The search module finds code files and symbols matching a query across a directory tree.

#### Search Pipeline (3 phases)

**Phase 1: File Collection**
- Recursively walks the directory tree using an async generator (`walkDir`).
- Filters by file extension (code files only, from a set of ~20 extensions).
- Respects ignore patterns (`node_modules`, `.git`, `dist`, `build`, `__pycache__`, `venv`, `target`, `vendor`, etc.).
- Skips files over 512KB and binary files (null byte detection).
- Optionally filters by a `filePattern` parameter.

**Phase 2: Batch Parsing**
- Passes all collected files to `parseFilesBatch()`, which groups by language and runs one tree-sitter CLI call per language group.

**Phase 3: Symbol Matching**
- Matches the query against:
  - Symbol names (3x weight multiplier)
  - Signatures (2x weight)
  - JSDoc comments (1x weight)
  - File paths
- Scoring uses three tiers:
  - Exact match: 10 points per query part
  - Substring match: 5 points per query part
  - Fuzzy (all characters in order): 1 point per query part
- Results are sorted by relevance score and trimmed to `maxResults`.

#### Output

`formatSearchResults()` produces a two-section output:
1. **Matching Symbols** -- compact list showing kind, qualified name, file path, line number, signature, and JSDoc summary.
2. **Folded File Views** -- full structural outlines of files containing matches.

### MCP Tool Registration (`src/servers/mcp-server.ts`)

The three tools are registered in the `tools` array alongside the existing claude-mem tools:

**`smart_search`**:
- Resolves the `path` parameter (defaulting to `process.cwd()`).
- Calls `searchCodebase()` with the query and options.
- Formats results with `formatSearchResults()`.

**`smart_unfold`**:
- Resolves the file path.
- Reads the file with `readFile()`.
- Calls `unfoldSymbol()` to extract the named symbol.
- On failure, falls back to `parseFile()` and lists available symbol names to help the user correct their request.

**`smart_outline`**:
- Resolves the file path.
- Reads the file with `readFile()`.
- Calls `parseFile()` to get the structural view.
- Returns `formatFoldedView()` output.

All three tools use raw JSON Schema for input validation (matching the existing tool pattern), and return MCP-format responses: `{ content: [{ type: 'text', text: string }] }`.

---

## Build System Integration

### esbuild Externals

The MCP server is bundled by esbuild into a single CJS file (`plugin/scripts/mcp-server.cjs`). Tree-sitter packages must be externalized (not bundled) because:

- `tree-sitter-cli` contains a platform-specific binary that cannot be bundled.
- Grammar packages are resolved at runtime via `require.resolve()` to find grammar file paths on disk.

The following are listed as externals in `scripts/build-hooks.js`:
```
tree-sitter-cli, tree-sitter-javascript, tree-sitter-typescript,
tree-sitter-python, tree-sitter-go, tree-sitter-rust, tree-sitter-ruby,
tree-sitter-java, tree-sitter-c, tree-sitter-cpp
```

### Runtime Dependencies

The generated `plugin/package.json` includes all tree-sitter packages as dependencies. These are installed at plugin runtime via `bun install` (handled by the existing `smart-install.js` hook). The `tree-sitter-cli` package ships with a pre-built binary for each platform, so no compilation is needed.

### Dependency Versions (from `package.json`)

| Package | Version |
|---|---|
| tree-sitter-cli | ^0.26.5 |
| tree-sitter-c | ^0.24.1 |
| tree-sitter-cpp | ^0.23.4 |
| tree-sitter-go | ^0.25.0 |
| tree-sitter-java | ^0.23.5 |
| tree-sitter-javascript | ^0.25.0 |
| tree-sitter-python | ^0.25.0 |
| tree-sitter-ruby | ^0.23.1 |
| tree-sitter-rust | ^0.24.0 |
| tree-sitter-typescript | ^0.23.2 |

---

## Data Flow Diagram

### smart_search

```
User query ("shutdown")
  |
  v
MCP Server receives CallToolRequest
  |
  v
smart_search handler resolves path
  |
  v
searchCodebase(rootDir, "shutdown", options)
  |
  +-- Phase 1: walkDir() collects all code files
  |     Filters: extensions, ignore dirs, size, binary check
  |
  +-- Phase 2: parseFilesBatch(files)
  |     Groups files by language
  |     For each language group:
  |       tree-sitter query -p <grammar> <query.scm> file1 file2 ...
  |       One CLI call per language (not per file)
  |     Parse CLI output -> RawMatch[]
  |     buildSymbols() -> CodeSymbol[] per file
  |     Returns Map<filePath, FoldedFile>
  |
  +-- Phase 3: matchScore() against all symbols
  |     Scores: name (3x), signature (2x), jsdoc (1x)
  |     Sort by score, trim to maxResults
  |
  v
formatSearchResults()
  |
  v
MCP response: { content: [{ type: 'text', text: formatted }] }
```

### smart_outline

```
User requests outline of "worker-service.ts"
  |
  v
MCP Server receives CallToolRequest
  |
  v
smart_outline handler resolves path, reads file
  |
  v
parseFile(content, filePath)
  |
  +-- detectLanguage() -> "typescript"
  +-- resolveGrammarPath() -> path to tree-sitter-typescript
  +-- getQueryFile("jsts") -> temp .scm file with TS query patterns
  +-- Write content to temp source file
  +-- tree-sitter query -p <grammar> <query.scm> <temp-file>
  +-- parseMultiFileQueryOutput() -> RawMatch[]
  +-- buildSymbols() -> CodeSymbol[] with nesting
  |
  v
formatFoldedView(parsedFile)
  |
  v
MCP response with structural outline (~1,500 tokens)
```

### smart_unfold

```
User requests unfold of "shutdown" in "worker-service.ts"
  |
  v
MCP Server receives CallToolRequest
  |
  v
smart_unfold handler resolves path, reads file
  |
  v
unfoldSymbol(content, filePath, "shutdown")
  |
  +-- parseFile() to get all symbols (same flow as outline)
  +-- findSymbol() recursive search through symbol tree
  +-- If found:
  |     Scan backwards for comments/decorators
  |     Extract lines[commentStart .. symbolEnd]
  |     Return with location marker prefix
  +-- If not found:
        Return null -> handler lists available symbols
  |
  v
MCP response with full source (~1,600 tokens)
```

---

## File Inventory

| File | Purpose | Lines |
|---|---|---|
| `src/services/smart-file-read/parser.ts` | AST parsing engine, tree-sitter CLI integration, symbol extraction, formatting, unfolding | ~668 |
| `src/services/smart-file-read/search.ts` | Directory walking, batch parsing orchestration, fuzzy symbol matching, result formatting | ~316 |
| `src/servers/mcp-server.ts` | MCP tool definitions and handlers for smart_search, smart_outline, smart_unfold (lines 267-377) | (part of larger file) |
| `plugin/skills/smart-explore/SKILL.md` | Skill document teaching Claude the 3-layer workflow | ~134 |
| `.plan/smart-file-read.md` | Integration plan documenting the phased implementation approach | ~255 |
| `scripts/build-hooks.js` | Build configuration with tree-sitter externals and plugin dependencies | (modified) |
| `package.json` | Root dependencies including tree-sitter packages | (modified) |

---

## Why tree-sitter CLI (Not WASM, Not Native Bindings)

The implementation went through multiple iterations before settling on the CLI approach:

1. **Native bindings** (`node-tree-sitter`): Rejected because native addons require platform-specific compilation, creating cross-platform installation headaches.

2. **WASM** (`web-tree-sitter`): Attempted but rejected. While WASM is portable, it has higher startup overhead and more complex integration (loading .wasm files at runtime).

3. **CLI** (`tree-sitter-cli`): Selected because:
   - The `tree-sitter-cli` npm package ships a pre-built binary for each platform -- no compilation.
   - Grammar packages only need their grammar files on disk (resolved via `require.resolve`).
   - Batch mode (one CLI call per language for multiple files) keeps process spawn overhead minimal.
   - Validated at 2.95 seconds for 192 files in batch mode.
   - The `execSync` approach is simple, debuggable, and has no async complexity.

---

## Token Economics Summary

| Approach | Typical Tokens | Use Case |
|---|---|---|
| smart_outline | ~1,500 | "What's in this file?" |
| smart_unfold | ~1,600 | "Show me this function" |
| smart_search | ~2,000-6,000 | "How does X work across the codebase?" |
| Read (full file) | ~12,000+ | When you truly need everything |
| Explore agent | ~20,000-40,000 | Same as smart_search, 6-12x more expensive |

The fundamental insight is that developers (and LLMs) rarely need an entire file. They need to know what is in a file (outline), find relevant code across many files (search), and then read specific implementations (unfold). By providing these three operations as first-class tools with a clear workflow, smart-explore eliminates the wasteful pattern of reading entire large files to find small pieces of information.
