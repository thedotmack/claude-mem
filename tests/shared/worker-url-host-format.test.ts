import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

// A CLAUDE_MEM_WORKER_HOST of `::1` (or `::`) must be bracketed in a URL:
// `http://::1:37777` does not parse, so fetch() throws before it connects.
// formatHostForUrl (src/shared/worker-url.ts) does that; this guard keeps every
// worker URL built from a host value going through it.

const ROOT = join(import.meta.dir, '..', '..');

// Interpolations that are already formatted, or are not a worker URL at all.
const ALLOWED = new Set([
  'src/npx-cli/commands/install.ts:workerUrlHost', // = formatHostForUrl(workerHost)
  'src/services/worker/http/middleware.ts:rawHost', // the request's own Host header, in an error message
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full);
    return /\.(ts|tsx|js|cjs|mjs)$/.test(name) ? [full] : [];
  });
}

describe('worker URLs bracket IPv6 hosts', () => {
  it('builds every http://${host} URL with formatHostForUrl', () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'scripts'))]) {
      const rel = relative(ROOT, file).split(sep).join('/');
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        for (const match of line.matchAll(/http:\/\/\$\{([^}]+)\}/g)) {
          const expression = match[1].trim();
          if (expression.startsWith('formatHostForUrl(')) continue;
          if (ALLOWED.has(`${rel}:${expression}`)) continue;
          offenders.push(`${rel}:${index + 1} \${${expression}}`);
        }
      });
    }
    expect(offenders).toEqual([]);
    // Reads every file under src/ and scripts/: a cold file cache on Windows
    // took over 5 s, bun's default per-test timeout.
  }, 30_000);
});
