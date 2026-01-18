# OpenCode Support Implementation Plan

## Phase 0: Documentation Discovery (Consolidated)

### Sources Consulted

| Source | Type | Key Findings |
|--------|------|--------------|
| https://opencode.ai/docs/plugins/ | Official Docs | Plugin structure, events, hooks, tool API |
| Context7 `/anomalyco/opencode` | SDK Docs | Session API, context injection patterns |
| Context7 `/sst/opencode-sdk-js` | SDK Reference | `client.session.prompt()` API |
| johnlindquist/opencode-plugins-guide.md | Community Guide | Complete patterns, state management |
| `~/.config/opencode/superpowers/.opencode/plugin/superpowers.js` | Working Example | Real implementation patterns |
| `/Users/mac-main/claude-mem/src/cli/adapters/claude-code.ts` | Reference Adapter | Field mappings, output format |
| `/Users/mac-main/claude-mem/src/cli/adapters/cursor.ts` | Reference Adapter | Alternative field mappings |

### Allowed APIs (Verified from Documentation)

#### OpenCode Plugin API

```typescript
// Plugin export signature (from @opencode-ai/plugin)
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async ({ client, project, directory, worktree, $ }) => {
  return {
    tool: { /* custom tools */ },
    event: async ({ event }) => { /* generic event handler */ },
    "tool.execute.after": async (input, output) => { /* after tool hook */ },
    "experimental.chat.system.transform": async (input, output) => { /* system prompt */ },
  }
}
```

#### Context Injection API (from SDK docs)

```typescript
// Inject context without triggering AI response
await client.session.prompt({
  path: { id: sessionId },
  body: {
    noReply: true,
    parts: [{ type: "text", text: contextContent, synthetic: true }]
  }
})
```

#### Tool Definition API

```typescript
import { tool } from "@opencode-ai/plugin"

mytool: tool({
  description: "Tool description",
  args: {
    param: tool.schema.string().describe("Parameter description")
  },
  async execute(args, context) {
    const { sessionID, messageID, agent } = context
    return "result string"
  }
})
```

#### Event Types (from official docs)

**Session Events:** `session.created`, `session.compacted`, `session.deleted`, `session.idle`, `session.error`, `session.status`, `session.updated`

**Tool Events:** `tool.execute.before`, `tool.execute.after`

**File Events:** `file.edited`, `file.watcher.updated`

#### Session ID Extraction Pattern (from superpowers.js)

```typescript
const getSessionID = (event: any): string | undefined => {
  return event.properties?.info?.id ||
         event.properties?.sessionID ||
         event.session?.id ||
         (event as any).session_id
}
```

#### tool.execute.after Hook Signature

```typescript
"tool.execute.after": async (input, output) => {
  // input: { tool: string, sessionID: string, callID: string }
  // output: { title: string, output: string, metadata: any }
}
```

### Claude-mem Adapter API (from source code)

```typescript
// src/cli/types.ts
export interface PlatformAdapter {
  normalizeInput(raw: unknown): NormalizedHookInput;
  formatOutput(result: HookResult): unknown;
}

export interface NormalizedHookInput {
  sessionId: string;
  cwd: string;
  platform?: string;
  prompt?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  transcriptPath?: string;
  filePath?: string;
  edits?: unknown[];
}

export interface HookResult {
  continue?: boolean;
  suppressOutput?: boolean;
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
  exitCode?: number;
}
```

### Anti-Patterns to Avoid

| Anti-Pattern | Why It's Wrong | Correct Approach |
|--------------|----------------|------------------|
| `async (client) => {}` | Context is object, not client | `async ({ client }) => {}` |
| `event.sessionId` | Field doesn't exist | Use `event.properties?.sessionID` |
| `client.session.message()` | Method doesn't exist | Use `client.session.prompt()` |
| `tool.schema.object()` | Not available | Use individual field schemas |
| `output.args` in tool.execute.after | Args are in input | `input.tool`, `input.sessionID` |

