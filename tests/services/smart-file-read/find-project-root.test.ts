import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findProjectRoot } from '../../../src/services/smart-file-read/parser.js';

describe('findProjectRoot', () => {
  it('finds the nearest ancestor containing .claude-mem.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-root-'));
    try {
      writeFileSync(join(root, '.claude-mem.json'), '{}');
      const nested = join(root, 'src', 'deep');
      mkdirSync(nested, { recursive: true });
      const file = join(nested, 'file.cs');
      writeFileSync(file, 'class A {}');
      expect(findProjectRoot(file)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns undefined when no config exists up the tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-none-'));
    try {
      const file = join(root, 'file.ts');
      writeFileSync(file, 'export {}');
      expect(findProjectRoot(file)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
