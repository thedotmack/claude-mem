import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { cacheVersionDirsDesc, staleCacheVersionDirs, pruneStaleCacheVersionDirs } from '../../src/shared/worker-utils.js';

const tempDirs: string[] = [];

function makeCache(versions: string[]): string {
  const root = path.join(tmpdir(), `claude-mem-cacheprune-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tempDirs.push(root);
  for (const v of versions) {
    mkdirSync(path.join(root, v, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, v, 'scripts', 'worker-service.cjs'), '// stub');
  }
  return root;
}
const versionsOf = (dirs: string[]) => dirs.map(d => path.basename(d));

describe('cache prune helpers (#3216 L1 reconciliation)', () => {
  afterEach(() => {
    while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  it('cacheVersionDirsDesc lists version dirs highest-semver first', () => {
    const root = makeCache(['13.4.0', '13.11.0', '13.10.4', '13.9.2']);
    expect(versionsOf(cacheVersionDirsDesc(root))).toEqual(['13.11.0', '13.10.4', '13.9.2', '13.4.0']);
  });

  it('staleCacheVersionDirs returns every dir except the highest', () => {
    const root = makeCache(['13.4.0', '13.11.0', '13.10.4']);
    expect(versionsOf(staleCacheVersionDirs(root))).toEqual(['13.10.4', '13.4.0']);
  });

  it('staleCacheVersionDirs is empty for a single-version cache', () => {
    const root = makeCache(['13.11.0']);
    expect(staleCacheVersionDirs(root)).toEqual([]);
  });

  it('pruneStaleCacheVersionDirs deletes stale dirs and keeps the highest', () => {
    const root = makeCache(['13.4.0', '13.11.0', '13.10.4']);
    const deleted = pruneStaleCacheVersionDirs(root);
    expect(versionsOf(deleted).sort()).toEqual(['13.10.4', '13.4.0'].sort());
    expect(existsSync(path.join(root, '13.11.0'))).toBe(true);   // highest kept
    expect(existsSync(path.join(root, '13.10.4'))).toBe(false);  // stale removed
    expect(existsSync(path.join(root, '13.4.0'))).toBe(false);
  });
});
