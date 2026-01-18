# OpenCode Support for claude-mem

## Task Entry Point

**Forked Repo:** `/Users/mac-main/claude-mem`  
**Upstream:** `https://github.com/thedotmack/claude-mem`  
**Goal:** Add official OpenCode.ai platform support, following existing patterns for Claude Code and Cursor

**IMPORTANT:** Run this session from **Claude Code CLI** or **Codex CLI** - NOT OpenCode. This enables objective analysis of OpenCode's plugin system from an outside perspective, avoiding assumptions that could arise from being inside the target platform.

---

## Context Summary

Claude-mem already supports multiple platforms via an **adapter pattern**:
- `src/cli/adapters/claude-code.ts` - Claude Code adapter
- `src/cli/adapters/cursor.ts` - Cursor adapter  
- `src/cli/adapters/index.ts` - Platform router

The CLI accepts: `bun worker-service.cjs hook <platform> <event>`

Where `<platform>` is `claude-code`, `cursor`, or `raw`.

**Your task:** Add `opencode` as a new platform.

---

## Key Decisions (Already Made)

1. **Shared data**: Use existing `~/.claude-mem/` database (shared with Claude Code)
2. **Worker lifecycle**: Assume worker is already running (Claude Code manages it)
3. **Error handling**: User-visible errors (not silent failures)
4. **Upstream contribution**: Structure for PR to `thedotmack/claude-mem`

---

## What I Know (Verified)

### Repository Structure
```
/Users/mac-main/claude-mem/
├── src/
│   ├── cli/
│   │   ├── adapters/           # Platform adapters (add opencode.ts here)
│   │   │   ├── claude-code.ts  # Reference implementation
│   │   │   ├── cursor.ts       # Another reference
│   │   │   └── index.ts        # Router - needs opencode case
│   │   ├── handlers/           # Event handlers (context, observation, etc.)
│   │   ├── hook-command.ts     # CLI entry point
│   │   └── types.ts            # NormalizedHookInput, HookResult, PlatformAdapter
│   └── services/
│       └── worker-service.ts   # Main worker service
├── plugin/
│   ├── hooks/
│   │   └── hooks.json          # Claude Code hook definitions
│   └── scripts/                # Built scripts
├── cursor-hooks/               # Cursor-specific integration docs
└── docs/
```

### CLI Interface
```bash
# Command pattern
bun plugin/scripts/worker-service.cjs hook <platform> <event>

# Events: context, observation, summarize, session-init, user-message
# Platforms: claude-code, cursor, raw (add: opencode)
```

### Platform Adapter Interface
```typescript
// From src/cli/types.ts
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
}
```

### OpenCode Plugin System (from docs)
- Plugins export async functions returning `{ tool: {...}, event: async ({event}) => {...} }`
- Events: `session.created`, `tool.execute.after`, `session.idle`, `session.compacted`
- Uses `@opencode-ai/plugin` package for tool definitions
- Reference: `~/.config/opencode/superpowers/.opencode/plugin/superpowers.js`

---

## What You Need to Investigate

### 1. OpenCode Event/Data Format
- What data does OpenCode pass to plugins on each event?
- How to extract: session ID, project path, tool name, tool result
- **Read the Superpowers plugin source:** `~/.config/opencode/superpowers/.opencode/plugin/superpowers.js`
- **Fetch OpenCode plugin docs:** `https://opencode.ai/docs/plugins/`
- **Check OpenCode SDK types** if available in `@opencode-ai/plugin` package

### 2. Worker CLI Compatibility  
- Run: `cd /Users/mac-main/claude-mem && bun plugin/scripts/worker-service.cjs --help`
- Verify CLI accepts platform argument
- Test with: `echo '{}' | bun plugin/scripts/worker-service.cjs hook raw context`

### 3. Context Injection
- How does OpenCode inject context into sessions?
- Superpowers uses `client.session.prompt()` - verify this works for claude-mem context

### 4. Build System
- How are adapters built? Check `package.json` scripts
- Does adding `opencode.ts` require build step changes?

---

## Implementation Approach

### Option A: CLI Adapter Only (Minimal)
Add `src/cli/adapters/opencode.ts` and update router. OpenCode plugin calls CLI directly.

**Pros:** Minimal changes, follows existing pattern  
**Cons:** Requires separate OpenCode plugin file

