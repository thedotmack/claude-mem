import { describe, it, expect } from 'bun:test';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import {
  AUTO_CLEAR_DEFAULT_PERCENT,
  defaultDataDir,
  expandHomePath,
  parseAutoClearPercent,
  parseSettingsJson,
  redirectedDataDir,
  resolveAutoClearSettings,
} from '../../src/mods/auto-clear/settings.js';

describe('auto-clear settings', () => {
  it('ships off, at 33%, matching SettingsDefaultsManager', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_AUTO_CLEAR_ENABLED).toBe('false');
    expect(defaults.CLAUDE_MEM_AUTO_CLEAR_PERCENT).toBe(String(AUTO_CLEAR_DEFAULT_PERCENT));
    expect(resolveAutoClearSettings({ env: {}, document: null })).toEqual({ enabled: false, percent: 33 });
    expect(resolveAutoClearSettings({ env: {}, document: { CLAUDE_MEM_AUTO_CLEAR_PERCENT: '40' } }).enabled).toBe(false);
  });

  it('turns on only for an explicit true', () => {
    for (const value of ['true', 'TRUE', ' True ', true]) {
      expect(resolveAutoClearSettings({ env: {}, document: { CLAUDE_MEM_AUTO_CLEAR_ENABLED: value } }).enabled).toBe(true);
    }
    for (const value of ['false', '', 'yes', '1', 'on']) {
      expect(resolveAutoClearSettings({ env: {}, document: { CLAUDE_MEM_AUTO_CLEAR_ENABLED: value } }).enabled).toBe(false);
    }
    expect(resolveAutoClearSettings({ env: { CLAUDE_MEM_AUTO_CLEAR_ENABLED: 'true' }, document: null }).enabled).toBe(true);
  });

  it('reads a flat settings.json and a nested one the way SettingsDefaultsManager does', () => {
    const flat = parseSettingsJson('{"CLAUDE_MEM_AUTO_CLEAR_PERCENT":"50","CLAUDE_MEM_AUTO_CLEAR_ENABLED":"true"}');
    expect(resolveAutoClearSettings({ env: {}, document: flat })).toEqual({ enabled: true, percent: 50 });

    // Nested: the env block holds the CLAUDE_MEM_* keys, and root copies are stale.
    const nested = parseSettingsJson(JSON.stringify({
      CLAUDE_MEM_AUTO_CLEAR_PERCENT: '10',
      CLAUDE_MEM_AUTO_CLEAR_ENABLED: 'false',
      env: { CLAUDE_MEM_AUTO_CLEAR_PERCENT: '60', CLAUDE_MEM_AUTO_CLEAR_ENABLED: 'true', CLAUDE_MEM_MODEL: 'haiku' },
    }));
    expect(resolveAutoClearSettings({ env: {}, document: nested })).toEqual({ enabled: true, percent: 60 });
  });

  it('lets an environment variable win over settings.json', () => {
    const document = parseSettingsJson('{"CLAUDE_MEM_AUTO_CLEAR_PERCENT":"50","CLAUDE_MEM_AUTO_CLEAR_ENABLED":"true"}');
    expect(resolveAutoClearSettings({
      env: { CLAUDE_MEM_AUTO_CLEAR_PERCENT: '25', CLAUDE_MEM_AUTO_CLEAR_ENABLED: 'false' },
      document,
    })).toEqual({ enabled: false, percent: 25 });
  });

  it('is off when either auto-clear or work state is turned off', () => {
    expect(resolveAutoClearSettings({ env: {}, document: { CLAUDE_MEM_AUTO_CLEAR_ENABLED: 'FALSE' } }).enabled).toBe(false);
    expect(resolveAutoClearSettings({ env: {}, document: { CLAUDE_MEM_AUTO_CLEAR_ENABLED: 'true', CLAUDE_MEM_WORK_STATE_ENABLED: 'false' } }).enabled).toBe(false);
    expect(resolveAutoClearSettings({ env: { CLAUDE_MEM_AUTO_CLEAR_ENABLED: 'true', CLAUDE_MEM_WORK_STATE_ENABLED: 'false' }, document: null }).enabled).toBe(false);
  });

  it('accepts numbers and booleans written by hand', () => {
    expect(resolveAutoClearSettings({ env: {}, document: { CLAUDE_MEM_AUTO_CLEAR_PERCENT: 40, CLAUDE_MEM_AUTO_CLEAR_ENABLED: false } }))
      .toEqual({ enabled: false, percent: 40 });
  });

  it('falls back to 33% for a percent out of range or unreadable', () => {
    for (const value of [undefined, '', '0', '-5', '96', '100', 'half', 'NaN']) {
      expect(parseAutoClearPercent(value)).toBe(33);
    }
    expect(parseAutoClearPercent(' 1 ')).toBe(1);
    expect(parseAutoClearPercent('95')).toBe(95);
    expect(parseAutoClearPercent('12.5')).toBe(12.5);
  });

  it('parses settings.json with a BOM, and refuses anything but an object', () => {
    expect(parseSettingsJson('\uFEFF{"a":"1"}')).toEqual({ a: '1' });
    expect(parseSettingsJson('[]')).toBeNull();
    expect(parseSettingsJson('null')).toBeNull();
    expect(parseSettingsJson('{broken')).toBeNull();
  });

  it('finds settings.json where resolveDataDir does', () => {
    expect(defaultDataDir(undefined, '/home/ada')).toBe('/home/ada/.claude-mem');
    expect(defaultDataDir('~/mem', '/home/ada')).toBe('/home/ada/mem');
    expect(defaultDataDir('/srv/mem', '/home/ada')).toBe('/srv/mem');
    expect(defaultDataDir(undefined, undefined)).toBeNull();
    expect(defaultDataDir(undefined, 'C:\\Users\\ada')).toBe('C:\\Users\\ada/.claude-mem');

    // The home settings.json can move the data directory, unless the environment already did.
    const moved = { CLAUDE_MEM_DATA_DIR: '~/.claude-mem-work' };
    expect(redirectedDataDir(moved, undefined, '/home/ada')).toBe('/home/ada/.claude-mem-work');
    expect(redirectedDataDir(moved, '/srv/mem', '/home/ada')).toBeNull();
    expect(redirectedDataDir({ CLAUDE_MEM_DATA_DIR: '/home/ada/.claude-mem/' }, undefined, '/home/ada')).toBeNull();
    expect(redirectedDataDir({ CLAUDE_MEM_DATA_DIR: '' }, undefined, '/home/ada')).toBeNull();
    expect(redirectedDataDir(null, undefined, '/home/ada')).toBeNull();
  });

  it('expands ~ only at the start', () => {
    expect(expandHomePath('~', '/h')).toBe('/h');
    expect(expandHomePath('~/x', '/h')).toBe('/h/x');
    expect(expandHomePath('~\\x', 'C:\\h')).toBe('C:\\h/x');
    expect(expandHomePath('/a/~/b', '/h')).toBe('/a/~/b');
    expect(expandHomePath('~/x', undefined)).toBe('~/x');
  });
});
