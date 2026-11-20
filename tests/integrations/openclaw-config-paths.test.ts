import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import {
  getOpenClawConfigDirectory,
  getOpenClawConfigFilePath,
  getOpenClawClaudeMemExtensionDirectory,
  uninstallOpenClawPlugin,
} from '../../src/services/integrations/OpenClawInstaller.js';

const ENV_KEYS = ['OPENCLAW_HOME', 'OPENCLAW_PROFILE', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'] as const;

describe('OpenClaw selected config and state paths', () => {
  let root: string;
  let previous: Array<[string, string | undefined]>;
  let homeSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'openclaw-paths-'));
    previous = ENV_KEYS.map(key => [key, process.env[key]]);
    for (const key of ENV_KEYS) delete process.env[key];
    homeSpy = spyOn(os, 'homedir').mockReturnValue(root);
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    expect(getOpenClawConfigDirectory()).toBe(path.join(root, '.openclaw'));
  });

  afterEach(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    homeSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it('uninstalls the selected state/config without touching the default profile', () => {
    const selectedState = path.join(root, 'selected-state');
    const selectedConfig = path.join(root, 'separate-config', 'active.json');
    const defaultConfig = path.join(root, '.openclaw', 'openclaw.json');
    const defaultExtension = path.join(root, '.openclaw', 'extensions', 'claude-mem');
    const selectedExtension = path.join(selectedState, 'extensions', 'claude-mem');
    const config = JSON.stringify({ plugins: { slots: { memory: 'claude-mem' }, entries: {
      'claude-mem': { enabled: true }, other: { enabled: true },
    } } });
    for (const file of [defaultConfig, selectedConfig]) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, config);
    }
    for (const directory of [defaultExtension, selectedExtension]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'index.js'), 'export {};');
    }
    process.env.OPENCLAW_STATE_DIR = ` ${selectedState} `;
    process.env.OPENCLAW_CONFIG_PATH = ` ${selectedConfig} `;

    expect(uninstallOpenClawPlugin()).toBe(0);
    expect(existsSync(selectedExtension)).toBe(false);
    const active = JSON.parse(readFileSync(selectedConfig, 'utf8'));
    expect(active.plugins.entries['claude-mem']).toBeUndefined();
    expect(active.plugins.slots.memory).toBeUndefined();
    expect(active.plugins.entries.other).toEqual({ enabled: true });
    expect(readFileSync(defaultConfig, 'utf8')).toBe(config);
    expect(existsSync(defaultExtension)).toBe(true);
  });

  it('resolves home-relative overrides against the host-selected home', () => {
    process.env.OPENCLAW_HOME = path.join(root, 'host-home');
    process.env.OPENCLAW_STATE_DIR = '~/state';
    process.env.OPENCLAW_CONFIG_PATH = '~/config/active.json';
    expect(getOpenClawConfigDirectory()).toBe(path.join(root, 'host-home', 'state'));
    expect(getOpenClawClaudeMemExtensionDirectory()).toBe(path.join(root, 'host-home', 'state', 'extensions', 'claude-mem'));
    expect(getOpenClawConfigFilePath()).toBe(path.join(root, 'host-home', 'config', 'active.json'));
  });

  it('selects named profiles and lets an explicit state directory take precedence', () => {
    process.env.OPENCLAW_PROFILE = ' work ';
    expect(getOpenClawConfigDirectory()).toBe(path.join(root, '.openclaw-work'));
    expect(getOpenClawConfigFilePath()).toBe(path.join(root, '.openclaw-work', 'openclaw.json'));
    process.env.OPENCLAW_STATE_DIR = path.join(root, 'override');
    expect(getOpenClawConfigDirectory()).toBe(path.join(root, 'override'));
  });

  it('expands the host home itself before applying state and config paths', () => {
    process.env.OPENCLAW_HOME = ' ~/host-home ';
    process.env.OPENCLAW_STATE_DIR = '~/state';
    process.env.OPENCLAW_CONFIG_PATH = '~/config.json';
    expect(getOpenClawConfigDirectory()).toBe(path.join(root, 'host-home', 'state'));
    expect(getOpenClawConfigFilePath()).toBe(path.join(root, 'host-home', 'config.json'));
  });

  it('treats serialized missing home overrides as absent, as the host does', () => {
    for (const value of ['null', 'undefined', ' ']) {
      process.env.OPENCLAW_HOME = value;
      expect(getOpenClawConfigDirectory()).toBe(path.join(root, '.openclaw'));
    }
  });

  it('keeps default and invalid profile names in the default directory', () => {
    for (const profile of ['default', ' DEFAULT ', '../other', '']) {
      process.env.OPENCLAW_PROFILE = profile;
      expect(getOpenClawConfigDirectory()).toBe(path.join(root, '.openclaw'));
    }
  });
});
