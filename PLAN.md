# Fix Factory CLI (Droid) Integration

## Problem Statement

Factory CLI generated a Droid integration on the `feat/factory-ai` branch. Build passes, tests pass, but the integration doesn't actually work at runtime. Three root causes identified:

1. **Dead platform adapter**: Every hook command in `hooks.json` hardcodes `claude-code` as the platform arg. The `droidAdapter` is never invoked — even for Droid-only hooks like `SessionEnd` and `PreCompact`.
2. **Identical adapters**: `droidAdapter` and `claudeCodeAdapter` have identical `normalizeInput()` implementations (except `platform: 'droid'`). Droid-specific stdin fields (`permission_mode`, `hook_event_name`, `source`, `reason`, `stop_hook_active`) are documented in the JSDoc but never extracted.
3. **Claude-only fallback path**: Every hooks.json command falls back to `$HOME/.claude/plugins/marketplaces/thedotmack/plugin` — which doesn't exist on Factory-only installs.

## Documentation Sources

- Factory Plugins: https://docs.factory.ai/cli/configuration/plugins
- Factory Hooks Reference: https://docs.factory.ai/reference/hooks-reference
- Factory Building Plugins: https://docs.factory.ai/guides/building/building-plugins
- Factory sets both `DROID_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` (alias)
- Claude Code only sets `CLAUDE_PLUGIN_ROOT`

## Env Var Detection Strategy

| Env Var | Claude Code | Factory/Droid |
|---|---|---|
| `CLAUDE_PLUGIN_ROOT` | Set | Set (alias) |
| `DROID_PLUGIN_ROOT` | Not set | Set |
| `FACTORY_PROJECT_DIR` | Not set | Set |

**Detection rule**: If `DROID_PLUGIN_ROOT` is set → platform is `droid`. Otherwise → `claude-code`.

---

## Phase 1: Auto-Detect Platform in hook-command.ts

**What**: Add platform auto-detection so hooks.json doesn't need per-platform command variants.

**File**: `src/cli/hook-command.ts`

**Implementation**: Add a `detectPlatform()` function before `hookCommand()`:

```typescript
/**
 * Auto-detect the calling platform from environment variables.
 * Factory/Droid sets DROID_PLUGIN_ROOT alongside CLAUDE_PLUGIN_ROOT.
 * Claude Code only sets CLAUDE_PLUGIN_ROOT.
 * Explicit non-default platform args (e.g., 'cursor') are respected.
 */
function detectPlatform(cliPlatform: string): string {
  if (cliPlatform !== 'claude-code') return cliPlatform;
  if (process.env.DROID_PLUGIN_ROOT) return 'droid';
  return cliPlatform;
}
```

Then in `hookCommand()` at line 76, replace:
```typescript
const adapter = getPlatformAdapter(platform);
```
with:
```typescript
const resolvedPlatform = detectPlatform(platform);
const adapter = getPlatformAdapter(resolvedPlatform);
```

And update line 81:
```typescript
input.platform = resolvedPlatform;
```

**Why this approach**: Centralized detection in TypeScript. hooks.json stays simple. Explicit platform args (cursor, raw) still work. No shell-level complexity.

**Verification**:
- `grep -n 'detectPlatform' src/cli/hook-command.ts` → function exists
- `grep -n 'DROID_PLUGIN_ROOT' src/cli/hook-command.ts` → env var check exists

