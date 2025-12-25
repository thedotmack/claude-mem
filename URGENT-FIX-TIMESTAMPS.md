# ✅ FIXED: Corrupted Observation Timestamps

## What Happened

On Dec 24, 2025, orphan queue processing was enabled without a working timestamp fix. This caused 25 observations from old sessions (Dec 16-22) to be saved with Dec 24 timestamps instead of their original timestamps.

## The Fix - COMPLETED

**Status**: ✅ All corrupted timestamps have been repaired

**Date Fixed**: Dec 24, 2025 at 20:55 PM PST

**Results**:
- Fixed 25 observations with corrupted timestamps
- Observations restored to correct dates (Dec 16-22)
- Remaining 31 observations in the window are legitimate (from Dec 24 sessions)

## The Original Damage

Observations created between approximately 19:45-20:31 on Dec 24 had wrong timestamps. These observations came from processing old pending_messages that were stuck in "processing" status.

## How to Identify Affected Observations

The affected observations were created from pending_messages that had `created_at_epoch` from Dec 17-20, but the observations got Dec 24 timestamps.

```sql
-- Find observations created during the bad window (Dec 24 ~19:45-20:31)
SELECT id, sdk_session_id,
       datetime(created_at_epoch/1000, 'unixepoch', 'localtime') as obs_time,
       title
FROM observations
WHERE created_at_epoch >= 1735098300000  -- Dec 24 19:45
  AND created_at_epoch <= 1735101060000  -- Dec 24 20:31
ORDER BY id;
```

## How to Fix

### Option 1: Match via processed pending_messages

The pending_messages table has `completed_at_epoch` which shows when they were processed, and `created_at_epoch` which has the CORRECT original timestamp.

```sql
-- Find pending_messages processed during the bad window
SELECT id, session_db_id, tool_name,
       datetime(created_at_epoch/1000, 'unixepoch', 'localtime') as original_time,
       datetime(completed_at_epoch/1000, 'unixepoch', 'localtime') as processed_time
FROM pending_messages
WHERE status = 'processed'
  AND completed_at_epoch >= 1735098300000
  AND completed_at_epoch <= 1735101060000
ORDER BY completed_at_epoch;
```

### Option 2: Match by session and sequence

For each affected session, observations should be ordered by their original pending_message timestamps:

```sql
-- Get the correct timestamp for each observation by matching session
-- This requires correlating sdk_session_id with session_db_id
```

### Fix Script Approach

1. Get all pending_messages processed during the bad window
2. For each, get its `session_db_id` and `created_at_epoch` (original timestamp)
3. Find observations for that session created during the bad window
4. Update observations with the correct `created_at_epoch` from their source pending_message

```sql
-- Example fix for a single observation (after identifying the correct timestamp):
UPDATE observations
SET created_at_epoch = [correct_epoch],
    created_at = datetime([correct_epoch]/1000, 'unixepoch')
WHERE id = [observation_id];
```

## The Timestamp Fix (Already Deployed)

The code now correctly passes `overrideTimestampEpoch` through:
- `SessionStore.storeObservation()` - accepts optional timestamp override
- `SessionStore.storeSummary()` - accepts optional timestamp override
- `ActiveSession.earliestPendingTimestamp` - tracks original message timestamp
- `SDKAgent.processSDKResponse()` - passes timestamp to storage

## Scripts Created

Three scripts were created to handle this issue:

1. **`scripts/fix-corrupted-timestamps.ts`** - Identifies and repairs corrupted timestamps
   ```bash
   bun scripts/fix-corrupted-timestamps.ts --dry-run  # Preview fixes
   bun scripts/fix-corrupted-timestamps.ts --yes      # Apply fixes
   ```

2. **`scripts/verify-timestamp-fix.ts`** - Verifies the fix was successful
   ```bash
   bun scripts/verify-timestamp-fix.ts
   ```

3. **`scripts/investigate-timestamps.ts`** - Investigates timestamp data
   ```bash
   bun scripts/investigate-timestamps.ts
   ```

## Orphan Processing Status

The timestamp fix has been verified and is working correctly. Orphan processing can now be safely re-enabled in `src/services/worker-service.ts` if needed.

## Files Changed

- `src/services/sqlite/SessionStore.ts` - added overrideTimestampEpoch param
- `src/services/worker-types.ts` - added earliestPendingTimestamp to ActiveSession
- `src/services/worker/SessionManager.ts` - tracks earliest timestamp when yielding
- `src/services/worker/SDKAgent.ts` - passes timestamp through processSDKResponse
- `src/services/worker-service.ts` - orphan processing disabled
