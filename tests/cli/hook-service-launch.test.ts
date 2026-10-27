import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const runner = join(import.meta.dir, '../../plugin/scripts/bun-runner.js');

describe('bun-runner hook-only service selection', () => {
  it('uses hook-service for hook commands and leaves other commands on worker-service', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-hook-service-'));
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    const record = join(root, 'selected.txt');
    const stub = (name: string) => `require('fs').writeFileSync(${JSON.stringify(record)}, ${JSON.stringify(name)}); process.stdin.resume(); process.stdin.once('data',()=>process.exit(0));`;
    writeFileSync(join(scripts, 'hook-service.cjs'), stub('hook'));
    writeFileSync(join(scripts, 'worker-service.cjs'), stub('worker'));
    try {
      const hook = Bun.spawn([process.execPath, runner, join(scripts, 'worker-service.cjs'), 'hook', 'codex', 'context'], {
        env: { ...process.env, BUN: process.execPath, CLAUDE_CONFIG_DIR: join(root, 'config') }, stdin: new Blob(['{}']), stdout: 'ignore', stderr: 'pipe',
      });
      expect(await hook.exited).toBe(0);
      expect(readFileSync(record, 'utf8')).toBe('hook');

      const command = Bun.spawn([process.execPath, runner, join(scripts, 'worker-service.cjs'), 'status'], {
        env: { ...process.env, BUN: process.execPath, CLAUDE_CONFIG_DIR: join(root, 'config') }, stdin: new Blob(['{}']), stdout: 'ignore', stderr: 'pipe',
      });
      expect(await command.exited).toBe(0);
      expect(readFileSync(record, 'utf8')).toBe('worker');

      unlinkSync(join(scripts, 'hook-service.cjs'));
      const legacy = Bun.spawn([process.execPath, runner, join(scripts, 'worker-service.cjs'), 'hook', 'codex', 'context'], {
        env: { ...process.env, BUN: process.execPath, CLAUDE_CONFIG_DIR: join(root, 'config') }, stdin: new Blob(['{}']), stdout: 'ignore', stderr: 'pipe',
      });
      expect(await legacy.exited).toBe(0);
      expect(readFileSync(record, 'utf8')).toBe('worker');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('preserves the non-blocking exit when the host closes stdout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-hook-service-error-'));
    try {
      const entry = join(import.meta.dir, '../../src/cli/hook-service.ts');
      const child = Bun.spawn([process.execPath, entry, 'hook', 'codex', 'observation'], {
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: root, CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_MEM_WORKER_PORT: '37878', CLAUDE_MEM_DISABLE_TOOL_HOOKS: '1', CLAUDE_MEM_TELEMETRY: 'false', DO_NOT_TRACK: '1' },
        stdin: new Blob(['{}']), stdout: 'pipe', stderr: 'pipe',
      });
      await child.stdout.cancel();
      const stderr = new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      expect(await stderr).not.toContain('Unhandled');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
