import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { spawnSync } from 'child_process';
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

const OPENCLAW_DIR = path.join(import.meta.dir, '..', '..', 'openclaw');
const CONFIG_SCHEMA = JSON.parse(readFileSync(path.join(OPENCLAW_DIR, 'openclaw.plugin.json'), 'utf-8')).configSchema;

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * OpenClaw validates plugins.entries['claude-mem'].config against the manifest's
 * configSchema, which sets additionalProperties: false. Lists every top-level key
 * the schema does not declare or whose value has an undeclared JSON type.
 */
function configSchemaViolations(entryConfig: Record<string, unknown>): string[] {
  expect(CONFIG_SCHEMA.additionalProperties).toBe(false);
  const violations: string[] = [];
  for (const [key, value] of Object.entries(entryConfig)) {
    const declared = CONFIG_SCHEMA.properties[key];
    if (!declared) {
      violations.push(`${key}: not declared in configSchema`);
      continue;
    }
    const allowedTypes = [declared.type].flat();
    if (!allowedTypes.includes(jsonTypeOf(value))) {
      violations.push(`${key}: ${jsonTypeOf(value)} is not ${allowedTypes.join('|')}`);
    }
  }
  return violations;
}

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

  it('writes schema-valid settings with no backup key when nothing was displaced', () => {
    expect(installOpenClawPlugin()).toBe(0);

    const entryConfig = JSON.parse(readFileSync(configPath, 'utf-8')).plugins.entries['claude-mem'].config;
    expect(configSchemaViolations(entryConfig)).toEqual([]);
    expect('previousMemorySlot' in entryConfig).toBe(false);
  });

  it('writes schema-valid settings when it displaces another memory plugin', () => {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      plugins: { slots: { memory: 'other-memory-plugin' }, entries: {} },
    }, null, 2) + '\n');

    expect(installOpenClawPlugin()).toBe(0);

    const entryConfig = JSON.parse(readFileSync(configPath, 'utf-8')).plugins.entries['claude-mem'].config;
    expect(configSchemaViolations(entryConfig)).toEqual([]);
    expect(entryConfig.previousMemorySlot).toBe('other-memory-plugin');
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
/** Runs install.sh's configure_memory_slot function alone, against a throwaway HOME. */
function runConfigureMemorySlot(home: string): void {
  const script = readFileSync(path.join(OPENCLAW_DIR, 'install.sh'), 'utf-8');
  const match = script.match(/^configure_memory_slot\(\) \{\n[\s\S]*?\n\}\n/m);
  if (!match) throw new Error('configure_memory_slot() not found in openclaw/install.sh');
  const result = spawnSync('bash', ['-c', `set -euo pipefail\nsuccess() { :; }\ninfo() { :; }\n${match[0]}\nconfigure_memory_slot`], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`configure_memory_slot failed: ${result.stderr}`);
}

describe('openclaw install.sh configure_memory_slot preserves the memory slot owner', () => {
  const temps: string[] = [];
  afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function homeWithOpenClawConfig(config: unknown): { home: string; configPath: string } {
    const home = mkdtempSync(path.join(tmpdir(), 'openclaw-slot-sh-'));
    temps.push(home);
    const configPath = path.join(home, '.openclaw', 'openclaw.json');
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return { home, configPath };
  }

  it('records a displaced owner in schema-valid settings', () => {
    const { home, configPath } = homeWithOpenClawConfig({
      plugins: { slots: { memory: 'other-memory-plugin' }, entries: {} },
    });

    runConfigureMemorySlot(home);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const entryConfig = config.plugins.entries['claude-mem'].config;
    expect(config.plugins.slots.memory).toBe('claude-mem');
    expect(entryConfig.previousMemorySlot).toBe('other-memory-plugin');
    expect(configSchemaViolations(entryConfig)).toEqual([]);
  });

  it('adds no backup key when the slot was empty', () => {
    const { home, configPath } = homeWithOpenClawConfig({ plugins: {} });

    runConfigureMemorySlot(home);

    const entryConfig = JSON.parse(readFileSync(configPath, 'utf-8')).plugins.entries['claude-mem'].config;
    expect('previousMemorySlot' in entryConfig).toBe(false);
    expect(configSchemaViolations(entryConfig)).toEqual([]);
  });

  it('keeps the original owner on reinstall and survives the entry-level key scrub', () => {
    const { home, configPath } = homeWithOpenClawConfig({
      plugins: {
        slots: { memory: 'claude-mem' },
        entries: {
          'claude-mem': {
            enabled: true,
            staleEntryKey: true,
            config: { workerPort: 37777, previousMemorySlot: 'other-memory-plugin' },
          },
        },
      },
    });

    runConfigureMemorySlot(home);

    const entry = JSON.parse(readFileSync(configPath, 'utf-8')).plugins.entries['claude-mem'];
    expect(entry.staleEntryKey).toBeUndefined();
    expect(entry.config.previousMemorySlot).toBe('other-memory-plugin');
  });
});
