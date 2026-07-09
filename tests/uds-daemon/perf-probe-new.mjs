#!/usr/bin/env bun
// Measure NEW hook path: hook-client.mjs → UDS daemon → ack.
// Compare against baseline (worker-service.cjs cold-spawn).
import { spawn } from 'bun';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = import.meta.dir;
const SRC = join(HERE, '..', 'src');
const tmp = mkdtempSync(join(tmpdir(), 'cm-perf-'));
const sockPath = join(tmp, 'daemon.sock');

// Start daemon, wait for socket
const daemon = spawn({
  cmd: ['bun', join(SRC, 'daemon-server.mjs'), '--socket', sockPath, '--data-dir', tmp],
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (let i = 0; i < 80; i++) {
  if (existsSync(sockPath)) break;
  await Bun.sleep(25);
}
if (!existsSync(sockPath)) {
  console.error('daemon failed to start');
  process.exit(1);
}

const PAYLOAD = JSON.stringify({
  session_id: 'perf-new',
  transcript_path: '/tmp/x.jsonl',
  cwd: process.cwd(),
  permission_mode: 'default',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo perf' },
  tool_response: { stdout: 'perf\n', exitCode: 0 },
});

const N = parseInt(process.env.N || '7', 10);
const latencies = [];
const skipLatencies = [];

// 1. Hook-Path with INTERESTING tool (full pipe)
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  spawnSync(
    'bun',
    [join(SRC, 'hook-client.mjs'), '--event', 'observation', '--socket', sockPath],
    { input: PAYLOAD, encoding: 'utf-8', timeout: 5000 },
  );
  const t1 = performance.now();
  latencies.push(t1 - t0);
}

// 2. Fast-skip case (TodoWrite, should be ~5ms internal logic + bun cold start)
const SKIP_PAYLOAD = JSON.stringify({
  hook_event_name: 'PostToolUse',
  tool_name: 'TodoWrite',
  tool_input: {},
});
for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  spawnSync(
    'bun',
    [join(SRC, 'hook-client.mjs'), '--event', 'observation', '--socket', sockPath],
    { input: SKIP_PAYLOAD, encoding: 'utf-8', timeout: 5000 },
  );
  const t1 = performance.now();
  skipLatencies.push(t1 - t0);
}

try { daemon.kill('SIGTERM'); } catch {}
rmSync(tmp, { recursive: true, force: true });

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return {
    n: s.length,
    min: Math.round(s[0]),
    p50: Math.round(s[Math.floor(s.length / 2)]),
    max: Math.round(s[s.length - 1]),
    all: s.map(x => Math.round(x)),
  };
}

console.log(JSON.stringify({
  measured_at: new Date().toISOString(),
  full_pipe: stats(latencies),
  fast_skip: stats(skipLatencies),
}, null, 2));
