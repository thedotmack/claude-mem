import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findOmpHookSourcePath, installOmpHooks, uninstallOmpHooks } from '../../src/services/integrations/OmpHooksInstaller.js';

const ENV_KEYS = ['OMP_PROFILE', 'PI_PROFILE', 'PI_CONFIG_DIR', 'PI_CODING_AGENT_DIR', 'CLAUDE_MEM_DEV_HOOK_SOURCE'] as const;
const hookAt = (agentDir: string) => path.join(agentDir, 'hooks', 'pre', 'claude-mem.ts');

// OMP v18.18.8 discovers user hooks only beneath getAgentDir(), including its
// active profile. These exercise the public installer and the copied module;
// no OMP process or worker is started, and no lifecycle callback is invoked.
describe('OMP installation follows the host-selected agent directory', () => {
  let root: string;
  let previous: Array<[string, string | undefined]>;
  let homeSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'omp-profile-install-'));
    previous = ENV_KEYS.map(key => [key, process.env[key]]);
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.CLAUDE_MEM_DEV_HOOK_SOURCE = '1';
    homeSpy = spyOn(os, 'homedir').mockReturnValue(root);
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
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

  function seedHook(agentDir: string, body: string): string {
    const file = hookAt(agentDir);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
    return file;
  }

  async function expectInstalledAndDiscoverable(agentDir: string): Promise<void> {
    expect(await installOmpHooks()).toBe(0);
    const destination = hookAt(agentDir);
    expect(existsSync(destination)).toBe(true);
    expect(readFileSync(destination, 'utf8')).toBe(readFileSync(findOmpHookSourcePath()!, 'utf8'));
    const discovered = readdirSync(path.dirname(destination)).filter(name => name.endsWith('.ts'));
    expect(discovered).toEqual(['claude-mem.ts']);
    const hook = await import(pathToFileURL(destination).href);
    const handlers: string[] = [];
    hook.default({ on: (name: string) => handlers.push(name) });
    expect(handlers).toContain('before_agent_start');
    expect(handlers).toContain('tool_result');
    expect(uninstallOmpHooks()).toBe(0);
    expect(existsSync(destination)).toBe(false);
  }

  it('installs and removes only the named profile, ahead of legacy and explicit agent overrides', async () => {
    process.env.OMP_PROFILE = ' work ';
    process.env.PI_PROFILE = 'legacy';
    process.env.PI_CONFIG_DIR = '.omp-config';
    process.env.PI_CODING_AGENT_DIR = path.join(root, 'custom-agent');
    const untouched = [
      seedHook(path.join(root, '.omp', 'agent'), 'default hook'),
      seedHook(path.join(root, '.omp-config', 'agent'), 'config-root default hook'),
      seedHook(path.join(root, '.omp-config', 'profiles', 'legacy', 'agent'), 'legacy hook'),
      seedHook(process.env.PI_CODING_AGENT_DIR, 'explicit hook'),
    ];
    const before = untouched.map(file => readFileSync(file, 'utf8'));

    await expectInstalledAndDiscoverable(path.join(root, '.omp-config', 'profiles', 'work', 'agent'));
    expect(untouched.map(file => readFileSync(file, 'utf8'))).toEqual(before);
  });

  it('honors the legacy profile when OMP_PROFILE is absent', async () => {
    process.env.PI_PROFILE = 'legacy';
    await expectInstalledAndDiscoverable(path.join(root, '.omp', 'profiles', 'legacy', 'agent'));
    expect(existsSync(path.join(root, '.omp', 'agent'))).toBe(false);
  });

  it('uninstalls a preexisting selected profile without removing the default hook', () => {
    process.env.OMP_PROFILE = 'work';
    const selected = seedHook(path.join(root, '.omp', 'profiles', 'work', 'agent'), 'selected hook');
    const defaultFile = seedHook(path.join(root, '.omp', 'agent'), 'default hook');
    expect(uninstallOmpHooks()).toBe(0);
    expect(existsSync(selected)).toBe(false);
    expect(readFileSync(defaultFile, 'utf8')).toBe('default hook');
  });

  it('honors a custom config root in the default profile', async () => {
    process.env.PI_CONFIG_DIR = '.omp-config';
    await expectInstalledAndDiscoverable(path.join(root, '.omp-config', 'agent'));
    expect(existsSync(path.join(root, '.omp', 'agent'))).toBe(false);
  });

  it('keeps explicit default selection out of an inherited legacy profile directory', async () => {
    process.env.OMP_PROFILE = '';
    process.env.PI_PROFILE = 'work';
    process.env.PI_CODING_AGENT_DIR = path.join(root, '.omp', 'profiles', 'work', 'agent');
    const profileFile = seedHook(process.env.PI_CODING_AGENT_DIR, 'profile hook');
    await expectInstalledAndDiscoverable(path.join(root, '.omp', 'agent'));
    expect(readFileSync(profileFile, 'utf8')).toBe('profile hook');
  });

  it('preserves a real agent override when the default profile is explicitly selected', async () => {
    process.env.OMP_PROFILE = ' default ';
    process.env.PI_PROFILE = 'work';
    process.env.PI_CODING_AGENT_DIR = path.join(root, 'custom-agent');
    await expectInstalledAndDiscoverable(process.env.PI_CODING_AGENT_DIR);
    expect(existsSync(path.join(root, '.omp'))).toBe(false);
  });

  it('fails invalid active profiles without changing any installed hook', async () => {
    const defaultFile = seedHook(path.join(root, '.omp', 'agent'), 'default hook');
    for (const profile of ['../outside', 'Work', 'work.', 'con.txt']) {
      process.env.OMP_PROFILE = profile;
      expect(await installOmpHooks()).toBe(1);
      expect(uninstallOmpHooks()).toBe(1);
      expect(readFileSync(defaultFile, 'utf8')).toBe('default hook');
    }
  });
});
