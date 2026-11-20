import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  registerOpenCodePluginInConfig,
  uninstallOpenCodePlugin,
} from '../../src/services/integrations/OpenCodeInstaller.js';

// OpenCode's opencode.json and AGENTS.md are user-owned files. Both config
// rewrites and the AGENTS.md context clean used a plain writeFileSync, which
// truncates in place: an interrupted install or uninstall could leave a
// half-written opencode.json that OpenCode then refuses to load. A temp-file-
// plus-rename write yields a new file; an in-place truncate keeps the same one.
describe('OpenCode writes its config and AGENTS.md atomically', () => {
  let tmp: string;
  let configPath: string;
  let agentsMdPath: string;
  let previousDir: string | undefined;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'opencode-atomic-'));
    configPath = path.join(tmp, 'opencode.json');
    agentsMdPath = path.join(tmp, 'AGENTS.md');
    previousDir = process.env.OPENCODE_CONFIG_DIR;
    process.env.OPENCODE_CONFIG_DIR = tmp;
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (previousDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previousDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  /** True when the write replaced the file rather than rewriting it in place. */
  function wasReplaced(before: ReturnType<typeof statSync>, after: ReturnType<typeof statSync>): boolean {
    return after.ino !== before.ino || after.birthtimeMs !== before.birthtimeMs;
  }

  it('replaces opencode.json instead of truncating it in place when registering', () => {
    writeFileSync(configPath, JSON.stringify({ theme: 'dark' }, null, 2) + '\n');
    const first = statSync(configPath);

    expect(registerOpenCodePluginInConfig()).toBe(0);
    const second = statSync(configPath);

    expect(wasReplaced(first, second)).toBe(true);
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(parsed.theme).toBe('dark');
  });

  it('replaces opencode.json instead of truncating it in place when deregistering', () => {
    expect(registerOpenCodePluginInConfig()).toBe(0);
    const first = statSync(configPath);

    expect(uninstallOpenCodePlugin()).toBe(0);
    const second = statSync(configPath);

    expect(wasReplaced(first, second)).toBe(true);
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(parsed.plugin ?? []).toEqual([]);
  });
});