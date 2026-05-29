import { describe, test, expect, afterEach } from 'bun:test';
import path from 'path';
import { homedir } from 'os';
import { writeFileSync } from 'fs';
import { getProjectName, resetEnvironmentsCache } from '../src/utils/project-name.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import type { Environment } from '../src/shared/SettingsDefaultsManager.js';

const HOME = homedir();
const SETTINGS_PATH = path.join(HOME, '.claude-mem', 'settings.json');

function writeEnvironments(envs: Environment[]) {
  const existing = SettingsDefaultsManager.loadFromFile(SETTINGS_PATH);
  existing.environments = JSON.stringify(envs);
  writeFileSync(SETTINGS_PATH, JSON.stringify(existing, null, 2));
  resetEnvironmentsCache();
}

function clearEnvironments() {
  writeEnvironments([]);
  resetEnvironmentsCache();
}

describe('getProjectName environment matching', () => {
  afterEach(() => {
    clearEnvironments();
  });

  test('no environments — falls back to basename', () => {
    clearEnvironments();
    expect(getProjectName(path.join(HOME, 'company-a'))).toBe('company-a');
  });

  test('cwd matches environment pattern — returns environment name', () => {
    writeEnvironments([{ name: 'work', patterns: ['~/company-*'] }]);
    expect(getProjectName(path.join(HOME, 'company-a'))).toBe('work');
  });

  test('cwd matches first environment — first match wins', () => {
    writeEnvironments([
      { name: 'work', patterns: ['~/projects/shared-*'] },
      { name: 'personal', patterns: ['~/projects/*'] },
    ]);
    expect(getProjectName(path.join(HOME, 'projects', 'shared-lib'))).toBe('work');
  });

  test('cwd does not match any pattern — falls back to basename', () => {
    writeEnvironments([{ name: 'work', patterns: ['~/company-*'] }]);
    expect(getProjectName(path.join(HOME, 'random-dir'))).toBe('random-dir');
  });

  test('~ expansion works correctly', () => {
    writeEnvironments([{ name: 'work', patterns: ['~/workspace/harness/*'] }]);
    expect(getProjectName(path.join(HOME, 'workspace', 'harness', 'claude-mem'))).toBe('work');
  });

  test('pattern with * matches one level only', () => {
    writeEnvironments([{ name: 'work', patterns: ['~/workspace/*'] }]);
    expect(getProjectName(path.join(HOME, 'workspace', 'harness'))).toBe('work');
    // * should NOT match nested subdirectories
    expect(getProjectName(path.join(HOME, 'workspace', 'harness', 'claude-mem'))).toBe('claude-mem');
  });

  test('pattern with ** matches any depth', () => {
    writeEnvironments([{ name: 'work', patterns: ['~/workspace/**'] }]);
    expect(getProjectName(path.join(HOME, 'workspace', 'harness', 'claude-mem'))).toBe('work');
  });

  test('empty cwd — returns unknown-project', () => {
    clearEnvironments();
    expect(getProjectName(null)).toBe('unknown-project');
    expect(getProjectName('')).toBe('unknown-project');
  });
});