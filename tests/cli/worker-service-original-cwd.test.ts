import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The on-PATH launcher (and bun-runner.js) start Bun in a neutral directory
// and pass the caller's directory in CLAUDE_MEM_HOOK_ORIGINAL_CWD (#4628).
// Subcommands that act on the current project must run there, not in the
// neutral directory.
const repoRoot = join(import.meta.dir, '..', '..');
const workerService = join(repoRoot, 'src', 'services', 'worker-service.ts');
const sandboxes: string[] = [];
afterEach(() => { for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('worker-service subcommands launched from a neutral directory', () => {
  it('clean acts on the caller\'s directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-original-cwd-')); sandboxes.push(root);
    const neutral = join(root, 'neutral'); const project = join(root, 'project'); const data = join(root, 'data');
    mkdirSync(neutral); mkdirSync(join(project, 'sub'), { recursive: true }); mkdirSync(data);
    const generated = '<claude-mem-context>\nold activity\n</claude-mem-context>\n';
    writeFileSync(join(project, 'sub', 'CLAUDE.md'), generated);
    writeFileSync(join(neutral, 'CLAUDE.md'), generated);

    const run = Bun.spawnSync([process.execPath, workerService, 'clean'], {
      cwd: neutral,
      env: { ...process.env, CLAUDE_MEM_HOOK_ORIGINAL_CWD: project, CLAUDE_MEM_DATA_DIR: data, CLAUDE_CONFIG_DIR: data, CLAUDE_MEM_TELEMETRY: '0' },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(run.exitCode).toBe(0);

    const projectFile = join(project, 'sub', 'CLAUDE.md');
    expect(existsSync(projectFile) ? readFileSync(projectFile, 'utf8') : '').not.toContain('old activity');
    expect(readFileSync(join(neutral, 'CLAUDE.md'), 'utf8')).toBe(generated);
  }, 30_000);
  it('cursor status reads the caller\'s project .cursor', () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-original-cwd-')); sandboxes.push(root);
    const neutral = join(root, 'neutral'); const project = join(root, 'project'); const data = join(root, 'data');
    mkdirSync(neutral); mkdirSync(join(project, '.cursor'), { recursive: true }); mkdirSync(data);
    // A hooks.json with no claude-mem entries: status reports it by its user-hook count.
    writeFileSync(join(project, '.cursor', 'hooks.json'), '{"version":1,"hooks":{}}');

    const run = Bun.spawnSync([process.execPath, workerService, 'cursor', 'status'], {
      cwd: neutral,
      env: { ...process.env, HOME: data, USERPROFILE: data, CLAUDE_MEM_HOOK_ORIGINAL_CWD: project, CLAUDE_MEM_DATA_DIR: data, CLAUDE_CONFIG_DIR: data, CLAUDE_MEM_TELEMETRY: '0' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const stdout = run.stdout.toString();
    expect(stdout).toContain('Project: Not installed (hooks.json has 0 user hooks)');
  }, 30_000);
});
