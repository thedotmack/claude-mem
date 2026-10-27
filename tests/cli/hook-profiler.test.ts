import { afterEach, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

const require = createRequire(import.meta.url);
const profiler = require('../../scripts/profile-claude-mem-hooks.cjs') as {
  parseOutput(text: string): { validJson: boolean; reason: string | null };
  runChild(options: { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; input: string; timeoutMs: number }): Promise<{
    pid: number; timedOut: boolean; elapsedMs: number; cleanup: { attempted: boolean; timedOut?: boolean } | null;
  }>;
  startFixture(runDir: string, nonce: string): Promise<{ child: ChildProcess; ready: { nonce: string; pid: number }; evidencePath: string }>;
  killOwnedTree(child: ChildProcess): Promise<unknown>;
  childEnvironment(overrides: NodeJS.ProcessEnv, inherited?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
};

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) await profiler.killOwnedTree(child);
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try { rmSync(dir, { recursive: true, force: true }); break; }
      catch (error: any) {
        if (error?.code !== 'EBUSY') throw error;
        if (attempt === 9) break; // Defender can retain a directory handle briefly.
        await Bun.sleep(100);
      }
    }
  }
});

describe('hook profiler trust boundaries', () => {
  test('rejects empty, malformed, and scalar stdout rather than counting false samples', () => {
    expect(profiler.parseOutput('').validJson).toBe(false);
    expect(profiler.parseOutput('{"continue":').validJson).toBe(false);
    expect(profiler.parseOutput('false').validJson).toBe(false);
    expect(profiler.parseOutput('{"continue":true}').validJson).toBe(true);
  });

  test('does not inherit provider credentials, server runtime, or disabling flags', () => {
    const env = profiler.childEnvironment({}, { PATH: 'test-path', CLAUDE_MEM_RUNTIME: 'server', CLAUDE_MEM_SERVER_URL: 'https://invalid.example', OPENAI_API_KEY: 'synthetic-secret', CLAUDE_MEM_DISABLE_TOOL_HOOKS: '1' });
    expect(env.PATH).toBe('test-path');
    expect(env.CLAUDE_MEM_RUNTIME).toBe('worker');
    expect(env.CLAUDE_MEM_WORKER_AUTOSTART).toBe('false');
    expect(env.CLAUDE_MEM_SERVER_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CLAUDE_MEM_DISABLE_TOOL_HOOKS).toBeUndefined();
  });

  test('fixture exposes the production text context and SSE readiness contracts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-profiler-fixture-'));
    dirs.push(dir);
    const fixture = await profiler.startFixture(dir, 'route-contract');
    children.push(fixture.child);
    expect(fixture.ready).toEqual(expect.objectContaining({ nonce: 'route-contract', pid: fixture.child.pid }));

    const context = await fetch('http://127.0.0.1:37877/api/context/inject?projects=test');
    expect(context.headers.get('content-type')).toContain('text/plain');
    expect(await context.text()).toBe('PROFILE_TIMELINE_CONTEXT');

    const ready = await fetch('http://127.0.0.1:37877/api/ready');
    expect(ready.headers.get('content-type')).toContain('text/event-stream');
    expect(await ready.text()).toContain('"phase":"ready"');
    const evidence = readFileSync(fixture.evidencePath, 'utf8');
    expect(evidence).toContain('/api/context/inject');
    expect(evidence).toContain('/api/ready');
    const secondDir = mkdtempSync(join(tmpdir(), 'hook-profiler-collision-'));
    dirs.push(secondDir);
    await expect(profiler.startFixture(secondDir, 'intruder')).rejects.toThrow('fixture bind failed');
  }, 30_000);

  test('timeout is bounded and kills the owned process tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hook-profiler-timeout-'));
    dirs.push(dir);
    const started = Date.now();
    const descendantFile = join(dir, 'descendant.pid');
    const result = await profiler.runChild({
      file: process.execPath,
      args: ['-e', `const{spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(descendantFile)},String(child.pid));setInterval(()=>{},1000)`],
      cwd: dir,
      env: process.env,
      input: '{}',
      timeoutMs: 5000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.cleanup?.attempted).toBe(true);
    const descendant = Number(readFileSync(descendantFile, 'utf8'));
    for (const pid of [result.pid, descendant]) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      expect(alive).toBe(false);
    }
    expect(Date.now() - started).toBeLessThan(25_000);
  }, 40_000);
});
