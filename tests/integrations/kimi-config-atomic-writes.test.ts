import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  KIMI_MARKER_BEGIN,
  configureKimiMcp,
  installKimiHooks,
  uninstallKimiHooks,
} from '../../src/services/integrations/KimiHooksInstaller.js';

// Kimi's config.toml and mcp.json are user-owned files, so a write over an
// existing one must replace it rather than truncate it in place: an interrupted
// install or uninstall then cannot leave a half-written TOML/JSON that stops
// Kimi from loading the rest of its config. An in-place truncate keeps the same
// file; a temp-file-plus-rename write yields a new one.
describe('Kimi writes config.toml and mcp.json atomically', () => {
  let tmp: string;
  let configPath: string;
  let mcpPath: string;
  let previousHome: string | undefined;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'kimi-atomic-'));
    configPath = path.join(tmp, 'config.toml');
    mcpPath = path.join(tmp, 'mcp.json');
    previousHome = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = tmp;
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  /** True when the write replaced the file rather than rewriting it in place. */
  function wasReplaced(before: ReturnType<typeof statSync>, after: ReturnType<typeof statSync>): boolean {
    return after.ino !== before.ino || after.birthtimeMs !== before.birthtimeMs;
  }

  it('replaces config.toml instead of truncating it in place on install', () => {
    writeFileSync(configPath, 'theme = "dark"\n');
    const first = statSync(configPath);

    expect(installKimiHooks()).toBe(0);
    const second = statSync(configPath);

    expect(wasReplaced(first, second)).toBe(true);
    const text = readFileSync(configPath, 'utf-8');
    expect(text).toContain('theme = "dark"');
    expect(text).toContain(KIMI_MARKER_BEGIN);
  });

  it('replaces mcp.json instead of truncating it in place when adding the server', () => {
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: { other: { command: 'other' } } }, null, 2) + '\n');
    const first = statSync(mcpPath);

    expect(configureKimiMcp()).toBe(0);
    const second = statSync(mcpPath);

    expect(wasReplaced(first, second)).toBe(true);
    const parsed = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(parsed.mcpServers.other).toEqual({ command: 'other' });
    expect(parsed.mcpServers['mcp-search'].args[0]).toEndWith('mcp-server.cjs');
  });

  it('replaces mcp.json instead of truncating it in place on uninstall', () => {
    expect(configureKimiMcp()).toBe(0);
    const first = statSync(mcpPath);

    expect(uninstallKimiHooks()).toBe(0);
    const second = statSync(mcpPath);

    expect(wasReplaced(first, second)).toBe(true);
    expect(JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers['mcp-search']).toBeUndefined();
  });

  it('replaces config.toml instead of truncating it in place on uninstall', () => {
    expect(installKimiHooks()).toBe(0);
    const first = statSync(configPath);

    expect(uninstallKimiHooks()).toBe(0);
    const second = statSync(configPath);

    expect(wasReplaced(first, second)).toBe(true);
    expect(readFileSync(configPath, 'utf-8')).not.toContain(KIMI_MARKER_BEGIN);
  });
});