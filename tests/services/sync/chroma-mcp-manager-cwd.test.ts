import { describe, it, expect, mock } from 'bun:test';
import os from 'os';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Regression test for issue #1297.
 *
 * When the worker spawns chroma-mcp via StdioClientTransport, if the CWD is
 * the project directory and that directory contains a .env.local file with
 * non-chroma env vars, pydantic-settings crashes with "Extra inputs are not
 * permitted". The fix is to set `cwd: os.homedir()` so pydantic never reads
 * the project's env files.
 */

const CHROMA_MCP_MANAGER_PATH = join(
  import.meta.dir, '..', '..', '..', 'src', 'services', 'sync', 'ChromaMcpManager.ts'
);

describe('ChromaMcpManager: cwd isolation from project .env files (#1297)', () => {
  it('StdioClientTransport is constructed with cwd set to homedir', () => {
    // Source-level assertion: verify the fix is present in the source.
    // ChromaMcpManager uses StdioClientTransport (from @modelcontextprotocol/sdk),
    // which we cannot easily import in a unit test without spawning a real process.
    // A source inspection is the appropriate guardrail here.
    const source = readFileSync(CHROMA_MCP_MANAGER_PATH, 'utf-8');

    // The StdioClientTransport constructor call must include `cwd: os.homedir()`
    // (or equivalent) so that pydantic-settings in chroma-mcp does not read
    // .env.local from the project directory.
    expect(source).toContain('cwd: os.homedir()');
  });

  it('the cwd property appears inside the StdioClientTransport constructor call', () => {
    const source = readFileSync(CHROMA_MCP_MANAGER_PATH, 'utf-8');

    // Locate the StdioClientTransport constructor block and verify cwd is in it.
    const transportBlockMatch = source.match(
      /new StdioClientTransport\(\s*\{([\s\S]*?)\}\s*\)/
    );
    expect(transportBlockMatch).not.toBeNull();

    const constructorBody = transportBlockMatch![1];
    expect(constructorBody).toContain('cwd');
    expect(constructorBody).toContain('homedir');
  });

  it('os module is imported (required for os.homedir())', () => {
    const source = readFileSync(CHROMA_MCP_MANAGER_PATH, 'utf-8');
    // os is already imported in the original file — confirm it's still there
    expect(source).toMatch(/import os from ['"]os['"]/);
  });
});
