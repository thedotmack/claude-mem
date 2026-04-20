---
name: smart-explore
description: Token-optimized structural code search using tree-sitter AST parsing. Use instead of reading full files when you need to understand code structure, find functions, or explore a codebase efficiently.
---

# Smart Explore

Structural code exploration using AST parsing. **This skill overrides your default exploration behavior.** While this skill is active, use smart_search/smart_outline/smart_unfold as your primary tools instead of Read, Grep, and Glob.

**Core principle:** Index first, fetch on demand. Give yourself a map of the code before loading implementation details. The question before every file read should be: "do I need to see all of this, or can I get a structural overview first?" The answer is almost always: get the map.

## Your Next Tool Call

This skill only loads instructions. You must call the MCP tools yourself. Your next action should be one of:

```
smart_search(query="<topic>", path="./src")    -- discover files + symbols across a directory
smart_outline(file_path="<file>")              -- structural skeleton of one file
smart_unfold(file_path="<file>", symbol_name="<name>")  -- full source of one symbol
```

Do NOT run Grep, Glob, Read, or find to discover files first. `smart_search` walks directories, parses all code files, and returns ranked symbols in one call. It replaces the Glob → Grep → Read discovery cycle.

## 3-Layer Workflow

### Step 1: Search -- Discover Files and Symbols

```
smart_search(query="shutdown", path="./src", max_results=15)
```

**Returns:** Ranked symbols with signatures, line numbers, match reasons, plus folded file views (~2-6k tokens)

```
-- Matching Symbols --
  function performGracefulShutdown (services/infrastructure/GracefulShutdown.ts:56)
  function httpShutdown (services/infrastructure/HealthMonitor.ts:92)
  method WorkerService.shutdown (services/worker-service.ts:846)

-- Folded File Views --
  services/infrastructure/GracefulShutdown.ts (7 symbols)
  services/worker-service.ts (12 symbols)
```

This is your discovery tool. It finds relevant files AND shows their structure. No Glob/find pre-scan needed.

**Parameters:**

- `query` (string, required) -- What to search for (function name, concept, class name)
- `path` (string) -- Root directory to search (defaults to cwd)
- `max_results` (number) -- Max matching symbols, default 20, max 50
- `file_pattern` (string, optional) -- Filter to specific files/paths

### Step 2: Outline -- Get File Structure

```
smart_outline(file_path="services/worker-service.ts")
```

**Returns:** Complete structural skeleton -- all functions, classes, methods, properties, imports (~1-2k tokens per file)

**Skip this step** when Step 1's folded file views already provide enough structure. Most useful for files not covered by the search results.

**Parameters:**

- `file_path` (string, required) -- Path to the file

### Step 3: Unfold -- See Implementation

Review symbols from Steps 1-2. Pick the ones you need. Unfold only those:

```
smart_unfold(file_path="services/worker-service.ts", symbol_name="shutdown")
```

**Returns:** Full source code of the specified symbol including JSDoc, decorators, and complete implementation (~400-2,100 tokens depending on symbol size). AST node boundaries guarantee completeness regardless of symbol size — unlike Read + agent summarization, which may truncate long methods.

**Parameters:**

- `file_path` (string, required) -- Path to the file (as returned by search/outline)
- `symbol_name` (string, required) -- Name of the function/class/method to expand

## When to Use Standard Tools Instead

Use these only when smart_* tools are the wrong fit:

- **Grep:** Exact string/regex search ("find all TODO comments", "where is `ensureWorkerStarted` defined?")
- **Read:** Small files under ~100 lines, non-code files (JSON, markdown, config)
- **Glob:** File path patterns ("find all test files")
- **Explore agent:** When you need synthesized understanding across 6+ files, architecture narratives, or answers to open-ended questions like "how does this entire system work end-to-end?" Smart-explore is a scalpel — it answers "where is this?" and "show me that." It doesn't synthesize cross-file data flows, design decisions, or edge cases across an entire feature.

For code files over ~100 lines, prefer smart_outline + smart_unfold over Read.

## Workflow Examples

**Discover how a feature works (cross-cutting):**

