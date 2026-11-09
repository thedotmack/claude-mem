import { expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// bun-runner records an empty hook payload (#2188) under the data dir. A
// `~/x` CLAUDE_MEM_DATA_DIR must resolve under home, not as a literal `~`
// directory inside the project the hook was launched from.
const runner = join(import.meta.dir, '..', 'plugin', 'scripts', 'bun-runner.js');

it('records an empty stdin payload under a ~-relative CLAUDE_MEM_DATA_DIR in home, not the project', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cmem-bun-runner-')));
  try {
    const home = join(root, 'home');
    const project = join(root, 'project');
    mkdirSync(home);
    mkdirSync(project);
    const stub = join(root, 'stub.js');
    writeFileSync(stub, 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));\n');
    const result = spawnSync(process.execPath, [runner, stub, 'hook', 'claude-code', 'observation'], {
      cwd: project,
      input: '',
      env: { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, CLAUDE_MEM_DATA_DIR: '~/tilde-data' },
      encoding: 'utf-8',
    });
    expect(result.stderr).toContain('empty stdin payload received — issue #2188');
    expect(readFileSync(join(home, 'tilde-data', 'CAPTURE_BROKEN'), 'utf-8')).toContain('issue #2188');
    expect(existsSync(join(project, '~'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
