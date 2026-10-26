import { describe, it, expect } from 'bun:test';
import { bunVersionHonoursBunBeBun } from '../../src/launcher/bun-be-bun-support.js';

// #4933: BUN_BE_BUN only turns a `bun build --compile` binary into the bun CLI
// from Bun 1.2.16 on; older runtimes run the embedded entrypoint instead.
describe('bunVersionHonoursBunBeBun', () => {
  it('is true from Bun 1.2.16 on', () => {
    for (const bunVersion of ['1.2.16', '1.2.17', '1.3.0', '1.10.0', '1.4.3', '2.0.0', '1.3.0-canary.12']) {
      expect(bunVersionHonoursBunBeBun(bunVersion)).toBe(true);
    }
  });

  it('is false before Bun 1.2.16 and for anything unparseable', () => {
    for (const bunVersion of ['1.2.15', '1.2.4', '1.1.43', '0.9.0', '', 'garbage', undefined]) {
      expect(bunVersionHonoursBunBeBun(bunVersion)).toBe(false);
    }
  });
});