---

## Phase 1: Create OpenCode Adapter

### Goal
Create `src/cli/adapters/opencode.ts` that maps OpenCode's data format to claude-mem's `NormalizedHookInput`.

### Documentation References
- **Copy from:** `src/cli/adapters/raw.ts:5-21` (minimal adapter template)
- **Field mapping reference:** `src/cli/adapters/cursor.ts:5-22` (alternative field names)
- **Router pattern:** `src/cli/adapters/index.ts:6-13` (switch statement)

### Implementation Steps

1. **Create adapter file** at `src/cli/adapters/opencode.ts`:
   ```typescript
   // Copy structure from raw.ts, customize field mappings for OpenCode
   import type { PlatformAdapter, NormalizedHookInput, HookResult } from '../types.js';

   export const opencodeAdapter: PlatformAdapter = {
     normalizeInput(raw: unknown): NormalizedHookInput {
       const r = (raw ?? {}) as Record<string, unknown>;
       return {
         sessionId: (r.sessionId ?? r.sessionID ?? r.session_id ?? 'unknown') as string,
         cwd: (r.cwd ?? r.directory ?? process.cwd()) as string,
         prompt: r.prompt as string | undefined,
         toolName: r.toolName as string | undefined,
         toolInput: r.toolInput,
         toolResponse: r.toolResponse ?? r.toolOutput,
         // OpenCode doesn't provide transcriptPath
       };
     },
     formatOutput(result: HookResult): unknown {
       // OpenCode expects simpler response like Cursor
       if (result.hookSpecificOutput) {
         return { context: result.hookSpecificOutput.additionalContext };
       }
       return { continue: result.continue ?? true };
     }
   };
   ```

2. **Update router** at `src/cli/adapters/index.ts`:
   - Add import: `import { opencodeAdapter } from './opencode.js';`
   - Add case: `case 'opencode': return opencodeAdapter;`

### Verification Checklist

```bash
# 1. Build the project
cd /Users/mac-main/claude-mem && npm run build

# 2. Test context event
echo '{"sessionId":"test123","cwd":"/tmp"}' | bun plugin/scripts/worker-service.cjs hook opencode context
# Expected: {"context":"..."} or {"hookSpecificOutput":{...}}

# 3. Test observation event
echo '{"sessionId":"test123","cwd":"/tmp","toolName":"Read","toolInput":{"file":"/tmp/x"},"toolOutput":"contents"}' | bun plugin/scripts/worker-service.cjs hook opencode observation
# Expected: {"continue":true}

# 4. Grep for opencode in built output
grep -r "opencode" plugin/scripts/worker-service.cjs | head -5
```

