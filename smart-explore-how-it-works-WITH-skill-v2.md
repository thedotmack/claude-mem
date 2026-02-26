# How Smart Explore Works

A technical deep-dive into the smart-explore system: AST-powered code exploration for Claude Code that replaces multi-round Grep-Read cycles with structural, token-efficient tooling.

## System Overview

Smart-explore is a code exploration feature in the claude-mem plugin. It exposes three MCP tools -- `smart_search`, `smart_outline`, and `smart_unfold` -- that use tree-sitter AST parsing to provide structural views of code instead of dumping raw file contents. The key insight: an LLM rarely needs a full 12,000-token file when a 1,500-token structural outline plus a 1,600-token targeted symbol extraction achieves the same understanding.

The system consists of four layers:

1. **Parser** (`src/services/smart-file-read/parser.ts`, 667 lines) -- Shells out to the tree-sitter CLI for AST extraction, builds symbol tables, formats folded views.
2. **Search** (`src/services/smart-file-read/search.ts`, 316 lines) -- Walks directories, batch-parses files by language, scores symbols against queries.
3. **MCP Tool Handlers** (`src/servers/mcp-server.ts`) -- Registers the three tools on the MCP protocol, wires them to parser/search functions.
4. **Skill Definition** (`plugin/skills/smart-explore/SKILL.md`) -- Instructs Claude on the 3-layer search-outline-unfold workflow.

## Architecture: Why CLI, Not WASM or Native Bindings

The parser does not use tree-sitter WASM or native Node.js bindings. Instead, it shells out to the `tree-sitter` CLI binary via `execSync`. This was a deliberate design decision:

- **No compilation required**: The `tree-sitter-cli` npm package ships a pre-built binary. No `node-gyp`, no platform-specific build steps.
- **Grammar files only**: Language grammar packages (`tree-sitter-typescript`, `tree-sitter-python`, etc.) are resolved at runtime via `require.resolve()` to locate their grammar file paths. The parser never loads grammar code into the Node.js process.
- **Batch mode**: One CLI invocation per language handles many files at once, amortizing process spawn overhead. Benchmarks showed 192 files parsed in 2.95 seconds in batch mode.
- **Cross-platform**: The CLI binary works on macOS, Linux, and Windows without platform-conditional code.

## Layer 1: The Parser (`parser.ts`)

The parser is the core engine. It takes source code and a file path, runs tree-sitter queries against the AST, and returns structured symbol data.

### Language Detection and Grammar Resolution

The parser supports 10 languages via a file extension map:

```
.js/.mjs/.cjs  -> javascript     .py/.pyw       -> python
.ts            -> typescript      .go            -> go
.tsx/.jsx      -> tsx             .rs            -> rust
.rb            -> ruby            .java          -> java
.c/.h          -> c               .cpp/.cc/.hpp  -> cpp
```

Grammar paths are resolved at runtime using `require.resolve()` against installed npm grammar packages. For example, `tree-sitter-typescript/typescript/package.json` is resolved and its `dirname` provides the grammar directory:

```typescript
function resolveGrammarPath(language: string): string | null {
  const pkg = GRAMMAR_PACKAGES[language]; // e.g., "tree-sitter-typescript/typescript"
  if (!pkg) return null;
  try {
    const packageJsonPath = _require.resolve(pkg + "/package.json");
    return dirname(packageJsonPath);
  } catch {
    return null;
  }
}
```

### Tree-Sitter Query Patterns

Each language family has a declarative S-expression query that extracts structural nodes from the AST. For JavaScript/TypeScript/TSX (the `jsts` query):

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

Similar patterns exist for Python, Go, Rust, Ruby, Java, and a generic fallback. The queries use two capture groups per pattern: `@name` captures the symbol's identifier, and the outer tag (`@func`, `@cls`, `@method`, etc.) captures the full node span (including the body).

### CLI Execution Flow

1. **Query files are cached on disk**: The S-expression query strings are written to temporary `.scm` files in a temp directory, created once and reused across calls.

2. **Single-file parsing** (`parseFile`):
   - Write the source content to a temp file with the correct extension
   - Execute: `tree-sitter query -p <grammar-path> <query-file> <source-file>`
   - Parse the text output into `RawMatch[]` structures
   - Clean up the temp file

