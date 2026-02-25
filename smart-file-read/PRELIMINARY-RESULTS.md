# Smart Explore: Preliminary Results & Skill Recommendation

## Part 1: Test Results

### Test Matrix

| # | Test | Tool | Files Scanned | Results | Tokens | Time |
|---|------|------|--------------|---------|--------|------|
| 1 | Broad concept ("session") | smart_search | 54 | 10 symbols, 9 files | ~2,342 | — |
| 1 | Broad concept ("session") | Grep | — | 111 files, 2,658 hits | ~5,000+ | instant |
| 2 | Exact function ("ensureWorkerStarted") | smart_search | 192 | 2 symbols | ~2,709 | 193ms |
| 2 | Exact function ("ensureWorkerStarted") | Grep | — | exact match | ~200 | instant |
| 3 | Cross-cutting ("shutdown") | smart_search | 192 | 14 symbols, 7 files | ~5,898 | — |
| 3 | Cross-cutting ("shutdown") | Explore agent | — | same info | ~20-40k | 6-10 calls |
| 4 | File structure (1225-line file) | smart_outline | 1 | 12 top-level + 24 class members | ~1,466 | 13ms |
| 4 | File structure (1225-line file) | Read tool | 1 | full source | ~12,000+ | — |
| 5a | Class unfold (WorkerService) | smart_unfold | 1 | 736 lines | ~6,972 | — |
| 5b | Method unfold (startSessionProcessor) | smart_unfold | 1 | 152 lines | ~1,610 | — |
| 5 | Same method via Read | Read + offset | 1 | same lines | ~12,000 (full file) | — |
| 6 | Python file (129 lines) | smart_outline | 1 | 2 functions, 5 imports | correct | — |

### Key Findings

**smart_search excels at:**
- Cross-cutting concerns scattered across files (shutdown, session, worker)
- Exploratory queries where you don't know which files matter
- Replacing the Explore agent's multi-round Grep-Read cycle (6-12x token savings)

**smart_search is overkill for:**
- Exact name lookups — Grep returns in ~200 tokens, smart_search costs ~2.7k
- String literal search in file contents — Grep is the right tool

**smart_outline excels at:**
- Understanding large files without reading them — 8x token reduction
- Navigation: get the map, then unfold specific symbols

**smart_unfold excels at:**
- Progressive disclosure — 1.6k tokens for a specific method vs 12k for the whole file
- Boundary detection — correctly includes JSDoc, gets start/end lines right
- Works for classes (full expansion) and individual methods

**Python support:** Works. Extracts functions and imports correctly.

### Token Economics Summary

| Approach | Tokens | Use Case |
|----------|--------|----------|
| Grep (exact lookup) | ~200 | Known symbol name |
| smart_outline (file map) | ~1,500 | "What's in this file?" |
| smart_unfold (single symbol) | ~1,600 | "Show me this function" |
| smart_search (exploration) | ~2,000-6,000 | "How does X work?" |
| Read (full file) | ~12,000+ | When you truly need everything |
| Explore agent (multi-round) | ~20,000-40,000 | Same as smart_search, 6-12x more expensive |

---

## Part 2: Skill Recommendation

### Proposed Skill: `smart-explore`

Modeled on `mem-search`'s 3-layer progressive disclosure workflow.

### 3-Layer Workflow (ALWAYS Follow)

**NEVER read a full file when smart_outline + smart_unfold achieves the same understanding at 8x fewer tokens.**

#### Step 1: Explore — Find Relevant Symbols

Use `smart_search`:

```
smart_search(query="shutdown", path="./src", max_results=15)
```

**Returns:** Ranked symbols with signatures, line numbers, match reasons, plus folded file views (~2-6k tokens)

```
── Matching Symbols ──
  function performGracefulShutdown (services/infrastructure/GracefulShutdown.ts:56)
  function httpShutdown (services/infrastructure/HealthMonitor.ts:92)
  method WorkerService.shutdown (services/worker-service.ts:846)
  ...

── Folded File Views ──
  services/infrastructure/GracefulShutdown.ts (7 symbols)
  services/worker-service.ts (12 symbols)
  ...
```

**Parameters:**
- `query` (string) — What to search for (function name, concept, class name)
- `path` (string) — Root directory to search (defaults to cwd)
- `max_results` (number) — Max matching symbols, default 20, max 50
- `file_pattern` (string, optional) — Filter to specific files/paths

#### Step 2: Outline — Get File Structure (Optional)

Use `smart_outline` when you need deeper structural context for a specific file:

```
smart_outline(file_path="services/worker-service.ts", path="./src")
```

**Returns:** Complete structural skeleton — all functions, classes, methods, properties, imports (~1-2k tokens per file)

**Skip this step** when Step 1's folded file views already provide enough structure. This step is most useful for files not covered by the search results.

**Parameters:**
- `file_path` (string) — Path to the file
- `path` (string) — Root directory to resolve relative paths

#### Step 3: Unfold — See Implementation

Review symbols from Steps 1-2. Pick the ones you need. Unfold only those:

```
smart_unfold(file_path="services/worker-service.ts", symbol_name="shutdown", path="./src")
```

**Returns:** Full source code of the specified symbol including JSDoc, decorators, and complete implementation (~1-7k tokens depending on symbol size)

**Parameters:**
- `file_path` (string) — Path to the file (as returned by search/outline)
- `symbol_name` (string) — Name of the function/class/method to expand
- `path` (string) — Root directory to resolve relative paths

### When to Use smart-explore

- "How does shutdown work?" — cross-cutting exploration
- "What's in worker-service.ts?" — file structure understanding
- "Show me the startSessionProcessor method" — targeted implementation
- Understanding an unfamiliar area of the codebase
- Replacing multi-round Grep-Read-Grep-Read exploration cycles

### When NOT to Use smart-explore

- **Exact name lookup** ("where is `ensureWorkerStarted` defined?") — use Grep
- **String literal search** ("find all TODO comments") — use Grep
- **Small files** (under ~100 lines) — use Read directly
- **File path search** ("find all test files") — use Glob

### Examples

**Understand a cross-cutting concern:**

```
1. smart_search(query="shutdown", path="./src")
   → 14 symbols across 7 files, full picture in one call
2. smart_unfold(file_path="services/infrastructure/GracefulShutdown.ts", symbol_name="performGracefulShutdown")
   → See the core implementation
```

**Navigate a large file:**

```
1. smart_outline(file_path="services/worker-service.ts")
   → 1,466 tokens: 12 functions, WorkerService class with 24 members
2. smart_unfold(file_path="services/worker-service.ts", symbol_name="startSessionProcessor")
   → 1,610 tokens: the specific method you need
Total: ~3,076 tokens vs ~12,000 to Read the full file
```

**Exploration then precision:**

```
1. smart_search(query="session", path="./src", max_results=10)
   → 10 ranked symbols: SessionMetadata, SessionQueueProcessor, SessionSummary...
2. Pick the relevant one, unfold it
```

### Why This Workflow?

- **smart_search index:** ~2,000-6,000 tokens (ranked, structural)
- **smart_outline:** ~1,500 tokens per file (vs ~12,000 for Read)
- **smart_unfold:** ~1,600 tokens per symbol (targeted extraction)
- **Read full file:** ~12,000+ tokens (brute force)
- **Explore agent:** ~20,000-40,000 tokens (6-10 tool rounds)
- **8x token savings** on file understanding via outline + unfold vs Read
- **6-12x token savings** on exploration vs Explore agent
