import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// Source-only assertions that document the three Windows-specific
// regressions from #2192. We stay source-level (no fs.watch / no SDK spawn)
// because the failure modes are all in code paths that only execute on
// Windows; the goal is to lock the fix in so a future refactor can't
// silently revert it.

const watcherSource = readFileSync(
  join(__dirname, '..', 'src', 'services', 'transcripts', 'watcher.ts'),
  'utf-8',
);
const sessionRoutesSource = readFileSync(
  join(__dirname, '..', 'src', 'services', 'worker', 'http', 'routes', 'SessionRoutes.ts'),
  'utf-8',
);

describe('Codex transcript ingestion on Windows (#2192)', () => {
  it('normalizes backslashes to forward slashes before passing the path to globSync', () => {
    expect(watcherSource).toContain('normalizeGlobPattern');
    expect(watcherSource).toContain("inputPath.replace(/\\\\/g, '/')");
    expect(watcherSource).toMatch(/globSync\(this\.normalizeGlobPattern\(/);
  });

  it('exposes a public poke() on the file tailer so the recursive root watcher can prod it', () => {
    expect(watcherSource).toMatch(/\bpoke\(\): void\b/);
  });

  it('pokes an existing tailer on root-watcher events instead of returning early', () => {
    // The recursive root watcher must call poke() on existing tailers, not
    // skip them — Windows fs.watch on the file itself misses appends.
    expect(watcherSource).toMatch(/existingTailer\.poke\(\)/);
  });

  it('normalizes the resolved path to forward slashes before tailer-map lookup', () => {
    // Without this, the lookup key (native path.resolve) won't match the
    // stored key (forward-slash from glob), and every append looks like a
    // new file.
    expect(watcherSource).toMatch(/resolvePath\(watchRoot, name\)\.replace\(\/\\\\\/g, '\/'\)/);
  });

  it('requeues in-flight processing rows when the generator aborts (queue self-deadlock fix)', () => {
    // After abort, processingMessageIds entries must go through markFailed so
    // the retry ladder can either requeue them as 'pending' or terminate
    // them — leaving them in 'processing' under the live worker's PID is
    // the deadlock #2192 reports.
    expect(sessionRoutesSource).toMatch(/Generator aborted/);
    expect(sessionRoutesSource).toMatch(/processingMessageIds\.slice\(\)/);
    expect(sessionRoutesSource).toMatch(/inflightStore\.markFailed\(messageId\)/);
  });
});
