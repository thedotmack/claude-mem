import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const CHROMA_MCP_MANAGER_PATH = join(
  import.meta.dir, '..', '..', '..', 'src', 'services', 'sync', 'ChromaMcpManager.ts'
);

describe('ChromaMcpManager: cwd isolation from project .env files (#1297)', () => {
  it('the cwd property appears inside the StdioClientTransport constructor call', () => {
    const source = readFileSync(CHROMA_MCP_MANAGER_PATH, 'utf-8');

    const transportBlockMatch = source.match(
      /new StdioClientTransport\(\s*\{([\s\S]*?)\}\s*\)/
    );
    expect(transportBlockMatch).not.toBeNull();

    const constructorBody = transportBlockMatch![1];
    expect(constructorBody).toContain('cwd');
    expect(constructorBody).toContain('homedir');
  });
});
