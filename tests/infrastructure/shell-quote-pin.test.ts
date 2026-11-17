import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { quote } from 'shell-quote';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), 'utf-8');
}

// shell-quote is pinned in four places (#4018). The build inlines the root copy
// into the hook bundles, build-hooks.js regenerates the plugin manifest, and the
// plugin install resolves from plugin/bun.lock. A bump that misses one of them
// lets the next build or install bring an affected version back.
function pinnedShellQuoteVersions(): Record<string, string | undefined> {
  const lock = read('plugin/bun.lock');
  return {
    'package.json': JSON.parse(read('package.json')).devDependencies?.['shell-quote'],
    'plugin/package.json': JSON.parse(read('plugin/package.json')).dependencies?.['shell-quote'],
    'scripts/build-hooks.js': read('scripts/build-hooks.js').match(/'shell-quote': '([^']+)'/)?.[1],
    'plugin/bun.lock (workspace)': lock.match(/"shell-quote": "([^"]+)",/)?.[1],
    'plugin/bun.lock (resolved)': lock.match(/"shell-quote": \["shell-quote@([^"]+)"/)?.[1],
  };
}

function isBefore(version: string, minimum: string): boolean {
  const a = version.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

describe('shell-quote pin', () => {
  it('is the same exact version in every place that pins it', () => {
    const versions = pinnedShellQuoteVersions();
    const distinct = new Set(Object.values(versions));
    expect(distinct.size).toBe(1);
    const [version] = distinct;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is outside the range affected by GHSA-pqg4-j6r4-53mv (CVE-2026-102422)', () => {
    const [version] = new Set(Object.values(pinnedShellQuoteVersions()));
    expect(isBefore(version!, '1.11.0')).toBe(false);
  });

  it('rejects a line terminator in a token after a comment', () => {
    // The advisory's reproduction. An affected version returns
    // "echo ok #x 'a\nid;#'", which a POSIX shell runs as `id`.
    const tokens = ['echo', 'ok', { comment: 'x' }, 'a\nid;#'] as unknown as string[];
    expect(() => quote(tokens)).toThrow();
  });
});
