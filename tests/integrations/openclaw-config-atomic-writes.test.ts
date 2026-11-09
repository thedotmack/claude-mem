import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import * as os from 'os';
import { tmpdir } from 'os';
import path from 'path';
import {
  getOpenClawConfigDirectory,
  uninstallOpenClawPlugin,
} from '../../src/services/integrations/OpenClawInstaller.js';

// openclaw.json is the user's own config, shared with every other OpenClaw
// plugin. The uninstall rewrote it with a plain writeFileSync, which truncates
// in place: an interrupted uninstall could leave a half-written file that
// OpenClaw then refuses to load. A temp-file-plus-rename write yields a new
// file; an in-place truncate keeps the same one.
describe('OpenClaw writes openclaw.json atomically', () => {
  let tmp: string;
  let configPath: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let homedirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'openclaw-atomic-'));
    configPath = path.join(tmp, '.openclaw', 'openclaw.json');
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    homedirSpy = spyOn(os, 'homedir').mockReturnValue(tmp);
    // Fail before any write if the homedir patch did not take: the installer
    // would otherwise touch the real ~/.openclaw.
    if (getOpenClawConfigDirectory() !== path.join(tmp, '.openclaw')) {
      throw new Error('homedir patch failed; refusing to run against the real ~/.openclaw');
    }
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    homedirSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('replaces openclaw.json instead of truncating it in place on uninstall', () => {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        slots: { memory: 'claude-mem' },
        entries: { 'claude-mem': { enabled: true }, other: { enabled: true } },
      },
    }, null, 2) + '\n');
    const first = statSync(configPath);

    expect(uninstallOpenClawPlugin()).toBe(0);
    const second = statSync(configPath);

    // Either signal proves the file was replaced, not rewritten: a fresh inode
    // on POSIX, or a new creation time where the filesystem reports one.
    expect(second.ino !== first.ino || second.birthtimeMs !== first.birthtimeMs).toBe(true);
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(parsed.plugins.entries.other).toEqual({ enabled: true });
    expect(parsed.plugins.entries['claude-mem']).toBeUndefined();
    expect(parsed.plugins.slots.memory).toBeUndefined();
  });
});