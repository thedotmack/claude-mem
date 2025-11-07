# Worker Service Refactor Plan

**Date**: 2025-11-06
**Based on**: worker-service-analysis.md
**Branch**: cleanup/worker

---

## Decisions Made

### 🔥🔥🔥🔥🔥 Critical Fixes

#### Issue #1: Fragile PM2 String Parsing
**Decision**: DELETE all PM2 status checking code
- Remove lines 54-98 in worker-utils.ts (PM2 list parsing)
- Replace with simple: health check → if unhealthy, restart → wait for health
- PM2 restart is idempotent - handles "not started" and "started but broken"
- Rationale: "Just ping localhost:37777" - if unhealthy, restart it

#### Issue #2: Silent PM2 Error Handling
**Decision**: AUTOMATICALLY RESOLVED by Issue #1
- Gets deleted with PM2 status checking code
- New approach naturally fails fast on execSync

#### Issue #3: Session Auto-Creation Duplication
**Decision**: EXTRACT to helper method
- Create `private getOrCreateSession(sessionDbId): ActiveSession`
- Remove 60+ lines of duplicated code from:
  - handleInit() (lines 663-733)
  - handleObservation() (lines 754-785)
  - handleSummarize() (lines 813-844)
- Rationale: DRY principle

#### Issue #4: No "Running But Unhealthy" Handling
**Decision**: AUTOMATICALLY RESOLVED by Issue #1
- New approach always restarts if unhealthy
- PM2 restart handles all cases

#### Issue #5: Useless getWorkerPort() Wrapper
**Decision**: CREATE proper settings reader
- Delete the wrapper function
- Create settings reader that:
  1. Reads from `~/.claude-mem/settings.json`
  2. Falls back to `process.env.CLAUDE_MEM_WORKER_PORT`
  3. Falls back to `37777`
- Rationale: UI writes to `~/.claude-mem/settings.json`, worker/hooks must read from there

---

### 🔥🔥🔥 Cleanup

#### Issue #6: 1500ms Debounce Too Long
**Decision**: SKIP - not a concern

#### Issue #7: Magic Numbers Throughout
**Decision**: DELETE unnecessary magic numbers, UNIFY required ones
- Remove hardcoded defaults that aren't needed
- Centralize remaining constants with named variables
- Locations:
  - worker-utils.ts: timeout values (100ms, 1000ms, 10000ms)
  - worker-service.ts: Line 997 (100ms), Line 109 ('50mb'), etc.

#### Issue #8: Configuration Duplication
**Decision**: AUTOMATICALLY RESOLVED by Issue #7
- Centralizing constants solves this

#### Issue #9: Hardcoded Model Validation
**Decision**: AUTOMATICALLY RESOLVED by Issue #7
- Delete hardcoded model list
- Let SDK handle validation

#### Issue #10: Hardcoded Version Fallback
**Decision**: READ from package.json
- Line 343: Replace `'5.0.3'` with dynamic read from package.json
- Rationale: Why hardcode a version that gets stale?

#### Issue #11: Unnecessary this.port Instance Variable
**Decision**: DELETE `this.port`
- worker-service.ts:100 - remove instance variable
- Replace all `this.port` uses with direct constant/settings reader
- Used at lines 351, 738, 742

---

## Implementation Plan

### Phase 1: worker-utils.ts Complete Rewrite

**File**: `src/shared/worker-utils.ts`

**Changes**:
1. Create settings reader function:
```typescript
function getWorkerPort(): number {
  try {
    const settingsPath = join(homedir(), '.claude-mem', 'settings.json');
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const port = parseInt(settings.env?.CLAUDE_MEM_WORKER_PORT, 10);
      if (!isNaN(port)) return port;
    }
  } catch {}
  return parseInt(process.env.CLAUDE_MEM_WORKER_PORT || '37777', 10);
}
```

2. Add named constants:
```typescript
const HEALTH_CHECK_TIMEOUT_MS = 100;
const HEALTH_CHECK_POLL_INTERVAL_MS = 100;
const HEALTH_CHECK_MAX_WAIT_MS = 10000;
```

3. Simplify `ensureWorkerRunning()`:
```typescript
export async function ensureWorkerRunning(): Promise<void> {
  if (await isWorkerHealthy()) return;

  const packageRoot = getPackageRoot();
  const pm2Path = path.join(packageRoot, "node_modules", ".bin", "pm2");
  const ecosystemPath = path.join(packageRoot, "ecosystem.config.cjs");

  execSync(`"${pm2Path}" restart "${ecosystemPath}"`, {
    cwd: packageRoot,
    stdio: 'pipe'
  });

  if (!await waitForWorkerHealth()) {
    throw new Error("Worker failed to become healthy after restart");
  }
}
```

4. Update `isWorkerHealthy()` and `waitForWorkerHealth()` to use constants

