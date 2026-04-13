# Observer Session JSONL Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic cleanup of runaway observer session JSONL files to the existing CleanupJob, deleting files that are older than 30 days OR larger than 500MB.

**Architecture:** Extend `CleanupJob.ts` only — add three config fields, one result field, one private method `runObserverSessionCleanup()`, and wire it into `run()` and `startScheduled()`. No new files.

**Tech Stack:** TypeScript, Node.js `fs` (sync), Bun test runner

---

## File Map

| File | Action | What changes |
|------|--------|-------------|
| `src/services/worker/CleanupJob.ts` | Modify | Config fields, result field, constructor paths param, new method, wired into `run()` and `startScheduled()` |
| `tests/worker/cleanup-job.test.ts` | Create | Tests for `runObserverSessionCleanup` using temp dirs |

---

### Task 1: Write the Failing Tests

**Files:**
- Create: `tests/worker/cleanup-job.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
/**
 * Tests for CleanupJob observer session JSONL cleanup
 *
 * Mock Justification (0% mocks):
 * - Uses real temp directories to validate actual file deletion logic.
 *   Observer session cleanup is pure filesystem I/O — no mocks needed.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { CleanupJob } from '../../src/services/worker/CleanupJob.js';

describe('CleanupJob - runObserverSessionCleanup', () => {
  let tmpDir: string;
  let observerSessionsDir: string;
  let claudeConfigDir: string;
  let observerProjectDir: string;

  function setup() {
    tmpDir = join(tmpdir(), `obs-cleanup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    observerSessionsDir = join(tmpDir, 'claude-mem', 'observer-sessions');
    claudeConfigDir = join(tmpDir, 'claude');

    // Replicate Claude Code's project dir naming: replace each '/' with '-'
    const projectDirName = observerSessionsDir.replace(/\//g, '-');
    observerProjectDir = join(claudeConfigDir, 'projects', projectDirName);

    mkdirSync(observerSessionsDir, { recursive: true });
    mkdirSync(observerProjectDir, { recursive: true });
  }

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /** Create a CleanupJob with only observerSessionCleanup enabled */
  function makeJob(overrides: { observerSessionMaxAgeDays?: number; observerSessionMaxSizeMB?: number } = {}) {
    const db = new Database(':memory:');
    return new CleanupJob(
      db,
      {
        enableMemoryCleanup: false,
        enableAccessCleanup: false,
        enableImportanceRecalc: false,
        enableObserverSessionCleanup: true,
        observerSessionMaxAgeDays: overrides.observerSessionMaxAgeDays ?? 30,
        observerSessionMaxSizeMB: overrides.observerSessionMaxSizeMB ?? 500,
      }
    );
  }

  /** Set a file's mtime N days in the past */
  function makeOld(filePath: string, days: number) {
    const oldTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    utimesSync(filePath, oldTime, oldTime);
  }

  it('deletes .jsonl files older than maxAgeDays', async () => {
    setup();
    const filePath = join(observerProjectDir, 'old-session.jsonl');
    writeFileSync(filePath, 'session content');
    makeOld(filePath, 31); // 31 days old — exceeds 30-day threshold

    const job = makeJob();
    const result = await job.run();

    expect(result.observerSessionCleanup.deleted).toBe(1);
    expect(existsSync(filePath)).toBe(false);
  });

  it('keeps .jsonl files newer than maxAgeDays and under maxSizeMB', async () => {
    setup();
    const filePath = join(observerProjectDir, 'recent-session.jsonl');
    writeFileSync(filePath, 'recent content');
    // mtime defaults to now — well within 30 days, file is tiny

    const job = makeJob();
    const result = await job.run();

    expect(result.observerSessionCleanup.deleted).toBe(0);
    expect(existsSync(filePath)).toBe(true);
  });

  it('deletes .jsonl files larger than maxSizeMB regardless of age', async () => {
    setup();
    const filePath = join(observerProjectDir, 'huge-session.jsonl');
    writeFileSync(filePath, 'x'.repeat(2048)); // 2KB
    // Use 0 MB threshold so any file is "too large"
    // (avoids writing hundreds of MB in a unit test)

    const job = makeJob({ observerSessionMaxSizeMB: 0 }); // 0 MB = everything is too large
    const result = await job.run();

    expect(result.observerSessionCleanup.deleted).toBe(1);
    expect(existsSync(filePath)).toBe(false);
  });

  it('also removes the matching subdirectory when deleting a .jsonl file', async () => {
    setup();
    const sessionId = 'abc123-dead-session';
    const jsonlPath = join(observerProjectDir, `${sessionId}.jsonl`);
    const subDirPath = join(observerProjectDir, sessionId);

    writeFileSync(jsonlPath, 'content');
    mkdirSync(subDirPath); // Claude Code sometimes creates this alongside the JSONL
    makeOld(jsonlPath, 31);

    const job = makeJob();
    const result = await job.run();

    expect(result.observerSessionCleanup.deleted).toBe(1);
    expect(existsSync(jsonlPath)).toBe(false);
    expect(existsSync(subDirPath)).toBe(false);
  });

  it('returns zero counts when the observer project dir does not exist', async () => {
    setup();
    rmSync(observerProjectDir, { recursive: true });

    const job = makeJob();
    const result = await job.run();

    expect(result.observerSessionCleanup.deleted).toBe(0);
    expect(result.observerSessionCleanup.freedBytes).toBe(0);
  });

  it('reports correct freedBytes for deleted files', async () => {
    setup();
    const content = 'x'.repeat(256);
    const filePath = join(observerProjectDir, 'old-session.jsonl');
    writeFileSync(filePath, content);
    makeOld(filePath, 31);

    const job = makeJob();
    const result = await job.run();

    expect(result.observerSessionCleanup.freedBytes).toBe(256);
  });

  it('ignores non-.jsonl entries in the observer project dir', async () => {
    setup();
    // A file that is NOT .jsonl — should be ignored
    const otherFile = join(observerProjectDir, 'settings.json');
    writeFileSync(otherFile, '{}');
    makeOld(otherFile, 60); // old, but not .jsonl

    const job = makeJob();
    const result = await job.run();

    expect(result.observerSessionCleanup.deleted).toBe(0);
    expect(existsSync(otherFile)).toBe(true);
  });

  it('sets enabled: false in result when observerSessionCleanup is disabled', async () => {
    setup();
    const db = new Database(':memory:');
    const job = new CleanupJob(
      db,
      {
        enableMemoryCleanup: false,
        enableAccessCleanup: false,
        enableImportanceRecalc: false,
        enableObserverSessionCleanup: false,
      },
      { observerSessionsDir, claudeConfigDir }
    );

    const result = await job.run();

    expect(result.observerSessionCleanup.enabled).toBe(false);
    expect(result.observerSessionCleanup.deleted).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail (CleanupJob doesn't have this API yet)**

```bash
bun test tests/worker/cleanup-job.test.ts
```

Expected: compile error or test failure — `CleanupJob` constructor does not accept a third argument and `result.observerSessionCleanup` does not exist.

---

### Task 2: Extend Types and Add the Implementation

**Files:**
- Modify: `src/services/worker/CleanupJob.ts`

- [ ] **Step 1: Add imports at the top of the file**

After the existing imports, add:

```typescript
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { OBSERVER_SESSIONS_DIR, CLAUDE_CONFIG_DIR } from '../../shared/paths.js';
```

The file already imports `statSync` from `node:fs` — replace that single import line with the expanded set:

```typescript
// Before:
import { statSync } from 'node:fs';

// After:
import { readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { OBSERVER_SESSIONS_DIR, CLAUDE_CONFIG_DIR } from '../../shared/paths.js';
```

- [ ] **Step 2: Add three fields to `CleanupConfig`**

Append after the `importanceRecalcLookbackDays` line:

```typescript
export interface CleanupConfig {
  // Memory cleanup
  enableMemoryCleanup: boolean;
  memoryCleanupIntervalHours: number;
  memoryCleanupLimit: number;
  memoryCleanupDryRun: boolean;

  // Access tracking cleanup
  enableAccessCleanup: boolean;
  accessCleanupOlderThanDays: number;

  // Importance score recalculation
  enableImportanceRecalc: boolean;
  importanceRecalcLimit: number;
  importanceRecalcLookbackDays: number;

  // Observer session JSONL cleanup
  enableObserverSessionCleanup: boolean;   // Delete stale/large observer session files
  observerSessionMaxAgeDays: number;       // Delete if mtime older than this many days
  observerSessionMaxSizeMB: number;        // Delete if file size exceeds this (MB)
}
```

- [ ] **Step 3: Add the three defaults to `DEFAULT_CONFIG`**

```typescript
const DEFAULT_CONFIG: CleanupConfig = {
  enableMemoryCleanup: false,
  memoryCleanupIntervalHours: 24,
  memoryCleanupLimit: 100,
  memoryCleanupDryRun: true,

  enableAccessCleanup: true,
  accessCleanupOlderThanDays: 90,

  enableImportanceRecalc: true,
  importanceRecalcLimit: 500,
  importanceRecalcLookbackDays: 180,

  enableObserverSessionCleanup: true,
  observerSessionMaxAgeDays: 30,
  observerSessionMaxSizeMB: 500,
};
```

- [ ] **Step 4: Add `observerSessionCleanup` to `CleanupResult`**

```typescript
export interface CleanupResult {
  timestamp: number;
  duration: number;
  memoryCleanup: {
    enabled: boolean;
    evaluated: number;
    deleted: number;
    dryRun: boolean;
    candidates?: Array<{ id: number; title: string; reason: string }>;
  };
  accessCleanup: {
    enabled: boolean;
    deletedRecords: number;
  };
  importanceRecalc: {
    enabled: boolean;
    recalculated: number;
  };
  observerSessionCleanup: {
    enabled: boolean;
    deleted: number;
    freedBytes: number;
  };
}
```

- [ ] **Step 5: Verify constructor accepts config parameter**

The constructor already accepts `config?: Partial<CleanupConfig>`:

```typescript
export class CleanupJob {
  private config: CleanupConfig;
  private scheduledTimer: NodeJS.Timeout | null = null;
  private lastRun: CleanupResult | null = null;
  private currentJobId: string | null = null;

  constructor(
    private db: Database,
    config?: Partial<CleanupConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
```

- [ ] **Step 6: Update the `result` initializer in `run()` to include the new field**

In `run()`, extend the initial `result` object:

```typescript
const result: CleanupResult = {
  timestamp: startTime,
  duration: 0,
  memoryCleanup: {
    enabled: this.config.enableMemoryCleanup,
    evaluated: 0,
    deleted: 0,
    dryRun: this.config.memoryCleanupDryRun,
  },
  accessCleanup: {
    enabled: this.config.enableAccessCleanup,
    deletedRecords: 0,
  },
  importanceRecalc: {
    enabled: this.config.enableImportanceRecalc,
    recalculated: 0,
  },
  observerSessionCleanup: {
    enabled: this.config.enableObserverSessionCleanup,
    deleted: 0,
    freedBytes: 0,
  },
};
```

- [ ] **Step 7: Update `totalSteps` count in `run()` to include the new step**

```typescript
const totalSteps =
  (this.config.enableMemoryCleanup ? 1 : 0) +
  (this.config.enableAccessCleanup ? 1 : 0) +
  (this.config.enableImportanceRecalc ? 1 : 0) +
  (this.config.enableObserverSessionCleanup ? 1 : 0);
```

- [ ] **Step 8: Add Step 4 inside the `try` block in `run()`, after the importanceRecalc block**

Add after `// Step 3: Importance score recalculation (if enabled)` block:

```typescript
      // Step 4: Observer session JSONL cleanup (if enabled)
      if (this.config.enableObserverSessionCleanup) {
        const obsResult = await this.runObserverSessionCleanup();
        result.observerSessionCleanup.deleted = obsResult.deleted;
        result.observerSessionCleanup.freedBytes = obsResult.freedBytes;

        completedSteps++;
        checkpointManager.updateProgress(jobState.jobId, {
          processedItems: completedSteps,
          completedItems: completedSteps,
        });
      }
```

- [ ] **Step 9: Update the completion log in `run()` to include the new result**

```typescript
      logger.info('CleanupJob', 'Cleanup job completed', {
        jobId: jobState.jobId,
        duration: `${result.duration}ms`,
        memoryCleanup: result.memoryCleanup,
        accessCleanup: result.accessCleanup,
        importanceRecalc: result.importanceRecalc,
        observerSessionCleanup: result.observerSessionCleanup,
      });
```

- [ ] **Step 10: Update `startScheduled()` to also schedule when observer cleanup is enabled**

Replace:

```typescript
    if (!this.config.enableMemoryCleanup && !this.config.enableAccessCleanup) {
      logger.debug('CleanupJob', 'Cleanup disabled, not scheduling');
      return;
    }
```

With:

```typescript
    const anyEnabled =
      this.config.enableMemoryCleanup ||
      this.config.enableAccessCleanup ||
      this.config.enableObserverSessionCleanup;

    if (!anyEnabled) {
      logger.debug('CleanupJob', 'Cleanup disabled, not scheduling');
      return;
    }
```

- [ ] **Step 11: Add the `runObserverSessionCleanup()` private method**

Add after `runImportanceRecalc()` and before `startScheduled()`:

```typescript
  /**
   * Clean up stale or oversized observer session JSONL files.
   *
   * Observer sessions are background agents spawned by claude-mem. Their
   * conversation transcripts are stored by Claude Code under:
   *   CLAUDE_CONFIG_DIR/projects/<observer-sessions-project-dir>/
   *
   * The project dir name is derived by replacing every '/' in
   * OBSERVER_SESSIONS_DIR with '-' (Claude Code's convention).
   *
   * A file is deleted if EITHER condition is true:
   *   - age > observerSessionMaxAgeDays
   *   - size > observerSessionMaxSizeMB
   *
   * Matching subdirectories (same name without .jsonl) are also removed.
   */
  private async runObserverSessionCleanup(): Promise<{ deleted: number; freedBytes: number }> {
    // Derive Claude Code project dir name: replace each '/' with '-'
    // e.g. /Users/foo/.claude-mem/observer-sessions → -Users-foo--claude-mem-observer-sessions
    const projectDirName = OBSERVER_SESSIONS_DIR.replace(/\//g, '-');
    const projectDir = join(CLAUDE_CONFIG_DIR, 'projects', projectDirName);

    if (!existsSync(projectDir)) {
      logger.debug('CleanupJob', 'Observer sessions project dir not found, skipping', { projectDir });
      return { deleted: 0, freedBytes: 0 };
    }

    const maxAgeMs = this.config.observerSessionMaxAgeDays * 24 * 60 * 60 * 1000;
    const maxSizeBytes = this.config.observerSessionMaxSizeMB * 1024 * 1024;
    const now = Date.now();

    let entries: string[];
    try {
      entries = readdirSync(projectDir);
    } catch (error) {
      logger.warn('CleanupJob', 'Could not read observer sessions project dir', { projectDir }, error as Error);
      return { deleted: 0, freedBytes: 0 };
    }

    let deleted = 0;
    let freedBytes = 0;

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;

      const filePath = join(projectDir, entry);
      let fileStat;
      try {
        fileStat = statSync(filePath);
      } catch {
        continue; // file removed between readdir and stat
      }

      const ageMs = now - fileStat.mtimeMs;
      const tooOld = ageMs > maxAgeMs;
      const tooBig = fileStat.size > maxSizeBytes;

      if (!tooOld && !tooBig) continue;

      const reason = tooOld ? 'age' : 'size';

      try {
        const fileSize = fileStat.size;
        rmSync(filePath, { force: true });

        // Also remove the matching subdirectory if it exists
        const subDirName = entry.slice(0, -6); // strip '.jsonl'
        const subDirPath = join(projectDir, subDirName);
        if (existsSync(subDirPath)) {
          rmSync(subDirPath, { recursive: true, force: true });
        }

        deleted++;
        freedBytes += fileSize;

        logger.debug('CleanupJob', 'Deleted observer session file', {
          file: entry,
          reason,
          ageDays: Math.round(ageMs / 86400000),
          sizeMB: (fileSize / 1024 / 1024).toFixed(1),
        });
      } catch (error) {
        logger.warn('CleanupJob', 'Failed to delete observer session file', { filePath }, error as Error);
      }
    }

    if (deleted > 0) {
      logger.info('CleanupJob', `Observer session cleanup: deleted ${deleted} files, freed ${(freedBytes / 1024 / 1024).toFixed(1)} MB`, {
        deleted,
        freedBytes,
      });
    }

    return { deleted, freedBytes };
  }
```

---

### Task 3: Verify Tests Pass

- [ ] **Step 1: Run the new test suite**

```bash
bun test tests/worker/cleanup-job.test.ts --reporter=verbose
```

Expected output: all 8 tests pass with no errors.

- [ ] **Step 2: Run the full test suite to check for regressions**

```bash
bun test
```

Expected: all existing tests still pass. The `CleanupResult` type extension is additive — nothing breaks.

---

### Task 4: Commit

- [ ] **Step 1: Stage and commit**

```bash
git add src/services/worker/CleanupJob.ts tests/worker/cleanup-job.test.ts
git commit -m "$(cat <<'EOF'
feat: auto-cleanup stale/oversized observer session JSONL files

Observer sessions are background agents spawned by claude-mem whose
conversation transcripts accumulate in ~/.claude/projects/. Without
cleanup these grow unbounded (observed: 85GB total, single files up
to 9GB). Since claude-mem extracts all useful data into SQLite, the
raw JSONL files are expendable.

Adds a new CleanupJob step that deletes observer session JSONL files
when they are older than 30 days OR larger than 500MB (both thresholds
configurable). Matching subdirectories are also removed. The step is
enabled by default and runs on the same daily schedule as other cleanup.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Open the Pull Request

- [ ] **Step 1: Push the branch and create the PR**

```bash
git push -u origin feature/titans-with-pipeline
gh pr create \
  --title "feat: auto-cleanup stale/oversized observer session JSONL files" \
  --body "$(cat <<'EOF'
## Problem

claude-mem spawns background observer agents whose conversation transcripts
accumulate in `~/.claude/projects/-...-observer-sessions/` without any
automatic cleanup. This resulted in 85 GB of JSONL files (individual sessions
up to 9 GB) despite all useful data already being extracted into SQLite.

## Solution

Extend `CleanupJob` with a new step (`runObserverSessionCleanup`) that runs
on the existing daily schedule. A JSONL file is deleted when **either**:

- it is older than **30 days** (configurable: `observerSessionMaxAgeDays`)
- it is larger than **500 MB** (configurable: `observerSessionMaxSizeMB`)

Matching subdirectories (created by Claude Code alongside some JSONL files)
are also removed. The step is **enabled by default** (`enableObserverSessionCleanup: true`).

## Changes

- `src/services/worker/CleanupJob.ts` — three new `CleanupConfig` fields, new `observerSessionCleanup` result field, `runObserverSessionCleanup()` method, integrated into `run()` and `startScheduled()`
- `tests/worker/cleanup-job.test.ts` — 8 tests covering age-based deletion, size-based deletion, subdir removal, disabled state, and freed-bytes reporting

## Test Plan

- [ ] `bun test tests/worker/cleanup-job.test.ts` — all 8 new tests pass
- [ ] `bun test` — no regressions in existing test suite

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- ✅ Delete files older than 30 days → Task 2 Step 11 (`tooOld`)
- ✅ Delete files larger than 500MB → Task 2 Step 11 (`tooBig`)
- ✅ Integrated into CleanupJob → Tasks 2 Steps 6–10
- ✅ Config defaults → Task 2 Step 3
- ✅ Matching subdir removal → Task 2 Step 11
- ✅ Returns freed bytes → Tasks 2 and 3

**Placeholder scan:** No TBDs, TODOs, or "add appropriate error handling" phrases. All code is complete.

**Type consistency:**
- `observerSessionCleanup` field name is consistent across `CleanupResult` (Step 4), `result` initializer (Step 6), Step 4 in `run()` (Step 8), and log statement (Step 9).
- `runObserverSessionCleanup()` returns `{ deleted: number; freedBytes: number }` — matches usage in Step 8.
- Constructor accepts `config?: Partial<CleanupConfig>` — matches usage in test `makeJob()` call.
