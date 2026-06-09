import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import path from 'path';
import os from 'os';
import { writeFileSync, readFileSync, mkdtempSync, existsSync, rmSync } from 'fs';
import {
  getProjectName,
  resetEnvironmentsCache,
  setEnvironmentsSettingsPathForTesting,
} from '../src/utils/project-name.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import type { Environment } from '../src/shared/SettingsDefaultsManager.js';

let TEMP_DIR = '';
let SETTINGS_PATH = '';

function writeEnvironments(envs: Environment[]) {
  const defaults = SettingsDefaultsManager.getAllDefaults();
  const merged = { ...defaults, environments: JSON.stringify(envs) };
  writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  resetEnvironmentsCache();
}

function clearEnvironments() {
  writeEnvironments([]);
}

beforeAll(() => {
  TEMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'claude-mem-env-test-'));
  SETTINGS_PATH = path.join(TEMP_DIR, 'settings.json');
  writeFileSync(SETTINGS_PATH, JSON.stringify(SettingsDefaultsManager.getAllDefaults(), null, 2));
  setEnvironmentsSettingsPathForTesting(SETTINGS_PATH);
});

afterAll(() => {
  setEnvironmentsSettingsPathForTesting(null);
  if (TEMP_DIR && existsSync(TEMP_DIR)) {
    rmSync(TEMP_DIR, { recursive: true, force: true });
  }
});

describe('getProjectName environment matching', () => {
  afterEach(() => {
    clearEnvironments();
  });

  test('no environments — falls back to basename', () => {
    clearEnvironments();
    expect(getProjectName('/Users/anyone/company-a')).toBe('company-a');
  });

  test('cwd matches environment pattern — returns environment name', () => {
    writeEnvironments([{ name: 'work', patterns: ['/Users/anyone/company-*'] }]);
    expect(getProjectName('/Users/anyone/company-a')).toBe('work');
  });

  test('cwd matches first environment — first match wins', () => {
    writeEnvironments([
      { name: 'work', patterns: ['/Users/anyone/projects/shared-*'] },
      { name: 'personal', patterns: ['/Users/anyone/projects/*'] },
    ]);
    expect(getProjectName('/Users/anyone/projects/shared-lib')).toBe('work');
  });

  test('cwd does not match any pattern — falls back to basename', () => {
    writeEnvironments([{ name: 'work', patterns: ['/Users/anyone/company-*'] }]);
    expect(getProjectName('/Users/anyone/random-dir')).toBe('random-dir');
  });

  test('~ expansion works correctly', () => {
    const home = os.homedir();
    writeEnvironments([{ name: 'work', patterns: ['~/workspace/harness/*'] }]);
    expect(getProjectName(path.join(home, 'workspace', 'harness', 'claude-mem'))).toBe('work');
  });

  test('pattern with * matches one level only', () => {
    const home = os.homedir();
    writeEnvironments([{ name: 'work', patterns: ['~/workspace/*'] }]);
    expect(getProjectName(path.join(home, 'workspace', 'harness'))).toBe('work');
    expect(getProjectName(path.join(home, 'workspace', 'harness', 'claude-mem'))).toBe('claude-mem');
  });

  test('pattern with ** matches any depth', () => {
    const home = os.homedir();
    writeEnvironments([{ name: 'work', patterns: ['~/workspace/**'] }]);
    expect(getProjectName(path.join(home, 'workspace', 'harness', 'claude-mem'))).toBe('work');
  });

  test('empty cwd — returns unknown-project', () => {
    clearEnvironments();
    expect(getProjectName(null)).toBe('unknown-project');
    expect(getProjectName('')).toBe('unknown-project');
  });

  test('user real settings.json is NEVER touched', () => {
    const realSettingsPath = path.join(os.homedir(), '.claude-mem', 'settings.json');
    if (!existsSync(realSettingsPath)) return;
    const before = readFileSync(realSettingsPath, 'utf-8');
    writeEnvironments([{ name: 'should-not-leak', patterns: ['/tmp/**'] }]);
    clearEnvironments();
    const after = readFileSync(realSettingsPath, 'utf-8');
    expect(after).toBe(before);
  });

  test('environments as native array (documented config format) works', () => {
    // Greptile P1: the documented config form is a JSON array, not a string.
    // After loadFromFile JSON.parses settings.json, environments is already
    // an array — loadEnvironments must accept that without re-parsing.
    const defaults = SettingsDefaultsManager.getAllDefaults();
    const merged = { ...defaults, environments: [{ name: 'work', patterns: ['/Users/anyone/company-*'] }] };
    writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
    resetEnvironmentsCache();
    expect(getProjectName('/Users/anyone/company-a')).toBe('work');
  });

  test('environments as JSON string also works', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    const merged = { ...defaults, environments: JSON.stringify([{ name: 'work', patterns: ['/Users/anyone/company-*'] }]) };
    writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
    resetEnvironmentsCache();
    expect(getProjectName('/Users/anyone/company-a')).toBe('work');
  });
});
