import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, parse } from 'node:path';
import { workspaceScope } from '../../../src/services/history-import/workspace.js';

test('workspace discovery checks real checkout paths, nested repositories and exclusions', () => {
  const base = mkdtempSync(join(tmpdir(), 'dated-import-scope-'));
  try {
    const root = join(base, 'owner', 'app');
    const other = join(base, 'other', 'app');
    const sub = join(root, 'src');
    const privateDir = join(root, 'private');
    const nested = join(root, 'vendor', 'module');
    for (const dir of [other, sub, privateDir, join(nested, '.git')]) mkdirSync(dir, { recursive: true });
    const scope = workspaceScope(root, privateDir);
    expect(scope.accepts(root)).toBe(true);
    expect(scope.accepts(sub)).toBe(true);
    expect(scope.accepts(other)).toBe(false);
    expect(scope.accepts(join(root, 'missing'))).toBe(false);
    expect(scope.accepts('app')).toBe(false);
    expect(scope.accepts('')).toBe(false);
    expect(scope.accepts(privateDir)).toBe(false);
    expect(scope.accepts(nested)).toBe(false);
    const link = join(root, 'external');
    symlinkSync(other, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(scope.accepts(link)).toBe(false);
    expect(() => workspaceScope(homedir(), '')).toThrow();
    expect(() => workspaceScope(parse(root).root, '')).toThrow();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
