import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, relative } from 'path';
import { findCodexExecutablePath } from '../../src/npx-cli/install/tool-path.js';

describe.skipIf(process.platform === 'win32')('findCodexExecutablePath with a configured path', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'codex-tool-path-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function writeCodex(mode: number): string {
    const path = join(directory, 'codex');
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, mode);
    return path;
  }

  it('accepts an executable file', () => {
    const path = writeCodex(0o755);
    expect(findCodexExecutablePath(path)).toBe(path);
  });

  it('rejects a file that exists but is not executable', () => {
    expect(findCodexExecutablePath(writeCodex(0o644))).toBeNull();
  });

  it('rejects a directory', () => {
    const path = join(directory, 'codex-directory');
    mkdirSync(path);
    expect(findCodexExecutablePath(path)).toBeNull();
  });

  it('rejects a ~ path even when the file exists, because the worker spawns it unexpanded', () => {
    const home = mkdtempSync(join(homedir(), '.codex-tool-path-'));
    try {
      const path = join(home, 'codex');
      writeFileSync(path, '#!/bin/sh\nexit 0\n');
      chmodSync(path, 0o755);
      expect(findCodexExecutablePath(`~/${relative(homedir(), path)}`)).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
