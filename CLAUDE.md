/* To @claude: be vigilant about only leaving evergreen context in this file, claude-mem handles working context separately. */

# ⚠️ MANDATORY ERROR HANDLING RULES ⚠️

## The Try-Catch Problem That Cost 10 Hours

A single overly-broad try-catch block wasted 10 hours of debugging time by silently swallowing errors.
**This pattern is BANNED.**

## BEFORE You Write Any Try-Catch

**RUN THIS TEST FIRST:**
```bash
bun run scripts/detect-error-handling-antipatterns.ts
```

**You MUST answer these 5 questions to the user BEFORE writing try-catch:**

1. **What SPECIFIC error am I catching?** (Name the error type: `FileNotFoundError`, `NetworkTimeout`, `ValidationError`)
2. **Show documentation proving this error can occur** (Link to docs or show me the source code)
3. **Why can't this error be prevented?** (If it can be prevented, prevent it instead)
4. **What will the catch block DO?** (Must include logging + either rethrow OR explicit fallback)
5. **Why shouldn't this error propagate?** (Justify swallowing it rather than letting caller handle)

**If you cannot answer ALL 5 questions with specifics, DO NOT write the try-catch.**

## FORBIDDEN PATTERNS (Zero Tolerance)

### 🔴 CRITICAL - Never Allowed

```typescript
// ❌ FORBIDDEN: Empty catch
try {
  doSomething();
} catch {}

// ❌ FORBIDDEN: Catch without logging
try {
  doSomething();
} catch (error) {
  return null;  // Silent failure!
}

// ❌ FORBIDDEN: Large try blocks (>10 lines)
try {
  // 50 lines of code
  // Multiple operations
  // Different failure modes
} catch (error) {
  logger.error('Something failed');  // Which thing?!
}

// ❌ FORBIDDEN: Promise empty catch
promise.catch(() => {});  // Error disappears into void

// ❌ FORBIDDEN: Try-catch to fix TypeScript errors
try {
  // @ts-ignore
  const value = response.propertyThatDoesntExist;
} catch {}
```

### ✅ ALLOWED Patterns

```typescript
// ✅ GOOD: Specific, logged, explicit handling
try {
  await fetch(url);
} catch (error) {
  if (error instanceof NetworkError) {
    logger.warn('SYNC', 'Network request failed, will retry', { url }, error);
    return null;  // Explicit: null means "fetch failed"
  }
  throw error;  // Unexpected errors propagate
}

// ✅ GOOD: Minimal scope, clear recovery
try {
  JSON.parse(data);
} catch (error) {
  logger.error('CONFIG', 'Corrupt settings file, using defaults', {}, error);
  return DEFAULT_SETTINGS;
}

// ✅ GOOD: Fire-and-forget with logging
backgroundTask()
  .catch(error => logger.warn('BACKGROUND', 'Task failed', {}, error));

// ✅ GOOD: Approved override for justified exceptions
try {
  JSON.parse(optionalField);
} catch (error) {
  // [APPROVED OVERRIDE]: Expected JSON parse failures for optional fields, too frequent to log
  return [];
}
```

### Approved Overrides

When you have a **justified reason** to violate the error handling rules (e.g., performance-critical hot paths, expected frequent failures), you can use an approved override:

```typescript
// [APPROVED OVERRIDE]: Brief explanation of why this is necessary
```

**Rules for approved overrides:**
- Must have a **specific, technical reason** (not "seemed fine" or "works for me")
- Reason must explain **why the violation is necessary**, not just what it does
- Examples of valid reasons:
  - "Expected JSON parse failures for optional fields, too frequent to log"
  - "Logger can't log its own failures, using stderr as last resort"
  - "Health check port scan, expected connection failures"
- The detector will flag these as **APPROVED_OVERRIDE** (warning level) for review
- Invalid or outdated reasons should be challenged during code review

## The Meta-Rule

**UNCERTAINTY TRIGGERS RESEARCH, NOT TRY-CATCH**

