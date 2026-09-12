# Plan: Five trivial fixes from v12.4.1 issue triage

## Scope
Five single-edit fixes for issues confirmed unaddressed in v12.4.1. Each is ≤ 10 lines.
Branch: current (`automated-issue-review-and-closure-for-v12.3.9+`).
Target version: v12.4.2.

## Phase 0: Allowed APIs / known-good patterns (verified)

| Fix | File | Confirmed location |
|---|---|---|
| #2092 | `scripts/build-hooks.js:178` | banner emits `import.meta.url` into `.cjs` (invalid in CJS) |
| #2100 | `plugin/hooks/hooks.json:68` | PreToolUse Read hook has `"timeout": 2000` (seconds, plainly a typo for 200) |
| #2131 | `plugin/hooks/hooks.json` | every hook command object lacks `"shell": "bash"` |
| #2132 | `src/services/integrations/McpIntegrations.ts:188` | hardcoded `'.agent'` should be `'.agents'` |
| #2088 | `src/services/worker/SDKAgent.ts:139`, `KnowledgeAgent.ts:75`, `KnowledgeAgent.ts:190` | three `query({ options: { ... } })` calls missing `mcpServers: {}` (Claude Agent SDK option to suppress global MCP inheritance) |

**Anti-patterns to avoid:**
- Do not "tidy" surrounding code — these are scoped fixes only.
- Do not change `"timeout"` semantics elsewhere in `hooks.json`.
- Do not add `mcpServers: {}` to `query()` calls outside the three identified sites without re-verifying.
- Do not edit `cursor-hooks/hooks.json` (separate Cursor-specific file with different structure).

## Phase 1: Apply the five fixes

### 1.1 — #2092 Fix the worker-service.cjs banner (build-time)
**File**: `scripts/build-hooks.js`
**Change**: Replace `'var __filename = require("node:url").fileURLToPath(import.meta.url);'` and the following `__dirname` line with CJS-safe equivalents.
**New banner content**:
```js
'#!/usr/bin/env bun',
'var __filename = __filename || require("node:path").resolve(process.argv[1] || "");',
'var __dirname = __dirname || require("node:path").dirname(__filename);'
```
Rationale: in a `.cjs` bundle, `__filename`/`__dirname` are already CJS globals; the OR-fallback only kicks in when esbuild's bundling has shadowed them. `import.meta.url` is illegal in CJS and produces the syntax error reporter cited.

### 1.2 — #2100 Fix PreToolUse Read hook timeout
**File**: `plugin/hooks/hooks.json`
**Change**: line 68, `"timeout": 2000` → `"timeout": 60` (matches PostToolUse and other hook timeouts; 60s is consistent with the `[1..20]` curl loop budget the file-context handler uses).

### 1.3 — #2131 Add `"shell": "bash"` to every hook on Windows
**File**: `plugin/hooks/hooks.json`
**Change**: For every command-type hook entry, insert `"shell": "bash",` immediately after the `"type": "command",` line.
- ~10 hook entries total (Setup, SessionStart×3, UserPromptSubmit, PostToolUse, PreToolUse, Stop, SessionEnd).
- No-op on macOS/Linux; routes to Git Bash on Windows.

### 1.4 — #2132 Antigravity directory typo
**File**: `src/services/integrations/McpIntegrations.ts`
**Change**: line 188, `'.agent'` → `'.agents'` (single-character fix per reporter's filed bug; matches Antigravity's actual `.agents/rules` convention).

### 1.5 — #2088 Suppress MCP server inheritance in worker SDK sessions
**Files & lines**:
- `src/services/worker/SDKAgent.ts:139` — inside `query({ options: { ... } })`, add `mcpServers: {},`
- `src/services/worker/knowledge/KnowledgeAgent.ts:75` — same
- `src/services/worker/knowledge/KnowledgeAgent.ts:190` — same

Insert as last property before closing brace of `options: { … }`. Trailing comma OK.
Rationale: Claude Agent SDK's `query()` inherits the user's global `mcp.json` by default. Passing `mcpServers: {}` explicitly clears that inheritance so observer/knowledge sessions don't load Serena, etc.

### Phase 1 verification
- `git diff --stat` should show exactly 5 files changed.
- `node -c plugin/scripts/worker-service.cjs` after rebuild → no SyntaxError.
- `grep -c '"shell": "bash"' plugin/hooks/hooks.json` should equal the count of `"type": "command"` entries.
- `grep -c '\.agents' src/services/integrations/McpIntegrations.ts` ≥ 1; `grep -c "'\.agent'" src/services/integrations/McpIntegrations.ts` should be 0 for the corrected line.
- `grep -c "mcpServers: {}" src/services/worker/SDKAgent.ts src/services/worker/knowledge/KnowledgeAgent.ts` should sum to 3.

## Phase 2: Build, verify, commit

1. Run `npm run build-and-sync`.
2. After build, sanity-check the rebuilt artifact: `node -c plugin/scripts/worker-service.cjs` must succeed.
3. Confirm `plugin/scripts/worker-service.cjs` first 3 lines no longer contain `import.meta.url`.
4. Stage and commit with message:
   ```
   fix: 5 trivial bugs from v12.4.1 issue triage

   - #2092: emit CJS-safe banner (no import.meta.url) in worker-service.cjs
   - #2100: PreToolUse Read hook timeout 2000s → 60s
   - #2131: add "shell": "bash" to every hook for Windows compat
   - #2132: Antigravity dir typo .agent → .agents
   - #2088: clear inherited MCP servers in worker SDK query() calls
   ```

## Phase 3: Ship v12.4.2 and close issues

Use the `claude-mem:version-bump` skill / standard release workflow:
1. Bump version to **12.4.2** across all 6 manifests.
2. Rebuild distribution artifacts.
3. Tag, push, npm publish, GitHub release.
4. Update CHANGELOG.
5. Close issues #2092, #2100, #2131, #2132, #2088 with comments citing v12.4.2.

## Out of scope (intentionally left for later)
- #2094 file-context truncation — needs design call, not trivial.
- #2090/#2095 hook exit codes — already partially addressed in v12.4 hooks.json rewrite; pending reporter reverification.
- All other KEEP_OPEN issues from the v2 triage report.
