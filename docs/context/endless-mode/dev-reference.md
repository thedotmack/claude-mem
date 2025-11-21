# Endless Mode: Developer Quick Reference

Quick reference for developers working on Endless Mode implementation.

---

## Key Files

### Core Implementation
- `src/hooks/save-hook.ts` - PostToolUse hook with blocking logic and transcript transformation
- `src/services/worker-service.ts` - HTTP endpoint with synchronous observation waiting
- `src/services/worker/SDKAgent.ts` - Promise resolution when observations are saved
- `src/services/worker-types.ts` - Type definitions for observations and sessions

### Configuration
- `src/services/worker/EndlessModeConfig.ts` - Configuration loader from settings.json
- `~/.claude-mem/settings.json` - User configuration file

### Documentation
- `docs/endless-mode-status.md` - Implementation status and technical details
- `docs/endless-mode-test-plan.md` - Comprehensive test plan with 10 scenarios
- `docs/endless-mode-user-guide.md` - User-facing documentation
- `docs/context/endless-mode-implementation-plan.md` - Original implementation plan
- `docs/context/phase-1-2-cleanup-plan.md` - Code cleanup specification

---

## Quick Commands

```bash
# Build and deploy
npm run build
npm run sync-marketplace
npm run worker:restart

# Monitor
pm2 logs claude-mem-worker                    # Worker logs
tail -f ~/.claude-mem/silent.log              # Debug logs
npm run endless-mode:metrics                  # Performance metrics

# Test
# (Execute in Claude Code session)
Read package.json                             # Test compression
Bash echo "test"                              # Test bash tool

# Database queries
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations WHERE tool_use_id IS NOT NULL;"
sqlite3 ~/.claude-mem/claude-mem.db "SELECT tool_name, title FROM observations ORDER BY created_at_epoch DESC LIMIT 5;"

# Transcript inspection
SESSION_ID=$(ls -t ~/.claude/sessions | head -1)
cat ~/.claude/sessions/$SESSION_ID/transcript.jsonl | grep "Compressed by Endless Mode"
```

---

## Architecture Flow

```
PostToolUse Hook (save-hook.ts)
    ↓
Check EndlessModeConfig.enabled
    ↓
[If enabled]
    ↓
POST /sessions/:id/observations?wait_until_obs_is_saved=true
    ↓
Worker queues observation → SDK Agent processes
    ↓
Promise created with tool_use_id key
    ↓
SDK Agent completes → Resolves promise
    ↓
Hook receives observation data
    ↓
transformTranscript(transcript_path, tool_use_id, observation)
    ↓
Replace tool_result content with compressed markdown
    ↓
Atomic write (temp file → validate → rename)
    ↓
Hook returns (Claude resumes)
```

---

## Configuration Check

```typescript
// In save-hook.ts (line ~276)
const endlessModeConfig = EndlessModeConfig.getConfig();
const isEndlessModeEnabled = endlessModeConfig.enabled && extractedToolUseId && transcript_path;
```

**Requirements for Endless Mode to activate:**
1. `CLAUDE_MEM_ENDLESS_MODE=true` in settings.json
2. `tool_use_id` extracted from transcript
3. `transcript_path` available in hook input

---

## Critical Code Locations

### save-hook.ts

**Tool use ID extraction** (lines 244-267):
```typescript
let extractedToolUseId: string | undefined = tool_use_id;
if (!extractedToolUseId && transcript_path) {
  // Read transcript, search backwards for tool_result with tool_use_id
}
```

**Endless Mode check** (lines 275-288):
```typescript
const endlessModeConfig = EndlessModeConfig.getConfig();
const isEndlessModeEnabled = endlessModeConfig.enabled && extractedToolUseId && transcript_path;
```

**Conditional endpoint** (lines 292-294):
```typescript
const endpoint = isEndlessModeEnabled
  ? `http://127.0.0.1:${port}/sessions/${sessionDbId}/observations?wait_until_obs_is_saved=true`
  : `http://127.0.0.1:${port}/sessions/${sessionDbId}/observations`;
```

**Transcript transformation** (lines 326-350):
```typescript
if (isEndlessModeEnabled) {
  if (result.status === 'completed' && result.observation) {
    await transformTranscript(transcript_path, tool_use_id, result.observation);
  }
}
```

**Transform function** (lines 117-212):
```typescript
async function transformTranscript(
  transcriptPath: string,
  toolUseId: string,
  observation: Observation
): Promise<void>
```

### worker-service.ts

**Synchronous mode detection** (line 463):
```typescript
const wait_until_obs_is_saved = req.query.wait_until_obs_is_saved === 'true';
```

**Promise creation** (lines 527-542):
```typescript
const observationPromise = new Promise<any>((resolve, reject) => {
  session.pendingObservationResolvers.set(tool_use_id, resolve);
  
  setTimeout(() => {
    if (session.pendingObservationResolvers.has(tool_use_id)) {
      session.pendingObservationResolvers.delete(tool_use_id);
      reject(new Error('Observation creation timeout (90s exceeded)'));
    }
  }, TIMEOUT_MS);
});
```

### SDKAgent.ts

**Promise resolution** (lines 286-302):
```typescript
if (session.currentToolUseId) {
  const resolver = session.pendingObservationResolvers.get(session.currentToolUseId);
  if (resolver) {
    session.pendingObservationResolvers.delete(session.currentToolUseId);
    resolver({
      id: obsId,
      type: obs.type,
      title: obs.title,
      // ... rest of observation data
    });
  }
}
```

---

## Debugging

### Enable Silent Debug Logging

Edit hook file, add:
```typescript
import { silentDebug } from '../utils/silent-debug.js';