3. **Batch parsing** (`parseFilesBatch`):
   - Group files by language
   - For each language group, run one CLI call with all file paths
   - Parse the multi-file output (file headers delimit per-file results)
   - Returns a `Map<string, FoldedFile>` keyed by relative path

The batch approach is critical for `smart_search` performance. Instead of spawning 192 processes for 192 files, it spawns ~3-5 processes (one per language present).

### CLI Output Parsing

The tree-sitter CLI outputs structured text that looks like:

```
/path/to/file.ts
  pattern: 0
    capture: 0 - name, start: (10, 9), end: (10, 22), text: `myFunction`
    capture: 1 - func, start: (10, 0), end: (25, 1)
```

The `parseMultiFileQueryOutput` function parses this line-by-line: lines without leading whitespace are file headers; `pattern:` lines start new matches; `capture:` lines provide the tag, position, and optional text for each capture.

### Symbol Building

The `buildSymbols` function transforms raw matches into a `CodeSymbol[]` tree:

1. **Collect exports and imports**: Scans all matches for `@exp` and `@imp` captures. Export ranges are stored for determining exported status.

2. **Build symbol objects**: For each match with a known kind tag (`@func`, `@cls`, `@method`, etc.), extracts:
   - `name` from the `@name` capture's text
   - `lineStart`/`lineEnd` from the kind capture's span
   - `signature` from the first line(s) of source up to the opening brace
   - `jsdoc` from comments above the symbol (supports JSDoc `/** */`, Python docstrings `"""..."""`, and line comments `//`/`#`)
   - `exported` status using language-specific rules:
     - JS/TS: Symbol is within an `@exp` range
     - Python: Name doesn't start with `_`
     - Go: Name starts with uppercase
     - Rust: Line starts with `pub`

3. **Nest children into containers**: Classes, structs, impls, and traits are "container" kinds. Methods whose line ranges fall within a container are re-parented as children and promoted from "function" to "method" kind.

The result is a hierarchical symbol tree: top-level functions, classes with nested methods, interfaces, types, etc.

### Formatting

The `formatFoldedView` function renders a `FoldedFile` as human-readable text:

```
[folder icon] src/services/worker-service.ts (typescript, 1225 lines)

  [package icon] Imports: 8 statements
    import { Server } from '@modelcontextprotocol/sdk/server/index.js'
    ...

  [function icon] startServer [exported] (L45-L92)
    export async function startServer(port: number)
    [comment icon] Start the Express server on the given port.

  [class icon] WorkerService [exported] (L100-L1200)
    export class WorkerService
    [function icon] constructor (L102-L130)
      constructor(config: WorkerConfig)
    [function icon] startSessionProcessor (L200-L350)
      async startSessionProcessor()
    ...
```

Each symbol shows its kind icon, name, export status, line range, and signature. JSDoc/comments are compressed to a single line. Bodies are completely omitted -- that is the "folding".

Token estimates are calculated as `Math.ceil(formattedText.length / 4)`.

### Unfold

The `unfoldSymbol` function does targeted extraction:

1. Parse the file to get the symbol table
2. Recursively search for a symbol by name (including class children)
3. Walk backwards from the symbol's start line to include preceding comments, decorators, and JSDoc
4. Extract the source from that expanded start through `lineEnd`
5. Prepend a location header: `// [pin icon] <filePath> L<start>-<end>`

If the symbol is not found, the MCP handler falls back to listing all available symbols in the file.

## Layer 2: The Search Engine (`search.ts`)

### Directory Walking

The `walkDir` async generator recursively traverses a directory, yielding file paths that:
- Have a known code extension (`.ts`, `.py`, `.go`, etc. -- 20+ extensions)
- Are not in ignored directories (`node_modules`, `.git`, `dist`, `build`, `__pycache__`, `target`, `vendor`, `.claude`, etc.)
- Don't start with `.` (hidden files/dirs)

File reading skips files over 512KB and files that appear to be binary (null bytes in the first 1000 characters).

### The Search Pipeline

`searchCodebase(rootDir, query, options)` runs a 3-phase pipeline:

**Phase 1: Collect files** -- Walk the directory tree, optionally filtering by `filePattern`. Read each file into memory.

**Phase 2: Batch parse** -- Call `parseFilesBatch(files)` which groups files by language and spawns one CLI process per language. Returns a `Map<string, FoldedFile>`.

