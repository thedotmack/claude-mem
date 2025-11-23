  Detailed Implementation Plan

## Verification Summary

**All assumptions verified against actual codebase:**
- ✅ Line numbers validated and corrected
- ✅ `silentDebug` exists at `../utils/silent-debug.js` (already imported in both hooks)
- ✅ Worker response format verified (`completed`, `skipped`, timeout will be added)
- ✅ Current timeouts: 30s (will increase to 90s)
- ✅ SDK prompts at lines 130-132 and 295-296 confirmed
- ✅ Environment variable names checked (no conflicts)
- ✅ Code structure verified (all variables and functions exist)

**Key decisions made:**
1. **Timeout duration**: Increase from 30s → 90s (configurable via env var)
2. **Timeout handling**: Change from throwing error → returning `{status: 'timeout'}`
3. **Import steps**: Removed (silentDebug already imported in both hooks)

---

## Debug Pattern: silentDebug for Configuration Visibility

All environment variable fallbacks use `silentDebug` to log when defaults are used:

```typescript
const value = parseInt(
  process.env.ENV_VAR ||
  (silentDebug('ENV_VAR not set, using default'), 'default_value'),
  10
);
```

**How it works:**
- Comma operator: `(silentDebug(...), 'default')` evaluates both, returns last value
- `silentDebug` logs to PM2 (visible in `npm run worker:logs`)
- Returns fallback value (3rd param, defaults to empty string)
- Helps detect when "primary data is not flowing" (config not picked up)

**Note:** `silentDebug` is already imported in both save-hook.ts and summary-hook.ts from `../utils/silent-debug.js`

---

Phase 1: Update SDK Prompts for <no_observation> Marker

