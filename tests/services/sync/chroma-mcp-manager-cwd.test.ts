import { describe, it, expect, mock } from 'bun:test';
import os from 'os';
import { readFileSync } from 'fs';
import { join } from 'path';

const CHROMA_MCP_MANAGER_PATH = join(
  import.meta.dir, '..', '..', '..', 'src', 'services', 'sync', 'ChromaMcpManager.ts'
);

describe('ChromaMcpManager: cwd isolation from project .env files (#1297)', () => {
  it('getSpawnCwd resolves to os.homedir()', () => {
    const source = readFileSync(CHROMA_MCP_MANAGER_PATH, 'utf-8');

    expect(source).toContain('private getSpawnCwd(): string {');
    expect(source).toContain('return os.homedir();');
  });

  it('the transport constructor passes through the resolved spawn cwd', () => {
    const source = readFileSync(CHROMA_MCP_MANAGER_PATH, 'utf-8');

    const transportBlockMatch = source.match(
      /new StdioClientTransport\(\s*\{([\s\S]*?)\}\s*\)/
    );
    expect(transportBlockMatch).not.toBeNull();

    const constructorBody = transportBlockMatch![1];
    expect(constructorBody).toContain('cwd');
    expect(constructorBody).toContain('cwd: spawnCwd');
  });

  it('os module is imported (required for os.homedir())', () => {
    const source = readFileSync(CHROMA_MCP_MANAGER_PATH, 'utf-8');
    expect(source).toMatch(/import os from ['"]os['"]/);
  });
});
