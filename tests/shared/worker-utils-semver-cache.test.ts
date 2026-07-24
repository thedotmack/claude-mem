import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  cacheWorkerScriptCandidates,
  compareVersionsDescending,
} from '../../src/shared/worker-utils.js';

describe('cache version resolve (#3298 / version oracle)', () => {
  it('compareVersionsDescending ranks higher semver first', () => {
    expect(compareVersionsDescending('13.11.0', '13.10.4')).toBeLessThan(0);
    expect(compareVersionsDescending('13.10.4', '13.11.0')).toBeGreaterThan(0);
    expect(compareVersionsDescending('13.11.0', '13.11.0')).toBe(0);
  });

  describe('cacheWorkerScriptCandidates', () => {
    let cacheRoot: string;

    beforeEach(() => {
      cacheRoot = mkdtempSync(join(tmpdir(), 'cm-semver-cache-'));
    });

    afterEach(() => {
      rmSync(cacheRoot, { recursive: true, force: true });
    });

    function seedVersion(version: string, mtimeSec: number): string {
      const dir = join(cacheRoot, version);
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scripts', 'worker-service.cjs'), '// stub\n');
      utimesSync(dir, mtimeSec, mtimeSec);
      return dir;
    }

    it('picks higher semver even when older version has newer mtime', () => {
      seedVersion('13.10.4', 2_000_000_000);
      seedVersion('13.11.0', 1_000_000_000);
      const candidates = cacheWorkerScriptCandidates(cacheRoot);
      expect(candidates[0]?.version).toBe('13.11.0');
      expect(candidates.map(c => c.version)).toEqual(['13.11.0', '13.10.4']);
    });
  });
});