### Anti-Pattern Guards
- Do NOT invent field names not in OpenCode's event payloads
- Do NOT add `transcriptPath` (OpenCode doesn't provide it)
- Do NOT add complex output formatting (keep it simple like Cursor)

---

## Phase 2: Create OpenCode Plugin

### Goal
Create `.opencode/plugin/claude-mem.ts` that:
1. Injects context on `session.created`
2. Captures observations on `tool.execute.after`
3. Provides MCP-like search tools

### Documentation References
- **Plugin structure:** https://opencode.ai/docs/plugins/ → "Basic structure" section
- **Context injection:** Context7 `/anomalyco/opencode` → "Inject context without triggering AI response"
- **Tool definition:** https://opencode.ai/docs/plugins/ → "Custom tools" section
- **Session ID extraction:** `~/.config/opencode/superpowers/.opencode/plugin/superpowers.js:192-196`

### Implementation Steps

1. **Create plugin directory:**
   ```bash
   mkdir -p /Users/mac-main/claude-mem/.opencode/plugin
   ```

2. **Create plugin file** at `.opencode/plugin/claude-mem.ts`:
   ```typescript
   import type { Plugin } from "@opencode-ai/plugin"
   import { tool } from "@opencode-ai/plugin"

   const WORKER_URL = "http://localhost:37777"

   // Helper to extract session ID from various event shapes
   const getSessionID = (event: any): string | undefined => {
     return event.properties?.info?.id ||
            event.properties?.sessionID ||
            event.session?.id ||
            (event as any).session_id
   }

   export const ClaudeMemPlugin: Plugin = async ({ client, directory }) => {
     const projectName = directory.split('/').pop() || 'unknown'

     // Helper to call claude-mem worker API
     async function callWorker(endpoint: string, body: object): Promise<any> {
       try {
         const res = await fetch(`${WORKER_URL}${endpoint}`, {
           method: 'POST',
           headers: { 'Content-Type': 'application/json' },
           body: JSON.stringify(body)
         })
         return res.ok ? await res.json() : null
       } catch {
         return null // Worker not running
       }
     }

     // Inject context into session
     async function injectContext(sessionId: string): Promise<void> {
       const context = await callWorker('/api/context/inject', {
         sessionId,
         cwd: directory,
         project: projectName
       })
       if (context?.additionalContext) {
         await client.session.prompt({
           path: { id: sessionId },
           body: {
             noReply: true,
             parts: [{ type: "text", text: context.additionalContext, synthetic: true }]
           }
         })
       }
     }

     return {
       // Memory search tools
       tool: {
         mem_search: tool({
           description: "Search claude-mem memory for past observations",
           args: {
             query: tool.schema.string().describe("Search query")
           },
           async execute(args, ctx) {
             const result = await callWorker('/api/search', {
               query: args.query,
               project: projectName,
               sessionId: ctx.sessionID
             })
             return result ? JSON.stringify(result, null, 2) : "No results found"
           }
         })
       },

       // Event handlers
       event: async ({ event }) => {
         const sessionId = getSessionID(event)
         if (!sessionId) return

         if (event.type === 'session.created') {
           await callWorker('/api/sessions/init', {
             sessionId,
             cwd: directory,
             project: projectName
           })
           await injectContext(sessionId)
         }

         if (event.type === 'session.compacted') {
           // Re-inject context after compaction
           await injectContext(sessionId)
         }
       },

       // Capture tool observations
       "tool.execute.after": async (input, output) => {
         await callWorker('/api/sessions/observations', {
           sessionId: input.sessionID,
           cwd: directory,
           toolName: input.tool,
           toolInput: output.metadata,
           toolOutput: output.output
         })
       }
     }
   }
   ```

3. **Create package.json** at `.opencode/package.json`:
   ```json
   {
     "dependencies": {
       "@opencode-ai/plugin": "latest"
     }
   }
   ```

### Verification Checklist

```bash
# 1. Verify worker is running
curl -s http://localhost:37777/health
# Expected: {"status":"ok",...}

# 2. Symlink for testing (if not in project directory)
# Plugin will be auto-loaded from .opencode/plugin/

# 3. Start OpenCode in project directory
cd /Users/mac-main/claude-mem && opencode

# 4. In OpenCode, start a new session and verify:
#    - Context injection message appears (check with /debug or logs)
#    - After using a tool, check database for observation

# 5. Verify observation captured
sqlite3 ~/.claude-mem/claude-mem.db "SELECT id, tool_name, created_at FROM observations ORDER BY id DESC LIMIT 3"

# 6. Test mem_search tool in OpenCode
# Type: "Use mem_search to find recent observations"
```

### Anti-Pattern Guards
- Do NOT use `client.session.message()` - use `client.session.prompt()`
- Do NOT destructure context incorrectly: use `async ({ client })` not `async (client)`
- Do NOT assume `event.sessionId` exists - use the extraction helper
- Do NOT block on worker errors - gracefully handle missing worker

---

## Phase 3: Integration Testing

### Goal
Verify end-to-end functionality with both platforms sharing the same database.

### Test Cases

1. **Context injection test:**
   - Start OpenCode session
   - Verify context from previous Claude Code sessions appears
   - Check logs for injection success

2. **Observation capture test:**
   - Use Read tool in OpenCode
   - Query database: `SELECT * FROM observations WHERE platform='opencode' ORDER BY id DESC LIMIT 1`
   - Verify tool_name, tool_input, tool_output populated

3. **Cross-platform memory test:**
   - Create observation in OpenCode session
   - Start new Claude Code session in same project
   - Verify OpenCode observation appears in context

4. **Search tool test:**
   - In OpenCode, invoke: "Use mem_search to find observations about [topic]"
   - Verify search results returned

### Verification Commands

```bash
# Check observations are being captured
sqlite3 ~/.claude-mem/claude-mem.db "
  SELECT id, session_id, tool_name, platform, created_at
  FROM observations
  ORDER BY id DESC LIMIT 10
"

# Check sessions are being initialized
sqlite3 ~/.claude-mem/claude-mem.db "
  SELECT id, project, platform, created_at
  FROM sessions
  ORDER BY id DESC LIMIT 5
"

# Check worker logs
tail -50 ~/.claude-mem/logs/worker.log | grep -i opencode
```

### Anti-Pattern Guards
- Do NOT test from inside OpenCode (run tests from Claude Code or terminal)
- Do NOT assume worker is running - check health endpoint first
- Do NOT skip database verification - it's the source of truth

---

## Phase 4: Documentation and PR Preparation

### Goal
Create installation docs and prepare for upstream PR.

### Files to Create

1. **`.opencode/INSTALL.md`** - Installation instructions:
   ```markdown
   # Claude-Mem for OpenCode

   ## Prerequisites
   - Claude-Mem installed and worker running (`curl localhost:37777/health`)
   - OpenCode installed

   ## Installation

   1. Copy plugin to OpenCode config:
      ```bash
      cp -r .opencode/plugin/claude-mem.ts ~/.config/opencode/plugin/
      cp .opencode/package.json ~/.config/opencode/
      ```

   2. Install dependencies:
      ```bash
      cd ~/.config/opencode && bun install
      ```

   3. Restart OpenCode

   ## Verification
   - Start new session, check for context injection
   - Use a tool, verify observation in database
   ```

2. **`docs/public/platforms/opencode.mdx`** - Public documentation

3. **Update `README.md`** - Add OpenCode to supported platforms list

### PR Checklist

- [ ] Feature branch created: `feature/opencode-support`
- [ ] All tests passing
- [ ] Adapter code follows existing patterns
- [ ] Plugin code documented
- [ ] INSTALL.md complete
- [ ] README updated
- [ ] No breaking changes to existing platforms

### Verification Commands

```bash
# Verify branch
git branch --show-current
# Expected: feature/opencode-support

# Verify no lint errors
npm run lint

# Verify build succeeds
npm run build

# Verify tests pass
npm test

# Check files changed
git diff --stat main
```

---

## Summary: File Changes Required

### Must Create
| File | Purpose |
|------|---------|
| `src/cli/adapters/opencode.ts` | Platform adapter |
| `.opencode/plugin/claude-mem.ts` | OpenCode plugin |
| `.opencode/package.json` | Plugin dependencies |
| `.opencode/INSTALL.md` | Installation guide |

### Must Modify
| File | Change |
|------|--------|
| `src/cli/adapters/index.ts` | Add opencode case to router |
| `README.md` | Add OpenCode to platforms list |

### May Create (for completeness)
| File | Purpose |
|------|---------|
| `docs/public/platforms/opencode.mdx` | Public docs |

---

## Execution Notes

- **Run from:** Claude Code CLI or Codex CLI (NOT OpenCode)
- **Test in:** Separate OpenCode instance in another terminal
- **Worker:** Assumes already running (Claude Code manages it)
- **Database:** Shared at `~/.claude-mem/claude-mem.db`
