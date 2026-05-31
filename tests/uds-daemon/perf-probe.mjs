#!/usr/bin/env node
// Measure cold-spawn Bun + worker-service.cjs hook roundtrip (baseline).
import { spawnSync } from 'child_process';
import { performance } from 'perf_hooks';

const PLUGIN = process.env.PLUGIN_ROOT ||
  '/Users/rob/.claude/plugins/cache/thedotmack/claude-mem/13.3.0';

const PAYLOAD = JSON.stringify({
  session_id: 'perf-probe',
  transcript_path: '/tmp/x.jsonl',
  cwd: process.cwd(),
  permission_mode: 'default',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo perf' },
  tool_response: { stdout: 'perf\n', exitCode: 0 },
});

const N = parseInt(process.env.N || '5', 10);
const latencies = [];

for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  spawnSync(
    'bun',
    [`${PLUGIN}/scripts/worker-service.cjs`, 'hook', 'claude-code', 'observation'],
    { input: PAYLOAD, encoding: 'utf-8', timeout: 30000 },
  );
  const t1 = performance.now();
  latencies.push(t1 - t0);
}

latencies.sort((a, b) => a - b);
const result = {
  n: N,
  min: Math.round(latencies[0]),
  p50: Math.round(latencies[Math.floor(N / 2)]),
  max: Math.round(latencies[N - 1]),
  all: latencies.map(x => Math.round(x)),
  plugin: PLUGIN,
  measured_at: new Date().toISOString(),
};
console.log(JSON.stringify(result, null, 2));