### Option B: Full Integration (Like Cursor)
Create `.opencode/` directory with:
- Plugin file (JS/TS)
- INSTALL.md
- Platform adapter

**Pros:** Complete upstream contribution  
**Cons:** More work, need to understand OpenCode plugin packaging

### Recommendation
Start with Option A to validate the integration works, then expand to Option B.

---

## Files to Create/Modify

### Must Create
1. `src/cli/adapters/opencode.ts` - Platform adapter

### Must Modify  
1. `src/cli/adapters/index.ts` - Add opencode case to router
2. `src/cli/types.ts` - Add opencode-specific fields if needed

### Should Create (for upstream PR)
1. `.opencode/plugin/claude-mem.js` - OpenCode plugin
2. `.opencode/INSTALL.md` - Installation instructions
3. `docs/README.opencode.md` - Platform-specific docs

---

## Testing Strategy

### 1. Unit Test Adapter
```bash
cd /Users/mac-main/claude-mem
echo '{"sessionId":"test","cwd":"/tmp"}' | bun plugin/scripts/worker-service.cjs hook opencode context
```

### 2. Integration Test
```bash
# Symlink plugin for testing
ln -sf /Users/mac-main/claude-mem/.opencode/plugin/claude-mem.js ~/.config/opencode/plugin/claude-mem.js

# Restart OpenCode, start new session, verify:
# - Context injected on session start
# - Observations captured after tool use
# - Search tools work (mem_search, etc.)
```

### 3. Verify Shared Data
```bash
# Check observations appear in database
sqlite3 ~/.claude-mem/claude-mem.db "SELECT * FROM observations ORDER BY id DESC LIMIT 5"
```

---

## Reference Files to Study

### In the claude-mem repo (`/Users/mac-main/claude-mem/`)
| File | Purpose |
|------|---------|
| `src/cli/adapters/claude-code.ts` | Reference adapter implementation |
| `src/cli/adapters/cursor.ts` | Alternative adapter with different field mapping |
| `src/cli/types.ts` | Interface definitions |
| `cursor-hooks/INTEGRATION.md` | How Cursor integration was designed (good template) |
| `plugin/hooks/hooks.json` | Claude Code hook structure (for comparison) |

### External (fetch/read these)
| Resource | Purpose |
|----------|---------|
| `https://opencode.ai/docs/plugins/` | Official OpenCode plugin documentation |
| `https://opencode.ai/docs/custom-tools/` | Custom tools documentation |
| `~/.config/opencode/superpowers/.opencode/plugin/superpowers.js` | Working OpenCode plugin example |
| `~/.config/opencode/package.json` | OpenCode dependencies (check @opencode-ai/plugin version) |

---

## Questions to Answer During Implementation

1. Does OpenCode provide transcript access? (Cursor doesn't, Claude Code does)
2. What's the OpenCode equivalent of `CLAUDE_SESSION_ID` env var?
3. How should the OpenCode plugin handle worker not running?
4. Should opencode adapter reuse claude-code adapter with minor tweaks, or be separate?

---

## Workflow

1. Create feature branch: `git checkout -b feature/opencode-support`
2. **Research phase:**
   - Fetch and read OpenCode plugin docs thoroughly
   - Study Superpowers plugin implementation
   - Study existing claude-mem adapters (claude-code.ts, cursor.ts)
   - Understand OpenCode's event model vs Claude Code's hook model
3. **Plan the adapter** - decide field mappings, output format
4. Create `src/cli/adapters/opencode.ts`
5. Update router in `src/cli/adapters/index.ts`
6. Test CLI directly with mock data
7. Create `.opencode/plugin/claude-mem.js`
8. **Test end-to-end:** symlink to `~/.config/opencode/plugin/`, launch OpenCode separately, verify integration
9. Create installation docs (`.opencode/INSTALL.md`, `docs/README.opencode.md`)
10. Commit and prepare PR

**Testing Note:** Since you're running from Claude Code/Codex, you'll need to manually launch OpenCode in a separate terminal to test the integration. This is intentional - it provides cleaner separation between development and testing.

---

## Success Criteria

- [ ] `bun worker-service.cjs hook opencode context` returns context
- [ ] `bun worker-service.cjs hook opencode observation` captures observations  
- [ ] OpenCode plugin loads without errors
- [ ] Context injected on session start
- [ ] Tool usage captured in database
- [ ] `mem_search` tool works in OpenCode
- [ ] Shared database with Claude Code (same observations visible)
