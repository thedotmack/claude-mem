# Fix MCP Server Crash

## Root Cause

The MCP server crashes immediately on startup with:

```
TypeError [ERR_INVALID_ARG_VALUE]: The argument 'filename' must be a file URL object,
file URL string, or absolute path string. Received undefined
    at createRequire (node:internal/modules/cjs/loader:1945:11)
    at Object.<anonymous> (plugin/scripts/mcp-server.cjs:57:6154)
```

**Cause chain:**
1. `src/services/smart-file-read/parser.ts:17` has `const require = createRequire(import.meta.url)`
2. esbuild bundles mcp-server.ts to CJS format (`format: 'cjs'` in `scripts/build-hooks.js:135`)
3. In CJS output, esbuild replaces `import.meta` with `{}`, so `import.meta.url` becomes `undefined`
4. `createRequire(undefined)` throws at module load time, crashing the entire MCP server
5. All existing memory tools (search, timeline, get_observations, save_observation) are also broken because the server never starts

**Where `require` is used in parser.ts:**
- Line 90: `require.resolve(pkg + "/package.json")` — resolves grammar package paths
- Line 202: `require.resolve("tree-sitter-cli/package.json")` — resolves CLI binary path

Both have try/catch fallbacks. The crash happens before either is called — at the top-level `createRequire()` on line 17.

## Phase 1: Fix the CJS Bundling Crash

**File:** `src/services/smart-file-read/parser.ts`

**Change:** Replace the module-level `createRequire(import.meta.url)` with a CJS-compatible approach.

Replace lines 15-17:
```typescript
import { createRequire } from "node:module";
// (blank)
const require = createRequire(import.meta.url);
```

With:
```typescript
import { createRequire } from "node:module";

// CJS-safe require for resolving external packages at runtime.
// In ESM: import.meta.url works. In CJS bundle (esbuild): __filename works.
// Using typeof check avoids ReferenceError in ESM where __filename doesn't exist.
const _require = typeof __filename !== 'undefined'
  ? createRequire(__filename)
  : createRequire(import.meta.url);
```

Then rename all `require.resolve(...)` calls in parser.ts to `_require.resolve(...)` (2 occurrences at lines 90 and 202).

**Verification:**
1. `node plugin/scripts/mcp-server.cjs` should NOT crash (pipe stdin to avoid hanging on stdio)
2. All existing memory tools should work again

## Phase 2: Rebuild and Deploy

1. Run `npm run build-and-sync`
2. Verify MCP server starts: `echo '' | timeout 3 node plugin/scripts/mcp-server.cjs 2>&1`
3. Verify worker health: `curl -s http://localhost:37777/api/health`
4. Verify existing memory tools work via MCP

## Notes

- The smart_search/smart_unfold/smart_outline tools require tree-sitter CLI + grammar packages installed at the deployment location. The build script already adds these to `plugin/package.json` as dependencies (lines 62-71 in build-hooks.js). They should work after `bun install` runs during sync.
- tree-sitter CLI is NOT on the system PATH (confirmed: `which tree-sitter` returned not found), but the code falls back to resolving from `tree-sitter-cli` npm package (line 202 in parser.ts), which IS listed as an external + runtime dependency.
