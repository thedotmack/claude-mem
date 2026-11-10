import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workerBinaryBuildOptions } from '../../scripts/worker-binary-build-options.js';

describe('standalone worker build', () => {
  it('refuses unsupported compiler runtimes before compiling a standalone worker', () => {
    for (const bunVersion of ['1.1.31', '1.2.15', 'unknown']) {
      expect(() => workerBinaryBuildOptions({ outfile: 'unused', bunVersion })).toThrow('Standalone deep search requires Bun 1.2.16+');
    }
  });
  it('initializes Zod before a custom schema even with a lazy root import', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-zod-binary-'));
    try {
      symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      const entry = join(dir, 'entry.ts');
      writeFileSync(entry, `import * as z from 'zod/v4';
export async function later() { return import('zod'); }
console.log(JSON.stringify(z.custom(v => typeof v === 'object').parse({ok: true})));`);
      const output = join(dir, process.platform === 'win32' ? 'probe.exe' : 'probe');
      const build = await Bun.build({ ...workerBinaryBuildOptions({ outfile: output }), entrypoints: [entry] } as any);
      expect(build.success).toBe(true);
      const run = spawnSync(output, [], { encoding: 'utf8', timeout: 15_000 });
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ ok: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it('starts the real standalone worker outside a plugin install', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-worker-binary-'));
    try {
      mkdirSync(join(dir, 'node_modules'));
      const output = join(dir, process.platform === 'win32' ? 'claude-mem.exe' : 'claude-mem');
      const build = spawnSync(process.execPath, ['scripts/build-native-worker.js', '--native', '--outfile', output], { encoding: 'utf8', timeout: 30_000 });
      expect(build.stderr).toBe('');
      expect(build.status).toBe(0);
      const run = spawnSync(output, ['hook', 'codex', 'file-context'], {
        cwd: dir, encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, DO_NOT_TRACK: '1', CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config'), CLAUDE_MEM_WORKER_AUTOSTART: 'false' },
        input: JSON.stringify({ cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(dir, 'absent.md') } }),
      });
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({ continue: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
