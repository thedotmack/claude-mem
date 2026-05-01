import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

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
    expect(watcherSource).toMatch(/existingTailer\.poke\(\)/);
  });

  it('normalizes the resolved path to forward slashes before tailer-map lookup', () => {
    expect(watcherSource).toMatch(/resolvePath\(watchRoot, name\)\.replace\(\/\\\\\/g, '\/'\)/);
  });

  it('requeues in-flight processing rows when the generator aborts (queue self-deadlock fix)', () => {
    expect(sessionRoutesSource).toMatch(/Generator aborted/);
    expect(sessionRoutesSource).toMatch(/processingMessageIds\.slice\(\)/);
    expect(sessionRoutesSource).toMatch(/inflightStore\.markFailed\(messageId\)/);
  });
});
