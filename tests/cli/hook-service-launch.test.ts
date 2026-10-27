import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const runner = join(import.meta.dir, '../../plugin/scripts/bun-runner.js');

describe('bun-runner hook-only service selection', () => {
  it('runs a capable Codex hook inside the existing Node process with stdin held open', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-hook-node-'));
    const record = join(root, 'called.json');
    try {
      writeFileSync(join(root, 'worker-service.cjs'), 'throw new Error("full worker loaded");');
      writeFileSync(join(root, 'hook-service.cjs'), `// claude-mem hook-service library v1\nexports.canRunInNode=()=>true;exports.runHookService=async(platform,event,{stdin})=>{let input='';for await(const chunk of stdin)input+=chunk;require('fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,platform,event,input:JSON.parse(input)}));};`);
      const child = Bun.spawn(['node', runner, join(root, 'worker-service.cjs'), 'hook', 'codex', 'observation'], {
        env: { ...process.env, BUN: process.execPath, CLAUDE_CONFIG_DIR: join(root, 'config') }, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe',
      });
      child.stdin.write('{"text":"Grüße 🙂"}');
      expect(await child.exited).toBe(0);
      expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ pid: child.pid, platform: 'codex', event: 'observation', input: { text: 'Grüße 🙂' } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it.each(['local', 'server', 'remote'])('keeps runtime eligibility bounded for %s mode', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'cm-hook-eligibility-'));
    try {
      writeFileSync(join(root, 'settings.json'), '{}');
      const bundle = join(import.meta.dir, '../../plugin/scripts/hook-service.cjs');
      const child = Bun.spawn(['node', '-e', `const m=require(${JSON.stringify(bundle)});console.log(JSON.stringify({capture:m.canRunInNode('codex','observation'),read:m.canRunInNode('codex','file-context'),other:m.canRunInNode('claude-code','observation')}));`], {
        env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_MEM_DATA_DIR: root,
          CLAUDE_MEM_RUNTIME: mode === 'server' ? 'server' : 'worker', CLAUDE_MEM_WORKER_HOST: mode === 'remote' ? '192.0.2.1' : '127.0.0.1',
          CLAUDE_MEM_HOOK_SPOOL_TRANSPORT: 'auto', CLAUDE_MEM_TELEMETRY: 'false', DO_NOT_TRACK: '1' },
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
      const output = new Response(child.stdout).text();
      const error = new Response(child.stderr).text();
      expect(await child.exited).toBe(0);
      expect(await error).toBe('');
      expect(JSON.parse(await output)).toEqual({ capture: mode === 'local', read: false, other: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);

  it('uses hook-service for hook commands and leaves other commands on worker-service', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cm-hook-service-'));
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    const record = join(root, 'selected.txt');
    const stub = (name: string) => `${name === 'hook' ? 'if(process.argv[2]!=="hook")process.exit(17);' : ''}require('fs').writeFileSync(${JSON.stringify(record)}, ${JSON.stringify(name)}); process.stdin.resume(); process.stdin.once('data',()=>process.exit(0));`;
    writeFileSync(join(scripts, 'hook-service.cjs'), stub('hook'));
    writeFileSync(join(scripts, 'worker-service.cjs'), stub('worker'));
    try {
      const hook = Bun.spawn(['node', runner, join(scripts, 'worker-service.cjs'), 'hook', 'codex', 'context'], {
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

      // existsSync also accepts a directory; emulate a mid-update sibling
      // that cannot be read as a bundle without needing platform ACL tricks.
      mkdirSync(join(scripts, 'hook-service.cjs'));
      const unreadable = Bun.spawn(['node', runner, join(scripts, 'worker-service.cjs'), 'hook', 'codex', 'context'], {
        env: { ...process.env, BUN: process.execPath, CLAUDE_CONFIG_DIR: join(root, 'config') }, stdin: new Blob(['{}']), stdout: 'ignore', stderr: 'pipe',
      });
      expect(await unreadable.exited).toBe(0);
      expect(readFileSync(record, 'utf8')).toBe('worker');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it.each(['bun', 'node'])('preserves the non-blocking %s exit when the host closes stdout', async (runtime) => {
    const root = mkdtempSync(join(tmpdir(), 'cm-hook-service-error-'));
    try {
      const entry = join(import.meta.dir, runtime === 'bun' ? '../../src/cli/hook-service.ts' : '../../plugin/scripts/hook-service.cjs');
      const child = Bun.spawn([runtime === 'bun' ? process.execPath : 'node', entry, 'hook', 'codex', 'observation'], {
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
