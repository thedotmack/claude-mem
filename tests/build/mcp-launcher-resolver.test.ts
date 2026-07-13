import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildShellCommand, buildCodexWindowsCommand } from '../../src/build/hook-shell-template.js';

const tempDirs: string[] = [];
function makeTempDir(): string {
  return path.join(tmpdir(), `claude-mem-mcplauncher-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('MCP / Codex cache resolvers (inline-JS)', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  // The .mcp.json Node launcher discovers the plugin build to spawn. mtime
  // resolution picks a stale build (issue #3216). Execute the REAL launcher
  // against a temp cache (its mcp-server.cjs is a stub that prints its path).
  it('MCP Node launcher resolves the highest-semver build, not newest mtime', () => {
    const configDir = makeTempDir();
    tempDirs.push(configDir);
    const cacheRoot = path.join(configDir, 'plugins', 'cache', 'thedotmack', 'claude-mem');
    const versionsAscending = ['13.4.0', '13.9.2', '13.10.0', '13.10.4', '13.11.0'];
    versionsAscending.forEach((version, index) => {
      const scriptsDir = path.join(cacheRoot, version, 'plugin', 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(path.join(scriptsDir, 'mcp-server.cjs'), 'console.log(process.argv[1]);');
      const mtime = new Date(2026, 0, 1, 0, 0, versionsAscending.length - index);
      utimesSync(path.join(cacheRoot, version), mtime, mtime);
      utimesSync(path.join(cacheRoot, version, 'plugin'), mtime, mtime);
    });

    const body = buildShellCommand({
      host: 'mcp',
      requireFile: 'mcp-server.cjs',
      notFoundMessage: 'claude-mem: mcp-server not found',
    });

    const stdout = execFileSync('node', ['-e', body], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      encoding: 'utf8',
    }).trim();

    const resolvedVersion = path.relative(cacheRoot, stdout).split(path.sep)[0];
    expect(resolvedVersion).toBe('13.11.0');
  });

  // Windows-only command → structural drift guard: the mtime sort must be gone,
  // replaced by a numeric MAJOR.MINOR.PATCH comparator.
  it('Codex Windows command sorts cache dirs by semver, not mtime', () => {
    const cmd = buildCodexWindowsCommand(['--foo']);
    expect(cmd).not.toContain('mtimeMs');
    expect(cmd).toContain('(\\d+)\\.(\\d+)\\.(\\d+)');
  });
});
