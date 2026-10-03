import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { IS_WINDOWS_PLATFORM, writeTextFileAtomic } from '../../src/shared/atomic-json.js';

/**
 * writeTextFileAtomic is the temp-file → fsync → rename sequence that
 * writeJsonFileAtomic now delegates to; tests/write-json-file-atomic.test.ts
 * still pins the JSON wrapper's bytes. These cover the text entry point the
 * Toolkit uses for generated scripts.
 */
describe('writeTextFileAtomic', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-atomic-text-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes the text byte for byte, adding no trailing newline', () => {
    const target = join(tempDir, 'run.sh');
    const script = '#!/usr/bin/env bash\nset -euo pipefail\necho "héllo — ✓"';

    writeTextFileAtomic(target, script);

    expect(readFileSync(target, 'utf-8')).toBe(script);
  });

  it('replaces existing content without leaving a temp file behind', () => {
    const target = join(tempDir, 'SKILL.md');
    writeTextFileAtomic(target, 'first\n');
    writeTextFileAtomic(target, 'second\n');

    expect(readFileSync(target, 'utf-8')).toBe('second\n');
    const leftovers = readdirSync(tempDir).filter(name => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('creates parent directories and the file with the requested mode', () => {
    if (IS_WINDOWS_PLATFORM) return;
    const target = join(tempDir, 'nested', 'tool', 'notes.txt');

    writeTextFileAtomic(target, 'notes\n', { mode: 0o600 });

    expect(readFileSync(target, 'utf-8')).toBe('notes\n');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('makes a script executable when asked for mode 0o755', () => {
    if (IS_WINDOWS_PLATFORM) return;
    const target = join(tempDir, 'run.sh');

    writeTextFileAtomic(target, '#!/usr/bin/env bash\necho ok\n', { mode: 0o755 });

    // The umask can only clear bits, so the owner's execute bit can only have
    // come from the requested mode (a plain new file is created rw-).
    expect(statSync(target).mode & 0o700).toBe(0o700);
    const leftovers = readdirSync(tempDir).filter(name => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('cleans up the temp file when the rename step fails', () => {
    // A directory at the destination makes renameSync fail after the temp file
    // was written, which forces the catch-block cleanup.
    const target = join(tempDir, 'run.sh');
    mkdirSync(target);

    expect(() => writeTextFileAtomic(target, 'echo never\n')).toThrow();

    const leftovers = readdirSync(tempDir).filter(name => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect(statSync(target).isDirectory()).toBe(true);
  });
});