When you're unsure if a property exists or a method signature is correct:
1. **READ** the source code or documentation
2. **VERIFY** with the Read tool
3. **USE** TypeScript types to catch errors at compile time
4. **WRITE** code you KNOW is correct

Never use try-catch to paper over uncertainty. That wastes hours of debugging time later.

## Critical Path Protection

These files are **NEVER** allowed to have catch-and-continue:
- `SDKAgent.ts` - Errors must propagate, not hide
- `GeminiAgent.ts` - Must fail loud, not silent
- `OpenRouterAgent.ts` - Must fail loud, not silent
- `SessionStore.ts` - Database errors must propagate
- `worker-service.ts` - Core service errors must be visible

On critical paths, prefer **NO TRY-CATCH** and let errors propagate naturally.

---

# Claude-Mem: AI Development Instructions

## What This Project Is

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions.

## Architecture

**5 Lifecycle Hooks**: SessionStart → UserPromptSubmit → PostToolUse → Summary → SessionEnd

**Hooks** (`src/hooks/*.ts`) - TypeScript → ESM, built to `plugin/scripts/*-hook.js`

**Worker Service** (`src/services/worker-service.ts`) - Express API on port 37777, Bun-managed, handles AI processing asynchronously

**Database** (`src/services/sqlite/`) - SQLite3 at `~/.claude-mem/claude-mem.db` 

**Search Skill** (`plugin/skills/mem-search/SKILL.md`) - HTTP API for searching past work, auto-invoked when users ask about history

**Chroma** (`src/services/sync/ChromaSync.ts`) - Vector embeddings for semantic search

**Viewer UI** (`src/ui/viewer/`) - React interface at http://localhost:37777, built to `plugin/ui/viewer.html`

## Privacy Tags

**Dual-Tag System** for meta-observation control:
- `<private>content</private>` - User-level privacy control (manual, prevents storage)
- `<claude-mem-context>content</claude-mem-context>` - System-level tag (auto-injected observations, prevents recursive storage)

**Implementation**: Tag stripping happens at hook layer (edge processing) before data reaches worker/database. See `src/utils/tag-stripping.ts` for shared utilities.

## Build Commands

```bash
npm run build-and-sync        # Build, sync to marketplace, restart worker
```

## Configuration

Settings are managed in `~/.claude-mem/settings.json`. The file is auto-created with defaults on first run.

## File Locations

- **Source**: `<project-root>/src/`
- **Built Plugin**: `<project-root>/plugin/`
- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Database**: `~/.claude-mem/claude-mem.db`
- **Chroma**: `~/.claude-mem/chroma/`

## Requirements

- **Bun** (all platforms - auto-installed if missing)
- **uv** (all platforms - auto-installed if missing, provides Python for Chroma)
- Node.js

## Documentation

**Public Docs**: https://docs.claude-mem.ai (Mintlify)
**Source**: `docs/public/` - MDX files, edit `docs.json` for navigation
**Deploy**: Auto-deploys from GitHub on push to main

## Pro Features Architecture

Claude-mem is designed with a clean separation between open-source core functionality and optional Pro features.

**Open-Source Core** (this repository):

- All worker API endpoints on localhost:37777 remain fully open and accessible
- Pro features are headless - no proprietary UI elements in this codebase
- Pro integration points are minimal: settings for license keys, tunnel provisioning logic
- The architecture ensures Pro features extend rather than replace core functionality

**Pro Features** (coming soon, external):

- Enhanced UI (Memory Stream) connects to the same localhost:37777 endpoints as the open viewer
- Additional features like advanced filtering, timeline scrubbing, and search tools
- Access gated by license validation, not by modifying core endpoints
- Users without Pro licenses continue using the full open-source viewer UI without limitation

This architecture preserves the open-source nature of the project while enabling sustainable development through optional paid features.

# Important

No need to edit the changelog ever, it's generated automatically.
