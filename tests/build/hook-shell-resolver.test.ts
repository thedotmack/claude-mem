import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildShellCommand } from '../../src/build/hook-shell-template.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  return path.join(tmpdir(), `claude-mem-hookresolver-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// The emitted POSIX hook prelude resolves which cached plugin build spawns the
// worker. Resolving by mtime (`ls -dt`) picks a stale build, manufacturing the
// plugin<->worker version skew that drives the chroma-mcp orphan leak (#3216).
// This runs the REAL generated command through `sh` and asserts semver order.
describe.skipIf(process.platform === 'win32')('hook-shell-template — POSIX cache resolver', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the highest-semver cache build, not the newest mtime', () => {
    const configDir = makeTempDir();
    tempDirs.push(configDir);
    const cacheRoot = path.join(configDir, 'plugins', 'cache', 'thedotmack', 'claude-mem');

    const versionsAscending = ['13.4.0', '13.9.2', '13.10.0', '13.10.4', '13.11.0'];
    versionsAscending.forEach((version, index) => {
      const scriptsDir = path.join(cacheRoot, version, 'plugin', 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      writeFileSync(path.join(scriptsDir, 'bun-runner.js'), '// stub');
      writeFileSync(path.join(scriptsDir, 'worker-service.cjs'), '// stub');
      // Lowest semver (13.4.0) is the mtime-NEWEST dir — the exact skew `ls -dt` fell for.
      const mtime = new Date(2026, 0, 1, 0, 0, versionsAscending.length - index);
      utimesSync(path.join(cacheRoot, version), mtime, mtime);
      utimesSync(path.join(cacheRoot, version, 'plugin'), mtime, mtime);
    });

    // Emit the real claude-code hook command, but with a trailing `printf "$_P"`
    // so we can observe which plugin root it resolved.
    const cmd = buildShellCommand({
      host: 'claude-code',
      requireFile: 'bun-runner.js',
      requireFileSecondary: 'worker-service.cjs',
      trailingCommand: ['printf', "'%s\\n'", '"$_P"'],
      notFoundMessage: 'claude-mem: plugin scripts not found',
    });

    const stdout = execFileSync('sh', ['-c', cmd], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, SHELL: '/bin/sh' },
      encoding: 'utf8',
    }).trim();

    // _P resolves to <cacheRoot>/<version>/plugin.
    const resolvedVersion = path.relative(cacheRoot, stdout).split(path.sep)[0];
    expect(resolvedVersion).toBe('13.11.0');
  });
});
