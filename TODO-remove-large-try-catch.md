# TODO: Remove Large Try-Catch Blocks

**Goal**: Remove all 43 large try-catch blocks to let underlying issues surface naturally instead of being hidden.

**Approach**: Simply remove the try-catch wrapper and let the code run without it. Any real errors will bubble up and reveal themselves.

---

## Files to Process (43 blocks total)

### 1. src/bin/import-xml-observations.ts (3 blocks)
- [ ] Line 62 - 12 lines
- [ ] Line 134 - 15 lines
- [ ] Line 167 - 13 lines

### 2. src/servers/mcp-server.ts (2 blocks)
- [ ] Line 52 - 14 lines
- [ ] Line 97 - 21 lines

### 3. src/services/sqlite/SessionStore.ts (8 blocks)
- [ ] Line 55 - **67 lines** (LARGEST)
- [ ] Line 227 - 38 lines
- [ ] Line 346 - 40 lines
- [ ] Line 427 - 43 lines
- [ ] Line 495 - 15 lines
- [ ] Line 532 - 35 lines
- [ ] Line 599 - 13 lines
- [ ] Line 1550 - 27 lines

### 4. src/services/worker-service.ts (5 blocks)
- [ ] Line 441 - 16 lines
- [ ] Line 529 - 11 lines
- [ ] Line 672 - **56 lines** (VERY LARGE)
- [ ] Line 820 - 15 lines
- [ ] Line 1644 - 24 lines
- [ ] Line 1759 - 28 lines

### 5. src/services/sync/ChromaSync.ts (4 blocks)
- [ ] Line 99 - 28 lines
- [ ] Line 341 - 14 lines
- [ ] Line 531 - 32 lines
- [ ] Line 606 - **106 lines** (LARGEST - CRITICAL)

### 6. src/services/worker/GeminiAgent.ts (1 block)
- [ ] Line 144 - **77 lines** (VERY LARGE)

### 7. src/services/worker/OpenRouterAgent.ts (1 block)
- [ ] Line 104 - **78 lines** (VERY LARGE)

### 8. src/services/worker/BranchManager.ts (2 blocks)
- [ ] Line 120 - 13 lines
- [ ] Line 268 - 21 lines

### 9. src/services/worker/SearchManager.ts (13 blocks - MOST AFFECTED FILE)
- [ ] Line 120 - 43 lines
- [ ] Line 382 - 13 lines
- [ ] Line 642 - 22 lines
- [ ] Line 726 - 18 lines
- [ ] Line 818 - 14 lines
- [ ] Line 888 - 16 lines
- [ ] Line 958 - 16 lines
- [ ] Line 1028 - 16 lines
- [ ] Line 1098 - 16 lines
- [ ] Line 1181 - 17 lines
- [ ] Line 1282 - 16 lines
- [ ] Line 1493 - **147 lines** (ABSOLUTELY MASSIVE - HIGHEST PRIORITY)
- [ ] Line 1725 - 15 lines

### 10. src/services/worker/http/routes/SessionRoutes.ts (2 blocks)
- [ ] Line 151 - 13 lines
- [ ] Line 185 - 20 lines

### 11. src/services/context-generator.ts (1 block)
- [ ] Line 182 - 15 lines

---

## Priority Order (Start with largest/riskiest first)

1. **CRITICAL** - SearchManager.ts:1493 (147 lines) - This is hiding a LOT
2. **CRITICAL** - ChromaSync.ts:606 (106 lines) - Vector DB operations
3. **HIGH** - OpenRouterAgent.ts:104 (78 lines) - AI agent core logic
4. **HIGH** - GeminiAgent.ts:144 (77 lines) - AI agent core logic
5. **HIGH** - SessionStore.ts:55 (67 lines) - Database operations
6. **HIGH** - worker-service.ts:672 (56 lines) - Core service logic
7. **MEDIUM** - All remaining blocks (43 lines or less)

---

## Process for Each Block

For each try-catch block:

1. **Read the file** to understand the context
2. **Locate the try-catch block** at the specified line
3. **Remove the try `{`** line
4. **Un-indent the code** that was inside the try block
5. **Remove the entire catch block** (from `} catch` to the final `}`)
6. **Save the file**

The code will now run without the safety net. Any errors that occur will propagate naturally and reveal themselves.

---

## After Removal

Once all blocks are removed:

- [ ] Run `bun run scripts/detect-error-handling-antipatterns.ts` to verify 0 large blocks
- [ ] Run `npm run build` to see what errors surface
- [ ] Address any real errors that are revealed
- [ ] Commit changes with message: "refactor: remove 43 large try-catch blocks to expose hidden errors"

---

## Notes

- **DO NOT** add new try-catch blocks to "fix" errors that surface
- **DO** let errors propagate naturally
- **DO** fix the root cause of any errors that appear
- If an operation genuinely needs error handling, make it **specific** (< 10 lines) with proper logging