**Anti-patterns**: Do NOT change hooks.json commands to pass `droid`. Do NOT use `FACTORY_PROJECT_DIR` for detection (it's project-scoped, not platform-scoped).

---

## Phase 2: Make droidAdapter Extract Droid-Specific Fields

**What**: The droid adapter should extract the fields its JSDoc promises: `permission_mode`, `hook_event_name`, `source`, `reason`, `stop_hook_active`.

**Files**:
- `src/cli/adapters/droid.ts` — add field extraction
- `src/cli/types.ts` — add optional fields to `NormalizedHookInput` if not already present

**Implementation**: Update `droidAdapter.normalizeInput()` in `src/cli/adapters/droid.ts`:

```typescript
normalizeInput(raw) {
  const r = (raw ?? {}) as any;
  return {
    sessionId: r.session_id ?? r.id ?? r.sessionId,
    cwd: r.cwd ?? process.cwd(),
    platform: 'droid',
    prompt: r.prompt,
    toolName: r.tool_name,
    toolInput: r.tool_input,
    toolResponse: r.tool_response,
    transcriptPath: r.transcript_path,
    // Droid-specific fields
    permissionMode: r.permission_mode,
    hookEventName: r.hook_event_name,
    source: r.source,
    reason: r.reason,
    stopHookActive: r.stop_hook_active,
  };
},
```

**Reference**: Factory Hooks Reference documents these fields per-event:
- `permission_mode`: all events
- `hook_event_name`: all events
- `source`: SessionStart (`startup|resume|clear|compact`)
- `reason`: SessionEnd (`clear|logout|prompt_input_exit|other`)
- `stop_hook_active`: Stop/SubagentStop (boolean)

**Verification**:
- Read `src/cli/adapters/droid.ts` — confirm fields are extracted
- Read `src/cli/types.ts` — confirm `NormalizedHookInput` has the optional fields

**Anti-patterns**: Do NOT add these fields to `claudeCodeAdapter`. Do NOT make them required on `NormalizedHookInput`.

---

## Phase 3: Fix Fallback Path in hooks.json

**What**: The fallback path `$HOME/.claude/plugins/marketplaces/thedotmack/plugin` doesn't exist on Factory-only installs. Add Factory-aware fallback.

**File**: `plugin/hooks/hooks.json`

**Implementation**: Update the path resolution pattern in every hook command from:

```bash
_R="${CLAUDE_PLUGIN_ROOT}"; [ -z "$_R" ] && _R="$HOME/.claude/plugins/marketplaces/thedotmack/plugin";
```

to:

```bash
_R="${CLAUDE_PLUGIN_ROOT}"; [ -z "$_R" ] && _R="${DROID_PLUGIN_ROOT}"; [ -z "$_R" ] && { [ -d "$HOME/.factory/plugins/marketplaces/thedotmack/plugin" ] && _R="$HOME/.factory/plugins/marketplaces/thedotmack/plugin" || _R="$HOME/.claude/plugins/marketplaces/thedotmack/plugin"; };
```

This checks in order:
1. `CLAUDE_PLUGIN_ROOT` (set by both platforms)
2. `DROID_PLUGIN_ROOT` (Factory-specific)
3. Factory marketplace path (if directory exists)
4. Claude marketplace path (final fallback)

**Verification**:
- `grep 'DROID_PLUGIN_ROOT' plugin/hooks/hooks.json` → every hook command has the fallback
- `grep -c '\.factory/plugins' plugin/hooks/hooks.json` → count matches number of hook commands

**Anti-patterns**: Do NOT remove the Claude Code fallback. Do NOT use `FACTORY_CONFIG_DIR` for plugin paths.

---

## Phase 4: Update Tests

**What**: Update infrastructure tests to verify the new behavior.

**Files**:
- `tests/infrastructure/plugin-distribution.test.ts` — verify fallback path includes Factory
- Add a unit test for `detectPlatform()` in a new or existing test file

**Verification**:
- `npm test` → all tests pass
- New test covers: `detectPlatform('claude-code')` returns `'droid'` when `DROID_PLUGIN_ROOT` is set
- New test covers: `detectPlatform('cursor')` returns `'cursor'` regardless of env vars

---

## Phase 5: Build and Verify

**What**: Full build, test, and manual verification.

**Steps**:
1. `npm run build-and-sync` — passes
2. `npm test` — all tests pass
3. `grep -r 'claude-code' plugin/hooks/hooks.json` — platform arg is still `claude-code` (auto-detected at runtime)
4. `grep 'DROID_PLUGIN_ROOT' src/cli/hook-command.ts` — auto-detection present
5. `grep 'DROID_PLUGIN_ROOT' plugin/hooks/hooks.json` — fallback path present
6. `grep 'permission_mode\|hook_event_name\|stop_hook_active' src/cli/adapters/droid.ts` — Droid fields extracted

**Anti-patterns**:
- Do NOT change the CLI argument format (`hook <platform> <event>`)
- Do NOT add Factory-specific hook entries (same hooks.json serves both platforms)
- Do NOT create separate hooks.json files per platform
