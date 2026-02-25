# Smart File Read Testing Methodology

## Setup

The tool is built and ready at:
```
/Users/alexnewman/Scripts/claude-mem/.claude/worktrees/musing-sammet/smart-file-read/
```

Run tests with:
```bash
cd /Users/alexnewman/Scripts/claude-mem/.claude/worktrees/musing-sammet/smart-file-read
node test-run.mjs
```

The test script imports from `./dist/` (compiled JS). If you modify `.ts` source files, rebuild with `npx tsc` first.

## Test Plan

### Test 1: Broad Concept Search
**Query**: "session" against `../src`
**Why**: High-frequency term in the codebase. Tests ranking quality — does it surface the important SessionManager/SessionStore definitions, or drown in noise?
**Compare**: Run `Grep` for "session" and count how many files match vs how many smart_search returns. Check if smart_search's top 10 are the ones you'd actually want to read first.

### Test 2: Specific Function Lookup
**Query**: "ensureWorkerStarted" against `../src`
**Why**: Known exact function name. Tests whether smart_search is competitive with Grep for precise lookups, or if the overhead of AST parsing makes it slower/worse.
**Compare**: Time both approaches. Grep should be faster for this case — the question is by how much.

### Test 3: Cross-Cutting Concern
**Query**: "shutdown" against `../src`
**Why**: Shutdown logic is scattered across ProcessManager, GracefulShutdown, WorkerService, signal handlers. Tests whether the folded view helps you see the full picture across files without reading each one.
**Compare**: Use Explore agent to understand "how does shutdown work" — count tool calls and tokens consumed vs smart_search single call.

### Test 4: smart_outline on a Large File
**Target**: `../src/services/worker-service.ts` (1225 lines)
**Why**: Tests structural extraction quality on the biggest file. Does the outline give you enough to navigate without reading the full file?
**Compare**: Read the file with the Read tool (2000-line limit, full content). Compare tokens consumed vs information gained.

### Test 5: smart_unfold Precision
**Target**: Unfold `WorkerService` class, then unfold `startSessionProcessor` method
**Why**: Tests the progressive disclosure flow — outline → pick symbol → see implementation. Is the extracted code complete and correct?
**Compare**: Read tool with offset/limit to extract the same function. Check if smart_unfold gets the boundaries right (includes JSDoc, doesn't clip).

### Test 6: Non-TypeScript Language
**Target**: Find or create a small Python/Go file and run smart_outline
**Why**: The parser supports multiple languages. Verify it actually works beyond TS.

## What to Measure

For each test, note:
1. **Token cost** — approximate tokens in the response
2. **Tool calls** — how many calls needed with default tools vs smart_search
3. **Signal quality** — did the top results answer the question, or was manual filtering needed?
4. **Correctness** — are line numbers accurate? Are signatures complete? Does unfold get boundaries right?

## How to Run Individual Tests

Edit `test-run.mjs` or create ad-hoc scripts:

```js
// Search example
import { searchCodebase, formatSearchResults } from "./dist/search.js";
const result = await searchCodebase("/path/to/src", "your query", { maxResults: 10 });
console.log(formatSearchResults(result, "your query"));

// Outline example
import { parseFile, formatFoldedView } from "./dist/parser.js";
import { readFile } from "node:fs/promises";
const content = await readFile("/path/to/file.ts", "utf-8");
console.log(formatFoldedView(parseFile(content, "file.ts")));

// Unfold example
import { unfoldSymbol } from "./dist/parser.js";
const unfolded = unfoldSymbol(content, "file.ts", "functionName");
console.log(unfolded);
```
