import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { cacheWorkerScriptCandidates } from '../../src/shared/worker-utils.js';

function makeTempDir(): string {
  return path.join(tmpdir(), `claude-mem-resolver-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const tempDirs: string[] = [];

/** Extract the version-dir segment from a returned candidate path. */
function versionOf(candidatePath: string, cacheRoot: string): string {
  return path.relative(cacheRoot, candidatePath).split(path.sep)[0];
}

describe('cacheWorkerScriptCandidates — worker script resolution order', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression contract for the chroma-mcp orphan leak's *trigger* (issue
  // #3216): resolving the worker script by directory mtime instead of semver
  // manufactures a permanent plugin<->worker version skew, which drives the
  // recycle loop that leaks chroma. The resolver MUST pick by semver and
  // ignore mtime, or the skew (and the leak) returns.
  it('orders cache dirs by descending semver, not filesystem mtime', () => {
    const cacheRoot = makeTempDir();
    tempDirs.push(cacheRoot);

    // Ascending semver. 13.10.x must sort ABOVE 13.9.2 (numeric, not
    // lexicographic) and 13.11.0 is highest — the real cache on the affected box.
    const versionsAscending = ['13.4.0', '13.9.2', '13.10.0', '13.10.4', '13.11.0'];

    versionsAscending.forEach((version, index) => {
      const scriptsDir = path.join(cacheRoot, version, 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(path.join(scriptsDir, 'worker-service.cjs'), '// stub');
      // Invert mtime vs semver: the LOWEST semver (13.4.0, index 0) is the
      // mtime-NEWEST dir, the highest (13.11.0) the oldest. A mtime-sort resolver
      // returns 13.4.0 first (the shipped bug); a semver resolver returns 13.11.0.
      const mtime = new Date(2026, 0, 1, 0, 0, versionsAscending.length - index);
      utimesSync(path.join(cacheRoot, version), mtime, mtime);
    });

    const orderedVersions = cacheWorkerScriptCandidates(cacheRoot).map(c => versionOf(c, cacheRoot));

    expect(orderedVersions).toEqual(['13.11.0', '13.10.4', '13.10.0', '13.9.2', '13.4.0']);
  });
});