**Result**: ~50 lines (vs 110 original), all bugs fixed

---

### Phase 2: worker-service.ts Cleanup

**File**: `src/services/worker-service.ts`

**Changes**:

1. **Read version from package.json** (line 343):
```typescript
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8'));
const VERSION = packageJson.version;
```

2. **Extract getOrCreateSession() helper**:
```typescript
private getOrCreateSession(sessionDbId: number): ActiveSession {
  let session = this.sessions.get(sessionDbId);
  if (session) return session;

  const db = new SessionStore();
  const dbSession = db.getSessionById(sessionDbId);
  if (!dbSession) {
    db.close();
    throw new Error(`Session ${sessionDbId} not found in database`);
  }

  session = {
    sessionDbId,
    claudeSessionId: dbSession.claude_session_id,
    sdkSessionId: null,
    project: dbSession.project,
    userPrompt: dbSession.user_prompt,
    pendingMessages: [],
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 0,
    startTime: Date.now()
  };

  this.sessions.set(sessionDbId, session);

  session.generatorPromise = this.runSDKAgent(session).catch(err => {
    logger.failure('WORKER', 'SDK agent error', { sessionId: sessionDbId }, err);
    const db = new SessionStore();
    db.markSessionFailed(sessionDbId);
    db.close();
    this.sessions.delete(sessionDbId);
  });

  db.close();
  return session;
}
```

3. **Update handleInit(), handleObservation(), handleSummarize()**:
Replace duplication with single line:
```typescript
const session = this.getOrCreateSession(sessionDbId);
```

4. **Delete model validation** (lines 407+):
Remove hardcoded validModels array and validation check

5. **Delete this.port instance variable** (line 100):
- Remove `private port: number = FIXED_PORT;`
- Replace all `this.port` references with `FIXED_PORT` or settings reader

6. **Add named constants** at top of file:
```typescript
const MESSAGE_POLL_INTERVAL_MS = 100;
const MAX_REQUEST_SIZE = '50mb';
```

7. **Use named constants** throughout (lines 109, 997, etc.)

---

### Phase 3: Update Hooks

**Files**:
- `src/hooks/new-hook.ts`
- `src/hooks/save-hook.ts`
- `src/hooks/summary-hook.ts`
- `src/hooks/cleanup-hook.ts`

**Changes**:
1. Import settings reader from worker-utils
2. Replace `const FIXED_PORT = parseInt(process.env.CLAUDE_MEM_WORKER_PORT || '37777', 10);`
   with call to settings reader
3. Update cleanup-hook.ts line 74 to use settings reader as fallback

---

### Phase 4: Update user-message-hook.ts

**File**: `src/hooks/user-message-hook.ts`

**Changes**:
- Line 53: Replace hardcoded `http://localhost:37777/` with dynamic port from settings reader

---

## Files Changed

1. `src/shared/worker-utils.ts` - Complete rewrite (~50 lines)
2. `src/services/worker-service.ts` - Major cleanup (remove ~60 lines duplication, add helper)
3. `src/hooks/new-hook.ts` - Use settings reader
4. `src/hooks/save-hook.ts` - Use settings reader
5. `src/hooks/summary-hook.ts` - Use settings reader
6. `src/hooks/cleanup-hook.ts` - Use settings reader
7. `src/hooks/user-message-hook.ts` - Dynamic port in message

---

## Testing Checklist

After implementation:

- [ ] Build: `npm run build`
- [ ] Sync: `npm run sync-marketplace`
- [ ] Restart worker: `npm run worker:restart`
- [ ] Start new Claude Code session (hooks should work)
- [ ] Change port in UI settings to 38888
- [ ] Restart worker
- [ ] Verify worker binds to 38888
- [ ] Verify hooks connect to 38888
- [ ] Verify UI connects to 38888
- [ ] Change port back to 37777
- [ ] Test all endpoints work

---

## Expected Outcomes

**Lines Removed**: ~130 lines (60 from duplication, 70 from PM2 parsing)
**Lines Added**: ~50 lines (helper method, settings reader, constants)
**Net Change**: -80 lines

**Bugs Fixed**:
- ✅ PM2 string parsing false positives
- ✅ Silent error handling
- ✅ No restart when unhealthy
- ✅ Port configuration not synchronized with UI

**Code Quality**:
- ✅ DRY principle applied (no duplication)
- ✅ YAGNI principle applied (removed ceremony)
- ✅ Fail fast error handling
- ✅ Named constants instead of magic numbers
- ✅ Single source of truth for configuration

---

## Notes

- This plan addresses all Severity 5 and Severity 4 issues from the analysis
- Skipped Severity 2 issues that aren't actual problems (debounce timing)
- All "automatically resolved" issues are covered by the main fixes
- Settings synchronization bug (port not working) is now fixed
