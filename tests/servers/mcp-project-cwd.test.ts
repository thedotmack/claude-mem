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
  it('falls back to process.cwd() when PWD is not an existing directory', () => {
    const pluginRoot = directory('plugin');
    const processCwd = directory('plugin/scripts');

    expect(resolveMcpProjectCwd({ fallbackCwd: processCwd, pwd: join(temp, 'gone'), pluginRoot }))
      .toEqual({ cwd: processCwd, source: 'process' });
  });
});

(process.platform === 'win32' ? describe.skip : describe)('literal MCP checkout whitespace', () => {
  for (const suffix of [' ', '\t', '\n']) {
    it(`does not replace a checkout ending in ${JSON.stringify(suffix)} with its sibling`, () => {
      const plain = directory('topic');
      const checkout = directory('topic' + suffix);
      expect(resolveMcpProjectCwd({ headerCwd: checkout, fallbackCwd: plain })).toEqual({ cwd: checkout, source: 'header' });
      expect(resolveMcpProjectCwd({ roots: [{ uri: pathToFileURL(checkout).href }], fallbackCwd: plain })).toEqual({ cwd: checkout, source: 'roots' });
      expect(resolveMcpProjectCwd({ fallbackCwd: checkout })).toEqual({ cwd: checkout, source: 'process' });
    });
  }
});
