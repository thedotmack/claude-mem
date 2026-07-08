import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

function readSource(...parts: string[]): string {
  return readFileSync(join(import.meta.dir, '..', '..', ...parts), 'utf-8');
}

function readMcpLauncherCommand(): string {
  return JSON.parse(readSource('plugin', '.mcp.json')).mcpServers['mcp-search'].args[1];
}

describe('windowsHide regression coverage (#2900)', () => {
  it('keeps windowsHide on the remaining live spawn sites', () => {
    expect(readSource('src', 'services', 'infrastructure', 'ProcessManager.ts'))
      .toMatch(/spawnSync\('git',\s*\['-C',\s*cwd,\s*\.\.\.args\],\s*\{[\s\S]*?timeout:\s*5000,[\s\S]*?windowsHide:\s*true/s);
    expect(readSource('src', 'services', 'infrastructure', 'WorktreeAdoption.ts'))
      .toMatch(/spawnSync\('git',\s*\['-C',\s*cwd,\s*\.\.\.args\],\s*\{[\s\S]*?timeout:\s*GIT_TIMEOUT_MS,[\s\S]*?windowsHide:\s*true/s);
    expect(readSource('src', 'build', 'hook-shell-template.ts'))
      .toMatch(/c\.spawn\(process\.execPath,\s*\[[\s\S]*?\],\s*\{[\s\S]*?stdio:'inherit',windowsHide:true[\s\S]*?\}/s);
    expect(readSource('src', 'services', 'worker-service.ts'))
      .toMatch(/spawn\(process\.execPath,\s*\[serverScript,\s*command,\s*\.\.\.extraArgs\],\s*\{[\s\S]*?stdio:\s*'inherit',[\s\S]*?windowsHide:\s*true/s);
    expect(readSource('src', 'server', 'runtime', 'ServerService.ts'))
      .toMatch(/spawn\(process\.execPath,\s*\[scriptPath,\s*'--daemon'\],\s*\{[\s\S]*?stdio:\s*'ignore',[\s\S]*?windowsHide:\s*true/s);
    expect(readSource('src', 'npx-cli', 'commands', 'doctor.ts'))
      .toMatch(/spawnSync\(command,\s*args,\s*\{[\s\S]*?stdio:\s*\['pipe',\s*'pipe',\s*'pipe'\],[\s\S]*?windowsHide:\s*true/s);
    expect(readSource('src', 'npx-cli', 'install', 'setup-runtime.ts'))
      .toMatch(/spawnSync\(resolved\.command,\s*resolved\.args,\s*\{[\s\S]*?stdio:\s*\['pipe',\s*'pipe',\s*'pipe'\],[\s\S]*?windowsHide:\s*true/s);
    expect(readMcpLauncherCommand())
      .toMatch(/c\.spawn\(process\.execPath,\s*\[[\s\S]*?\],\s*\{[\s\S]*?stdio:'inherit',windowsHide:true[\s\S]*?\}/s);
  });
});
