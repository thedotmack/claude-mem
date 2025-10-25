# Memory Toggle Feature - Design Plan

## Overview

Users need the ability to pause/resume claude-mem memory recording without uninstalling the plugin. This addresses use cases where users want temporary privacy, testing sessions, or simply don't want certain conversations saved.

## User Requirements (from feedback)

- "I don't want to save everything always"
- Need persistent on/off state across sessions
- Should be easy to toggle without complex commands
- Should not interfere with conversation context

## Design Principles

1. **Non-intrusive**: Toggling memory should not require special characters in prompts
2. **Persistent**: State should survive across Claude Code sessions
3. **Simple**: Clear on/off with easy status checking
4. **Fast**: Minimal overhead when checking enabled state

## Implementation Options

### Option A: Settings Flag (Recommended)

**Storage**: `~/.claude/settings.json`
```json
{
  "CLAUDE_MEM_ENABLED": true  // default: true
}
```

**CLI Commands**:
```bash
claude-mem pause    # Disable memory recording
claude-mem resume   # Enable memory recording
claude-mem status   # Show current state
```

**Hook Behavior**:
- All hooks check `CLAUDE_MEM_ENABLED` setting at start
- If `false`, hooks return early without saving/processing
- Worker service continues running (ready for resume)

**Pros**:
- Uses existing Claude settings infrastructure
- Simple boolean flag
- Easy to implement in all hooks

**Cons**:
- Modifies Claude Code's settings file

---

### Option B: Local Config File

**Storage**: `~/.claude-mem/config.json`
```json
{
  "enabled": true,
  "version": "4.2.8",
  "lastToggled": "2025-10-25T01:30:00Z"
}
```

**Same CLI commands as Option A**

**Pros**:
- Isolated from Claude Code settings
- Can add metadata (timestamp, reason, etc.)
- Full control over config structure

**Cons**:
- Additional file to manage
- Hooks need to read separate config file

---

### Option C: Slash Command Integration

**Usage**: In-session control via slash commands
```bash
/claude-mem pause
/claude-mem resume
/claude-mem status
```

**Pros**:
- No need to leave Claude Code session
- Immediate feedback
- Familiar interface for users

**Cons**:
- Requires slash command setup
- Need to update `.claude/commands/` structure
- More complex implementation

---

## Recommended Approach: Hybrid A + C

Combine Settings Flag (A) with optional Slash Commands (C):

1. **Persistent State**: Store in `~/.claude/settings.json` or `~/.claude-mem/config.json`
2. **CLI Control**: `claude-mem pause/resume/status`
3. **Optional In-Session Control**: `/claude-mem pause/resume` slash commands
4. **Hook Check**: All hooks read setting at startup, skip if disabled

---

## Implementation Details

### Hook Modifications

All hooks need to check enabled state:

```typescript
// src/shared/settings.ts
export function isMemoryEnabled(): boolean {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return settings.CLAUDE_MEM_ENABLED !== false; // default true
  } catch {
    return true; // default to enabled if settings missing
  }
}
```

```typescript
// In each hook
import { isMemoryEnabled } from '../shared/settings.js';

export function hookFunction(input: HookInput) {
  if (!isMemoryEnabled()) {
    return; // Skip all memory operations
  }

  // Normal hook logic...
}
```

### CLI Commands

```typescript
// src/bin/cli.ts
program
  .command('pause')
  .description('Pause memory recording (sessions will not be saved)')
  .action(() => {
    updateMemorySetting(false);
    console.log('✓ Memory recording paused');
  });

program
  .command('resume')
  .description('Resume memory recording')
  .action(() => {
    updateMemorySetting(true);
    console.log('✓ Memory recording resumed');
  });

program
  .command('status')
  .description('Show current memory recording status')
  .action(() => {
    const enabled = isMemoryEnabled();
    console.log(`Memory recording: ${enabled ? '✓ ENABLED' : '✗ PAUSED'}`);
  });
```

### Slash Commands (Optional)

Create `.claude/commands/claude-mem.md`:
```markdown
# Claude Mem Control

Usage: /claude-mem [pause|resume|status]

- pause: Stop recording this session
- resume: Resume recording
- status: Show current state
```

---

## User Experience

### Pausing Memory
```bash
$ claude-mem pause
✓ Memory recording paused

  All future sessions will NOT be saved until you run:
  claude-mem resume
```

### Checking Status
```bash
$ claude-mem status
Memory recording: ✗ PAUSED

To resume recording: claude-mem resume
```

### Resume Recording
```bash
$ claude-mem resume
✓ Memory recording resumed

All sessions will now be saved to ~/.claude-mem/
```

---

## Affected Hooks

### new-hook (UserPromptSubmit)
- Skip creating session records
- Skip saving user prompts

### save-hook (PostToolUse)
- Skip capturing observations
- Skip sending to worker service

### summary-hook
- Skip generating summaries
- Session remains unprocessed

### context-hook (SessionStart)
- Still runs (to show status message?)
- Could display: "Memory recording is currently paused"

### cleanup-hook (SessionEnd)
- Skip marking sessions complete
- No cleanup needed if nothing was saved

---

## Edge Cases

1. **Mid-session toggle**: What if user pauses during a session?
   - Decision: New state takes effect immediately
   - Observations before pause are saved, after pause are not

2. **Worker service**: Should it stop when paused?
   - Decision: Keep running (minimal resource usage)
   - Ready to process when resumed

3. **Existing data**: What happens to saved sessions when paused?
   - Decision: No change, data persists
   - Context hook can still load past sessions

4. **Uninstall vs Pause**: Clear distinction?
   - Pause: Temporary, easy to resume
   - Uninstall: Complete removal, requires reinstall

---

## Migration & Compatibility

- Default to `true` (enabled) for backward compatibility
- Existing users unaffected unless they explicitly pause
- No database schema changes needed
- No breaking changes to hooks

---

## Future Enhancements

1. **Selective Recording**: Fine-grained control
   ```bash
   claude-mem pause --observations-only
   claude-mem pause --summaries-only
   ```

2. **Project-Level Control**: Different settings per project
   ```bash
   claude-mem pause --project claude-mem
   ```

3. **Temporary Pause**: Auto-resume after duration
   ```bash
   claude-mem pause --duration 1h
   ```

4. **Pause Reasons**: Track why users pause
   ```bash
   claude-mem pause --reason "debugging session"
   ```

---

## Open Questions

1. Should context hook still inject past context when paused?
   - Lean toward: Yes, show past but don't save current

2. Should we show a status indicator when paused?
   - Could add to context hook output: "🔴 Memory recording paused"

3. CLI command naming: `pause/resume` vs `disable/enable` vs `off/on`?
   - Lean toward: `pause/resume` (temporary feeling)

4. Should worker service stop when paused?
   - Lean toward: Keep running (fast resume)

---

## Timeline

- **Phase 1**: Settings flag + CLI commands (1-2 days)
- **Phase 2**: Status indicator in context hook (1 day)
- **Phase 3**: Slash commands (optional, 1 day)
- **Phase 4**: User testing & feedback (1 week)
- **Phase 5**: Release in v4.3.0

---

## Success Metrics

- Users report successful pausing/resuming
- No saved data when paused (verify in tests)
- Fast toggle time (< 100ms)
- Clear status feedback
- No edge case bugs in production

---

## Related Issues

- GitHub feedback: "I don't want to save everything always"
- Privacy concerns: Users want control over what's saved
- Testing workflows: Developers need clean test sessions

---

*Last Updated: October 25, 2025*
*Status: Planning / Not Yet Implemented*
