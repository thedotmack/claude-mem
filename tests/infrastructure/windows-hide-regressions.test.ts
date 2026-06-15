import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

function readSource(...parts: string[]): string {
  return readFileSync(join(import.meta.dir, '..', '..', ...parts), 'utf-8');
}

function readMcpLauncherCommand(): string {
  return JSON.parse(readSource('plugin', '.mcp.json')).mcpServers['mcp-search'].args[1];
}

function expectWindowsHideNear(source: string, pattern: RegExp): void {
  expect(source).toMatch(pattern);
}

describe('windowsHide regression coverage (#2900)', () => {
  it('keeps windowsHide on the remaining live spawn sites', () => {
    expectWindowsHideNear(
      readSource('src', 'services', 'infrastructure', 'ProcessManager.ts'),
      /spawnSync\('git',\s*\['-C',\s*cwd,\s*\.\.\.args\],\s*\{[\s\S]*?timeout:\s*5000,[\s\S]*?windowsHide:\s*true/s
    );
    expectWindowsHideNear(
      readSource('src', 'services', 'infrastructure', 'WorktreeAdoption.ts'),
      /spawnSync\('git',\s*\['-C',\s*cwd,\s*\.\.\.args\],\s*\{[\s\S]*?timeout:\s*GIT_TIMEOUT_MS,[\s\S]*?windowsHide:\s*true/s
    );
    expectWindowsHideNear(
      readSource('src', 'build', 'hook-shell-template.ts'),
      /c\.spawn\(process\.execPath,\s*\[[\s\S]*?\],\s*\{[\s\S]*?stdio:\s*'inherit',[\s\S]*?windowsHide:\s*true[\s\S]*?\}/s
    );
    expectWindowsHideNear(
      readSource('src', 'services', 'worker-service.ts'),
      /spawn\(process\.execPath,\s*\[serverScript,\s*command,\s*\.\.\.extraArgs\],\s*\{[\s\S]*?stdio:\s*'inherit',[\s\S]*?windowsHide:\s*true/s
    );
    expectWindowsHideNear(
      readSource('src', 'server', 'runtime', 'ServerService.ts'),
      /spawn\(process\.execPath,\s*\[scriptPath,\s*'--daemon'\],\s*\{[\s\S]*?stdio:\s*'ignore',[\s\S]*?windowsHide:\s*true/s
    );
    expectWindowsHideNear(
      readMcpLauncherCommand(),
      /c\.spawn\(process\.execPath,\s*\[[\s\S]*?\],\s*\{[\s\S]*?stdio:\s*'inherit',[\s\S]*?windowsHide:\s*true[\s\S]*?\}/s
    );
  });
});
