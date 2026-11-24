import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import { tmpdir } from 'os';
import path from 'path';
import {
  getOpenClawConfigDirectory,
  getOpenClawConfigFilePath,
  installOpenClawPlugin,
  uninstallOpenClawPlugin,
} from '../../src/services/integrations/OpenClawInstaller.js';

const ENV_KEYS = ['OPENCLAW_HOME', 'OPENCLAW_PROFILE', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'] as const;

// The memory slot in openclaw.json belongs to the user, not to whichever plugin
// was installed last. Install has to remember the value it displaces, and
// uninstall has to put it back.
describe('OpenClaw install and uninstall preserve the memory slot owner', () => {
  let tmp: string;
  let configPath: string;
  let spies: Array<ReturnType<typeof spyOn>>;
  let previous: Array<[string, string | undefined]>;

  beforeEach(() => {
    previous = ENV_KEYS.map(key => [key, process.env[key]]);
    for (const key of ENV_KEYS) delete process.env[key];
    tmp = mkdtempSync(path.join(tmpdir(), 'openclaw-slot-'));
    configPath = path.join(tmp, '.openclaw', 'openclaw.json');
    spies = [
      spyOn(console, 'log').mockImplementation(() => {}),
      spyOn(console, 'error').mockImplementation(() => {}),
      spyOn(os, 'homedir').mockReturnValue(tmp),
    ];
    if (getOpenClawConfigDirectory() !== path.join(tmp, '.openclaw') ||
        getOpenClawConfigFilePath() !== configPath) {
      throw new Error('OpenClaw paths are not isolated; refusing to modify real settings');
    }
  });

  afterEach(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const spy of spies) spy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('restores the previous memory-slot owner on uninstall', () => {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      plugins: {
        slots: { memory: 'other-memory-plugin' },
        entries: {},
      },
    }, null, 2) + '\n');

    expect(installOpenClawPlugin()).toBe(0);

    const installed = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(installed.plugins.slots.memory).toBe('claude-mem');
    expect(installed.plugins.entries['claude-mem'].config.previousMemorySlot).toBe('other-memory-plugin');

    expect(uninstallOpenClawPlugin()).toBe(0);

    const removed = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(removed.plugins.entries['claude-mem']).toBeUndefined();
    expect(removed.plugins.slots.memory).toBe('other-memory-plugin');
  });

  it('keeps the remembered owner across a reinstall', () => {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      plugins: { slots: { memory: 'other-memory-plugin' }, entries: {} },
    }, null, 2) + '\n');

    expect(installOpenClawPlugin()).toBe(0);
    expect(installOpenClawPlugin()).toBe(0);

    const reinstalled = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(reinstalled.plugins.entries['claude-mem'].config.previousMemorySlot).toBe('other-memory-plugin');

    expect(uninstallOpenClawPlugin()).toBe(0);
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).plugins.slots.memory).toBe('other-memory-plugin');
  });
});