silentDebug('My debug message', { 
  data: someValue,
  condition: someCheck
});
```

View logs:
```bash
tail -f ~/.claude-mem/silent.log
```

### Check Endless Mode Status

```bash
tail -20 ~/.claude-mem/silent.log | grep "Endless Mode Check"
```

Look for:
```json
{
  "configEnabled": true,
  "hasToolUseId": true,
  "hasTranscriptPath": true,
  "isEndlessModeEnabled": true
}
```

### Trace Observation Creation

```bash
pm2 logs claude-mem-worker --lines 100 | grep -A 5 "Observation ready"
```

---

## Common Issues

### Hook times out every time

**Check:**
1. Worker running: `pm2 status`
2. SDK Agent processing: Look for "Generator auto-starting" in logs
3. Model availability: Check API quota

**Fix:**
```bash
pm2 restart claude-mem-worker
pm2 logs claude-mem-worker --lines 50
```

### No compression happening

**Check:**
1. Config: `cat ~/.claude-mem/settings.json`
2. tool_use_id extraction: `tail -f ~/.claude-mem/silent.log`
3. Endpoint URL: Should include `?wait_until_obs_is_saved=true`

**Fix:**
```bash
# Verify config
cat ~/.claude-mem/settings.json | grep CLAUDE_MEM_ENDLESS_MODE

# Rebuild
npm run build && npm run sync-marketplace && npm run worker:restart
```

### UNIQUE constraint errors

**Cause:** Duplicate tool_use_id in database

**Fix:** Fixed in Phase 1-2 cleanup (using correct tool_use_id from transcript)

**Verify:**
```bash
sqlite3 ~/.claude-mem/claude-mem.db "SELECT tool_use_id, COUNT(*) FROM observations GROUP BY tool_use_id HAVING COUNT(*) > 1;"
```

---

## Testing Checklist

- [ ] Enable Endless Mode in settings
- [ ] Execute Read tool (verify compression)
- [ ] Execute Bash tool (verify compression)
- [ ] Check worker logs (compression stats)
- [ ] Check transcript (look for markers)
- [ ] Run metrics: `npm run endless-mode:metrics`
- [ ] Verify >80% compression ratio
- [ ] Verify <60s creation time
- [ ] Test timeout (stop worker, observe fallback)
- [ ] Test disabled mode (set false, verify async)

---

## Performance Targets

| Metric | Target | Measured Via |
|--------|--------|--------------|
| Observation creation | <60s (P95) | Worker logs |
| Transcript transform | <1s | Worker logs |
| Compression ratio | 80-95% | Worker logs |
| Timeout rate | <5% | Metrics script |
| Error rate | <1% | Error logs |

---

## Skipped Tools

These tools are NOT compressed (defined in `src/hooks/save-hook.ts`):

```typescript
const SKIP_TOOLS = new Set([
  'ListMcpResourcesTool',  // MCP infrastructure
  'SlashCommand',          // Command invocation
  'Skill',                 // Skill invocation
  'TodoWrite',             // Task management
  'AskUserQuestion'        // User interaction
]);
```

To add a tool to skip list:
1. Edit `src/hooks/save-hook.ts`
2. Add to SKIP_TOOLS Set
3. Rebuild: `npm run build && npm run sync-marketplace`

---

## Useful Queries

```sql
-- Count observations with tool_use_id
SELECT COUNT(*) FROM observations WHERE tool_use_id IS NOT NULL;

-- Recent observations
SELECT tool_name, title, subtitle 
FROM observations 
ORDER BY created_at_epoch DESC 
LIMIT 10;

-- Observations by tool type
SELECT tool_name, COUNT(*) as count 
FROM observations 
GROUP BY tool_name 
ORDER BY count DESC;

-- Find specific tool_use_id
SELECT * FROM observations 
WHERE tool_use_id = 'toolu_01XYZ...';
```

---

## Next Steps (Phase 4)

- [ ] Execute comprehensive test plan
- [ ] Collect performance metrics over multiple sessions
- [ ] Test edge cases (large outputs, rapid-fire, concurrent sessions)
- [ ] Document any issues found
- [ ] Update user guide based on test findings
- [ ] Prepare demo video/screenshots
- [ ] Plan beta release

---

**Last Updated**: 2025-11-19  
**Branch**: copilot/sub-pr-135  
**Status**: Ready for Phase 4 testing
