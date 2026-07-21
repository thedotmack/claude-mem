import { describe, it, expect } from 'bun:test';
import { compareVersionDescending } from '../../src/shared/worker-utils.js';

// Regression test for issue #2424: an in-place plugin update can leave two
// cache/thedotmack/claude-mem/<version> directories with identical mtimes
// (both extracted in the same update pass). cacheWorkerScriptCandidates()
// used to sort candidates by directory mtime, so a tie left the sort order —
// and therefore which version's worker-service.cjs got spawned — undefined.
// It now sorts by the version directory name itself via this comparator, so
// mtime ties (or even reversed mtimes) can never pick a stale version.

describe('compareVersionDescending', () => {
  it('orders a higher minor version before a lower one', () => {
    expect(compareVersionDescending('13.11.0', '13.10.2')).toBeLessThan(0);
    expect(compareVersionDescending('13.10.2', '13.11.0')).toBeGreaterThan(0);
  });

  it('orders a higher patch version before a lower one', () => {
    expect(compareVersionDescending('13.10.3', '13.10.2')).toBeLessThan(0);
  });

  it('orders a higher major version before a lower one regardless of minor/patch', () => {
    expect(compareVersionDescending('14.0.0', '13.99.99')).toBeLessThan(0);
  });

  it('treats equal versions as equal', () => {
    expect(compareVersionDescending('13.11.0', '13.11.0')).toBe(0);
  });

  it('sorts a realistic cache-directory listing to the highest version first', () => {
    const dirs = ['13.9.0', '13.11.0', '13.10.2', '13.10.10'];
    expect([...dirs].sort(compareVersionDescending)).toEqual([
      '13.11.0',
      '13.10.10',
      '13.10.2',
      '13.9.0',
    ]);
  });
});