**Phase 3: Match and rank** -- For each parsed file, score its symbols against the query:

The query is split into lowercase parts on whitespace, underscores, hyphens, dots, and slashes. Each symbol is scored on three dimensions:

- **Name match** (3x weight): Score the symbol name against query parts
- **Signature match** (2x weight): Full query substring match against the signature
- **JSDoc match** (1x weight): Full query substring match against documentation

The `matchScore` function uses three tiers:
- Exact equality: 10 points
- Substring containment: 5 points
- Fuzzy ordered character match: 1 point (all characters of the query part appear in order in the text)

Files where at least one symbol matched (or whose path matched the query) are included in results. Symbols are sorted by score, trimmed to `maxResults`, and only files containing those top symbols are included in the output.

### Result Formatting

`formatSearchResults` produces a structured text output with three sections:

1. **Header**: Query, files scanned, symbols found, match count, token estimate
2. **Matching Symbols**: Each symbol with its kind, qualified name, file:line, signature, and first JSDoc line
3. **Folded File Views**: Full structural outlines of all files containing matches
4. **Actions**: Instructions for the LLM on what to do next (use `smart_unfold`)

## Layer 3: MCP Tool Registration (`mcp-server.ts`)

The three smart_* tools are registered alongside existing claude-mem memory tools (search, timeline, get_observations, save_observation) in a single MCP server.

### Key Design Decision: Direct Execution

Unlike the memory tools which delegate to the Worker HTTP API at `localhost:37777`, the smart_* tools execute directly in the MCP server process. This was deliberate:

- Smart-explore is stateless read-only file I/O + AST parsing -- no database, no shared state
- Sub-second response times would be degraded by HTTP round-trip overhead
- No worker dependency -- works even if the memory worker is down

### Tool Handlers

**`smart_search`**: Resolves the `path` argument (defaults to `process.cwd()`), calls `searchCodebase()`, formats results with `formatSearchResults()`, returns as MCP text content.

**`smart_outline`**: Resolves `file_path`, reads the file with `fs.readFile`, calls `parseFile()`, formats with `formatFoldedView()`. If no symbols are found (unsupported language or empty file), returns an explanatory message.

**`smart_unfold`**: Resolves `file_path`, reads the file, calls `unfoldSymbol()`. If the symbol isn't found, falls back to `parseFile()` and lists all available symbol names so the LLM can self-correct.

All three return the standard MCP response format: `{ content: [{ type: 'text', text: string }] }`.

### Build System Integration

The MCP server is built with esbuild into a single `plugin/scripts/mcp-server.cjs` file. Tree-sitter packages are **externalized** from the bundle (not inlined) because the parser uses `require.resolve()` at runtime to locate grammar files on disk:

```javascript
external: [
  'bun:sqlite',
  'tree-sitter-cli',
  'tree-sitter-javascript', 'tree-sitter-typescript',
  'tree-sitter-python', 'tree-sitter-go', 'tree-sitter-rust',
  'tree-sitter-ruby', 'tree-sitter-java',
  'tree-sitter-c', 'tree-sitter-cpp',
],
```

These packages are declared as runtime dependencies in the generated `plugin/package.json` and installed at plugin setup time by `smart-install.js` via `bun install`.

## Layer 4: The Skill (`SKILL.md`)

The skill file at `plugin/skills/smart-explore/SKILL.md` is a Claude Code skill -- a markdown document with YAML frontmatter that instructs Claude on when and how to use the tools. It does not contain executable code.

When a user invokes `/smart-explore` or Claude determines the skill is relevant, the SKILL.md content is loaded into Claude's context. It teaches:

1. **The 3-layer workflow**: search -> outline -> unfold. Start broad, narrow down, only read what you need.
2. **Tool parameters**: Complete parameter documentation for all three tools.
3. **When NOT to use it**: Exact name lookups (use Grep), small files (use Read), file path patterns (use Glob).
4. **Token economics**: Quantified savings -- 8x for file understanding, 6-12x for exploration vs the Explore agent.

The workflow is modeled on the existing `mem-search` skill's 3-layer progressive disclosure pattern (search -> timeline -> get_observations), adapted for code exploration.

## Data Flow: End to End

Here is the complete data flow for a `smart_search` call:

```
User asks: "How does shutdown work?"
    |
    v
Claude invokes: smart_search(query="shutdown", path="./src")
    |
    v
MCP Server handler (mcp-server.ts)
  -> resolve("./src") to absolute path
  -> searchCodebase(rootDir, "shutdown", {maxResults: 20})
    |
    v
Phase 1: walkDir collects file paths
  -> filters: code extensions, ignored dirs, < 512KB, not binary
  -> reads content of each file into memory
    |
    v
Phase 2: parseFilesBatch groups by language
  -> TypeScript files: one tree-sitter CLI call
  -> Python files: one tree-sitter CLI call
  -> etc.
  Each CLI call:
    tree-sitter query -p <grammar-path> <query.scm> file1.ts file2.ts ...
    -> parse text output -> RawMatch[] per file
    -> buildSymbols -> CodeSymbol[] per file
    -> formatFoldedView -> token estimate
    |
    v
Phase 3: Match "shutdown" against all symbols
  -> split query: ["shutdown"]
  -> score each symbol: name(3x), signature(2x), jsdoc(1x)
  -> sort by score, trim to maxResults
    |
    v
formatSearchResults produces:
  -- Matching Symbols --
    function performGracefulShutdown (GracefulShutdown.ts:56)
    method WorkerService.shutdown (worker-service.ts:846)
    ...
  -- Folded File Views --
    [structural outlines of matching files]
  -- Actions --
    "use smart_unfold to see full implementation"
    |
    v
MCP returns: { content: [{ type: 'text', text: formattedOutput }] }
    |
    v
Claude reads the structural results (~5k tokens)
  -> picks the most relevant symbol
  -> calls smart_unfold(file_path="...", symbol_name="performGracefulShutdown")
  -> gets just that function's source (~1.5k tokens)
```

Total: approximately 6,500 tokens for full understanding of shutdown across the codebase. Compare to the Explore agent approach: 6-10 Grep+Read rounds consuming 20,000-40,000 tokens for the same information.

## Runtime Dependencies

Installed at plugin setup time in `plugin/node_modules/`:

| Package | Purpose |
|---------|---------|
| `tree-sitter-cli` | Pre-built binary for `tree-sitter query` |
| `tree-sitter-javascript` | Grammar files for .js/.mjs/.cjs |
| `tree-sitter-typescript` | Grammar files for .ts/.tsx/.jsx |
| `tree-sitter-python` | Grammar files for .py |
| `tree-sitter-go` | Grammar files for .go |
| `tree-sitter-rust` | Grammar files for .rs |
| `tree-sitter-ruby` | Grammar files for .rb |
| `tree-sitter-java` | Grammar files for .java |
| `tree-sitter-c` | Grammar files for .c/.h |
| `tree-sitter-cpp` | Grammar files for .cpp/.cc/.hpp |

The grammar packages have peer dependencies on native tree-sitter, but those are not installed -- only the grammar files are used. The `--legacy-peer-deps` flag handles this during `bun install`.

## Performance Characteristics

From benchmark testing on the claude-mem codebase (192 source files):

| Operation | Time | Tokens |
|-----------|------|--------|
| `smart_search` (broad query, 192 files) | ~2.9s | 2,000-6,000 |
| `smart_outline` (single 1,225-line file) | ~13ms | ~1,500 |
| `smart_unfold` (single method, 152 lines) | ~13ms + parse time | ~1,600 |
| Batch parse (192 files, all languages) | ~2.95s | N/A |

The batch parse dominates `smart_search` time. For outline and unfold on individual files, response is near-instant because only one file is parsed.

## File Inventory

| File | Lines | Role |
|------|-------|------|
| `src/services/smart-file-read/parser.ts` | 667 | Core parser: tree-sitter CLI execution, symbol extraction, formatting, unfolding |
| `src/services/smart-file-read/search.ts` | 316 | Directory walker, batch parsing orchestration, fuzzy matching, result formatting |
| `src/servers/mcp-server.ts` | 490 | MCP protocol server with all tool registrations including smart_* handlers |
| `plugin/skills/smart-explore/SKILL.md` | 142 | Skill instructions: 3-layer workflow, parameters, examples, token economics |
| `scripts/build-hooks.js` | ~200 | Build configuration: esbuild externals and runtime dependency declarations |
| `.plan/smart-file-read.md` | 255 | Integration plan documenting all architecture decisions |