```
1. smart_search(query="shutdown", path="./src")
   -> 14 symbols across 7 files, full picture in one call
2. smart_unfold(file_path="services/infrastructure/GracefulShutdown.ts", symbol_name="performGracefulShutdown")
   -> See the core implementation
```

**Navigate a large file:**

```
1. smart_outline(file_path="services/worker-service.ts")
   -> 1,466 tokens: 12 functions, WorkerService class with 24 members
2. smart_unfold(file_path="services/worker-service.ts", symbol_name="startSessionProcessor")
   -> 1,610 tokens: the specific method you need
Total: ~3,076 tokens vs ~12,000 to Read the full file
```

**Write documentation about code (hybrid workflow):**

```
1. smart_search(query="feature name", path="./src")    -- discover all relevant files and symbols
2. smart_outline on key files                           -- understand structure
3. smart_unfold on important functions                  -- get implementation details
4. Read on small config/markdown/plan files             -- get non-code context
```

Use smart_* tools for code exploration, Read for non-code files. Mix freely.

**Exploration then precision:**

```
1. smart_search(query="session", path="./src", max_results=10)
   -> 10 ranked symbols: SessionMetadata, SessionQueueProcessor, SessionSummary...
2. Pick the relevant one, unfold it
```

## Token Economics

| Approach | Tokens | Use Case |
|----------|--------|----------|
| smart_outline | ~1,000-2,000 | "What's in this file?" |
| smart_unfold | ~400-2,100 | "Show me this function" |
| smart_search | ~2,000-6,000 | "Find all X across the codebase" |
| search + unfold | ~3,000-8,000 | End-to-end: find and read (the primary workflow) |
| Read (full file) | ~12,000+ | When you truly need everything |
| Explore agent | ~39,000-59,000 | Cross-file synthesis with narrative |

**4-8x savings** on file understanding (outline + unfold vs Read). **11-18x savings** on codebase exploration vs Explore agent. The narrower the query, the wider the gap — a 27-line function costs 55x less to read via unfold than via an Explore agent, because the agent still reads the entire file.

## Language Support

Smart-explore uses **tree-sitter AST parsing** for structural analysis. Unsupported file types fall back to text-based search.

### Bundled Languages

| Language | Extensions |
|----------|-----------|
| JavaScript | `.js`, `.mjs`, `.cjs` |
| TypeScript | `.ts` |
| TSX / JSX | `.tsx`, `.jsx` |
| Python | `.py`, `.pyw` |
| Go | `.go` |
| Rust | `.rs` |
| Ruby | `.rb` |
| Java | `.java` |
| C | `.c`, `.h` |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh` |

Files with unrecognized extensions are parsed as plain text — `smart_search` still works (grep-style), but `smart_outline` and `smart_unfold` will not extract structured symbols.

### Custom Grammars (`.claude-mem.json`)

You can register additional tree-sitter grammars for file types not in the bundled list. Create or update `.claude-mem.json` in your project root:

```json
{
  "grammars": {
    ".sol": "tree-sitter-solidity",
    ".graphql": "tree-sitter-graphql"
  }
}
```

Each key is a file extension; each value is the npm package name of the tree-sitter grammar. The grammar must be installed locally (`npm install tree-sitter-solidity`). Once registered, `smart_outline` and `smart_unfold` will parse those extensions structurally instead of falling back to plain text.

### Markdown Special Support

Markdown files (`.md`, `.mdx`) receive special handling beyond the generic plain-text fallback:

- **`smart_outline`** — extracts headings (`#`, `##`, `###`) as the symbol tree. Use it to navigate long documents without reading the full file.
- **`smart_search`** — searches within code fences as well as prose, so queries for function names inside ` ```ts ``` ` blocks work as expected.
- **`smart_unfold`** — expands heading sections rather than function bodies; each section up to the next same-level heading is returned as a chunk.
- **Frontmatter** — YAML frontmatter (lines between leading `---` delimiters) is included in `smart_outline` output under a synthetic `frontmatter` symbol so metadata like `title:` and `description:` is visible without reading the whole file.