File: src/sdk/prompts.ts

  Change 1.1: Replace "ALWAYS write" instruction (lines 130-132)

  OLD:
  If you are tasked with processing a LARGE tool use message, **ALWAYS write at least
  one observation** (or multiple if you need to). This is critical for when we replace
  long outputs with summaries in real-time sessions!

  NEW:
  <observation_rules>
  - If this tool use contains valuable information (errors, discoveries, state changes,
   novel insights) → Create at least one observation
  - If this tool use is routine/not valuable (simple reads, navigation, git status,
  etc.) → Output exactly: <no_observation>
  - You MUST output one or the other - never stay silent
  - This is critical for real-time session compression - we need a definitive response
  </observation_rules>

  Change 1.2: Replace continuation prompt instruction (lines 295-296)

  OLD:
  If you are tasked with processing a LARGE tool use message, **ALWAYS write at least
  one observation** (or multiple if you need to).

  NEW:
  <observation_rules>
  - Valuable information → Create observation(s)
  - Routine operation → Output: <no_observation>
  - MUST respond with one or the other
  </observation_rules>

  ---
  Phase 2: Improve save-hook Waiting Mechanism

  File: src/hooks/save-hook.ts

  Change 2.1: Update timeout constant (line 505)

  OLD:
  // Set timeout: 30s for Endless Mode (wait for processing), 2s for async
  const timeoutMs = isEndlessModeEnabled ? 30000 : 2000;

  NEW:
  // Set timeout: configurable for Endless Mode (wait for processing), 2s for async
  const timeoutMs = isEndlessModeEnabled ?
    parseInt(
      process.env.CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS ||
      (silentDebug('CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS not set, using default 90000ms'), '90000'),
      10
    ) : 2000;

  Change 2.2: Verify timeout usage (line 519)

  VERIFY: The timeout is already applied via AbortSignal.timeout(timeoutMs)
  ```typescript
  signal: AbortSignal.timeout(timeoutMs)
  ```
  No changes needed - it already uses the timeoutMs variable we just updated.

  Change 2.3: Enhance response handling (lines 533-538)

  ADD: Handle new 'skipped' and 'timeout' status codes

  OLD:
  const result = await response.json();
  return hookResponse;

  NEW:
  const result = await response.json();

  if (result.status === 'completed') {
    console.log('[save-hook] ✅ Observation created, transcript transformed');
  } else if (result.status === 'skipped') {
    console.log('[save-hook] ⏭️  No observation needed, continuing');
  } else if (result.status === 'timeout') {
    console.warn(`[save-hook] ⏱️  Timeout after ${timeoutMs}ms - processing async`);
  }

  return hookResponse;

  Change 2.4: Simplify error logging (lines 548-555)

  UPDATE: Remove TimeoutError special case (now handled as status)

  OLD:
  } catch (error: any) {
    if (error.name === 'TimeoutError') {
      console.warn('[save-hook] Observation still processing in background');
    } else {
      console.warn('[save-hook] Failed to send observation:', error.message);
    }
    return hookResponse;
  }

  NEW:
  } catch (error: any) {
    console.warn('[save-hook] ❌ Failed to send observation:', error.message);
    return hookResponse;
  }

  ---
  Phase 3: Add Waiting to summary-hook

  File: src/hooks/summary-hook.ts

  Change 3.1: Update timeout in fetch call (line 198)

  OLD:
  signal: AbortSignal.timeout(2000)

  NEW:
  signal: AbortSignal.timeout(
    parseInt(
      process.env.CLAUDE_MEM_SUMMARY_TIMEOUT_MS ||
      (silentDebug('CLAUDE_MEM_SUMMARY_TIMEOUT_MS not set, using default 90000ms'), '90000'),
      10
    )
  )

  Change 3.2: Add response waiting logic (lines 190-199)

  FIND:
  fetch(summaryUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(summaryPayload),
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  REPLACE WITH:
  const response = await fetch(summaryUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(summaryPayload),
    signal: controller.signal,
  });

  clearTimeout(timeoutId);

  if (response.ok) {
    const result = await response.json();
    console.log('[summary-hook] ✅ Summary queued successfully');
  } else {
    console.warn('[summary-hook] ⚠️  Summary queue failed:', response.statusText);
  }

  Change 3.3: Simplify error handling (lines 210-217)

  FIND:
  } catch (error: any) {
    console.warn('[summary-hook] Failed to trigger summary:', error.message);
  } finally {
    processingCurrentPrompt = false;
  }

  REPLACE WITH:
  } catch (error: any) {
    console.warn('[summary-hook] ❌ Failed to trigger summary:', error.message);
  } finally {
    processingCurrentPrompt = false;
  }

  ---
  Phase 4: Update Worker to Return Timeout Status

  File: src/services/worker-service.ts

  Change 4.1: Modify waitForObservation to return status instead of throwing (lines 606-632)

  OLD:
  const timeoutPromise = new Promise<null>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error('Observation creation timeout (30s exceeded)'));
    }, 30000);
  });

  NEW:
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve('timeout');
    }, 90000); // Updated to 90s
  });

  Change 4.2: Update response handling to include timeout status (lines 662-696)

  OLD:
  try {
    const observation = await Promise.race([observationPromise, timeoutPromise]);

    clearTimeout(timeoutHandle);

    if (observation === null) {
      return {
        status: 'skipped',
        observation: null,
        processing_time_ms,
        message: 'No observation created (routine operation)'
      };
    }

    // Transform transcript and return...
  } catch (error) {
    clearTimeout(timeoutHandle);
    throw error; // Timeout error thrown
  }

  NEW:
  const observation = await Promise.race([observationPromise, timeoutPromise]);

  clearTimeout(timeoutHandle);

  if (observation === 'timeout') {
    return {
      status: 'timeout',
      observation: null,
      processing_time_ms: Date.now() - startTime,
      message: 'Observation creation timeout (90s exceeded)'
    };
  }

  if (observation === null) {
    return {
      status: 'skipped',
      observation: null,
      processing_time_ms,
      message: 'No observation created (routine operation)'
    };
  }

  // Transform transcript and return completed status...

  ---
  Phase 5: Verify SDK Agent Handling

  File: src/services/worker/SDKAgent.ts

  Change 5.1: Enhance skip detection logging (lines 274-286)

  FIND:
  if (observations.length === 0 && session.pendingObservationResolvers.has(messageId))
  {
    const resolver = session.pendingObservationResolvers.get(messageId);
    session.pendingObservationResolvers.delete(messageId);
    resolver?.(null);
  }

  REPLACE WITH:
  if (observations.length === 0 && session.pendingObservationResolvers.has(messageId))
  {
    console.log(`[SDKAgent] ⏭️  No observation created for tool_use_id=${messageId} 
  (routine operation)`);
    const resolver = session.pendingObservationResolvers.get(messageId);
    session.pendingObservationResolvers.delete(messageId);
    resolver?.(null);
  }

  Change 5.2: Enhance observation creation logging (lines 326-347)

  FIND:
  if (isFirstObservation && session.pendingObservationResolvers.has(messageId)) {
    const resolver = session.pendingObservationResolvers.get(messageId);
    session.pendingObservationResolvers.delete(messageId);
    resolver?.(observationData);
  }

  REPLACE WITH:
  if (isFirstObservation && session.pendingObservationResolvers.has(messageId)) {
    console.log(`[SDKAgent] ✅ Observation created for tool_use_id=${messageId}, 
  resolving promise`);
    const resolver = session.pendingObservationResolvers.get(messageId);
    session.pendingObservationResolvers.delete(messageId);
    resolver?.(observationData);
  }

  ---
  Phase 6: Update Documentation

  File: CLAUDE.md

  ADD to Environment Variables section:
  - `CLAUDE_MEM_ENDLESS_WAIT_TIMEOUT_MS` - How long save-hook waits for observations
  (default: 90000ms / 90s)
  - `CLAUDE_MEM_SUMMARY_TIMEOUT_MS` - How long summary-hook waits for queueing
  (default: 90000ms / 90s)

  ADD to Endless Mode section:
  **Response Contract:**
  - SDK must ALWAYS respond with either an observation OR `<no_observation>` marker
  - Routine operations (reads, navigation) return `<no_observation>` in ~1-2s
  - Valuable information creates observations in ~5-10s
  - Hooks wait up to 90s (configurable) to guarantee response

  ---
  Summary of Changes

  Files Modified: 5
  1. src/sdk/prompts.ts - Add <no_observation> rules (2 locations)
  2. src/hooks/save-hook.ts - Increase timeout to 90s, enhance response handling
  3. src/hooks/summary-hook.ts - Increase timeout to 90s, add waiting
  4. src/services/worker-service.ts - Return timeout status instead of throwing error
  5. src/services/worker/SDKAgent.ts - Enhance logging for skip/create
  6. CLAUDE.md - Document new env vars

  Build & Deploy:
  npm run build
  npm run sync-marketplace
  npm run worker:restart

  Testing Checklist:
  - [ ] 5 rapid Read tools → all processed (no errors)
  - [ ] Routine operations show "⏭️ No observation needed" (~1-2s)
  - [ ] Valuable operations show "✅ Observation created" (~5-10s)
  - [ ] Logs distinguish: completed, skipped, timeout
  - [ ] Transcript transformation happens for all tools
  - [ ] Timeout status returns properly (not error thrown)
  - [ ] silentDebug logs show when env vars are missing
  - [ ] 90s timeout allows sequential processing without timeouts
