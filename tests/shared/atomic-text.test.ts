import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeTextFileAtomic } from '../../src/shared/atomic-json.js';

describe('writeTextFileAtomic', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-atomic-text-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes the text verbatim without JSON quoting', () => {
    const target = join(tempDir, 'bottle.md');
    const markdown = '# Session bottle\n\n**User**\n\nDo the "thing" — carefully.\n';

    writeTextFileAtomic(target, markdown);

    expect(readFileSync(target, 'utf-8')).toBe(markdown);
  });

  it('replaces existing content without leaving a temp file behind', () => {
    const target = join(tempDir, 'bottle.md');
    writeTextFileAtomic(target, 'first render\n');
    writeTextFileAtomic(target, 'second render\n');

    expect(readFileSync(target, 'utf-8')).toBe('second render\n');
    const leftovers = readdirSync(tempDir).filter(name => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('creates parent directories when they do not exist', () => {
    const target = join(tempDir, 'bottles', 'archive', 'bottle.md');
    writeTextFileAtomic(target, 'archived\n');

    expect(readFileSync(target, 'utf-8')).toBe('archived\n');
  });
});
