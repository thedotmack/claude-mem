import { bunVersionHonoursBunBeBun } from '../../launcher/bun-be-bun-support.js';

/** The virtual entry path identifies an embedded runtime even when its binary
 * is named bun.exe. A newer Bun installed on PATH cannot upgrade that runtime. */
export function deepSearchRuntimeSupported(
  version = process.versions.bun,
  main = typeof Bun === 'undefined' ? '' : Bun.main,
): boolean {
  if (!version) return false;
  const embedded = /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(main);
  return !embedded || bunVersionHonoursBunBeBun(version);
}
