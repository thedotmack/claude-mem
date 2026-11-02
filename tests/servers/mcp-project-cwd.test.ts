import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveMcpProjectCwd } from '../../src/servers/mcp-project-cwd.js';

const temp = mkdtempSync(join(tmpdir(), 'mcp-project-cwd-'));
afterEach(() => rmSync(temp, { recursive: true, force: true }));

function directory(name: string): string {
  const path = join(temp, name);
  mkdirSync(path, { recursive: true });
  return path;
}

describe('resolveMcpProjectCwd', () => {
  it('prefers a valid client root over PWD and the process launch directory', () => {
    const pluginRoot = directory('plugin');
    const processCwd = directory('plugin/scripts');
    const pwd = directory('shell-project');
    const root = directory('client-project');

    expect(resolveMcpProjectCwd({
      roots: [{ uri: pathToFileURL(root).href }],
      fallbackCwd: processCwd,
      pwd,
      pluginRoot,
    })).toEqual({ cwd: root, source: 'roots' });
  });

  it('uses PWD only when the server launch directory is inside its plugin root', () => {
    const pluginRoot = directory('plugin');
    const processCwd = directory('plugin/scripts');
    const pwd = directory('workspace');

    expect(resolveMcpProjectCwd({ fallbackCwd: processCwd, pwd, pluginRoot }))
      .toEqual({ cwd: pwd, source: 'pwd' });
  });

  it('ignores PWD when the process was launched outside the plugin root', () => {
    const pluginRoot = directory('plugin');
    const processCwd = directory('workspace');
    const stalePwd = directory('other-workspace');

    expect(resolveMcpProjectCwd({ fallbackCwd: processCwd, pwd: stalePwd, pluginRoot }))
      .toEqual({ cwd: processCwd, source: 'process' });
  });

  it('falls back to process.cwd() when PWD is not an existing directory', () => {
    const pluginRoot = directory('plugin');
    const processCwd = directory('plugin/scripts');

    expect(resolveMcpProjectCwd({ fallbackCwd: processCwd, pwd: join(temp, 'gone'), pluginRoot }))
      .toEqual({ cwd: processCwd, source: 'process' });
  });
});
