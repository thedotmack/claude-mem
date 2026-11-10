import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { installHermesIntegration } from '../../src/services/integrations/HermesInstaller.js';

// Hermes' config.yaml is the user's own file and can hold credentials, so a
// replacement must never expose a half-written file. The hand-rolled staging
// write had no fsync and no directory sync, so the rename could land before the
// bytes did, and it left its staging file behind if the rename failed. The
// shared helper fsyncs the file and its directory and cleans its own temp file;
// the write it performs also lands as a new inode, which is what this measures.
describe('Hermes writes config.yaml atomically', () => {
  let tmp: string;
  let configPath: string;
  let previousHome: string | undefined;
  let previousDevSource: string | undefined;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'hermes-atomic-'));
    configPath = path.join(tmp, 'config.yaml');
    previousHome = process.env.HERMES_HOME;
    previousDevSource = process.env.CLAUDE_MEM_DEV_HOOK_SOURCE;
    process.env.HERMES_HOME = tmp;
    // Resolve the plugin from the repository checkout; a test environment has
    // no marketplace install.
    process.env.CLAUDE_MEM_DEV_HOOK_SOURCE = '1';
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    if (previousDevSource === undefined) delete process.env.CLAUDE_MEM_DEV_HOOK_SOURCE;
    else process.env.CLAUDE_MEM_DEV_HOOK_SOURCE = previousDevSource;
    rmSync(tmp, { recursive: true, force: true });
  });

  /** True when the write replaced the file rather than rewriting it in place. */
  function wasReplaced(before: ReturnType<typeof statSync>, after: ReturnType<typeof statSync>): boolean {
    return after.ino !== before.ino || after.birthtimeMs !== before.birthtimeMs;
  }

  it('replaces config.yaml instead of rewriting it in place', () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(configPath, 'memory:\n  provider: none\n');
    const first = statSync(configPath);

    expect(installHermesIntegration()).toBe(0);
    const second = statSync(configPath);

    expect(wasReplaced(first, second)).toBe(true);
    expect(readFileSync(configPath, 'utf-8')).toContain('claude-mem');
  });

  it('leaves no staging file behind', () => {
    writeFileSync(configPath, 'memory:\n  provider: none\n');

    expect(installHermesIntegration()).toBe(0);

    expect(readdirSync(tmp).filter(name => name.includes('.tmp'))).toEqual([]);
  });
});