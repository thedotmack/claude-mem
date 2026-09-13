import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodebaseMap, renderPrimingBlock } from '../src/learn.ts';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cmem-learn-'));
  writeFileSync(join(root, 'main.py'), 'def add(a, b):\n    return a + b\n');
  mkdirSync(join(root, 'pkg'), { recursive: true });
  writeFileSync(join(root, 'pkg', 'util.ts'), 'export const x = 1;\n');
  // ignored dir + non-source file
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = {}\n');
  writeFileSync(join(root, 'README.md'), '# not source\n');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('buildCodebaseMap', () => {
  test('reads source files and ignores node_modules + non-source', () => {
    const map = buildCodebaseMap(root);
    const paths = map.files.map((f) => f.path).sort();
    expect(paths).toEqual(['main.py', join('pkg', 'util.ts')].sort());
    expect(map.totalFilesRead).toBe(2);
    expect(map.droppedForBudget).toBe(0);
  });

  test('honors maxFiles and reports the drop', () => {
    const map = buildCodebaseMap(root, { maxFiles: 1 });
    expect(map.totalFilesRead).toBe(1);
    expect(map.droppedForBudget).toBe(1);
  });

  test('truncates oversized files', () => {
    const big = mkdtempSync(join(tmpdir(), 'cmem-big-'));
    writeFileSync(join(big, 'big.py'), 'x = 1\n'.repeat(10000));
    const map = buildCodebaseMap(big, { maxBytesPerFile: 100 });
    expect(map.files[0]!.truncated).toBe(true);
    expect(map.files[0]!.bytes).toBeLessThanOrEqual(100);
    rmSync(big, { recursive: true, force: true });
  });
});

describe('renderPrimingBlock', () => {
  test('includes the skill header, file tree, and file bodies', () => {
    const block = renderPrimingBlock(buildCodebaseMap(root));
    expect(block).toContain('/learn-codebase');
    expect(block).toContain('## File tree');
    expect(block).toContain('main.py');
    expect(block).toContain('def add');
  });

  test('announces bounded coverage when files are dropped', () => {
    const block = renderPrimingBlock(buildCodebaseMap(root, { maxFiles: 1 }));
    expect(block).toMatch(/were NOT read due to the priming budget/);
  });
});
