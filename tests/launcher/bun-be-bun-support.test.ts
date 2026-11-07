import { describe, it, expect } from 'bun:test';
import { bunVersionHonoursBunBeBun, bunVersionHonoursMacosSignatureFix } from '../../src/launcher/bun-be-bun-support.js';

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

// #5247 (suggestion 2): macOS 27 kills a launcher whose signature it rejects.
// Bun below 1.4.1 rebuilds into the same kill, so the installer must name
// `bun upgrade` rather than another reinstall.
describe('bunVersionHonoursMacosSignatureFix', () => {
  it('is true from Bun 1.4.1 on, including later minors and majors', () => {
    for (const bunVersion of ['1.4.1', '1.4.2', '1.5.0', '1.10.0', '2.0.0', '1.4.1-canary.3']) {
      expect(bunVersionHonoursMacosSignatureFix(bunVersion)).toBe(true);
    }
  });

  it('is false below Bun 1.4.1, and for anything unparseable', () => {
    for (const bunVersion of ['1.4.0', '1.3.9', '1.2.16', '0.9.0', '', 'garbage', undefined]) {
      expect(bunVersionHonoursMacosSignatureFix(bunVersion)).toBe(false);
    }
  });
});
