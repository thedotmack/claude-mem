/** Synthetic record/flush benchmark. Run: bun scripts/bench-telemetry-buffer.ts [pairs=200000].
 * The telemetry sink is replaced locally; no metrics leave this process.
 */
import { mock } from 'bun:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const captures: unknown[] = [];
mock.module(fileURLToPath(new URL('../src/services/telemetry/telemetry.ts', import.meta.url)), () => ({
  captureEvent: (event: string, properties: unknown) => captures.push({ event, properties }),
}));
const { telemetryBuffer } = await import('../src/services/telemetry/buffer.js');
Date.now = () => 1_700_000_000_000;
const count = Number(process.argv[2] ?? 200_000);
if (!Number.isSafeInteger(count) || count < 1) throw new Error('Count must be a positive safe integer');
Bun.gc(true);
const before = process.memoryUsage();
const started = performance.now();
for (let i = 0; i < count; i++) {
  telemetryBuffer.record('context_injected', null, {
    outcome: i % 13 ? 'ok' : 'error', tokens_injected: i % 17 * 100,
    observation_count: i % 7, tokens_saved_vs_naive: i % 19 * 300,
  });
  telemetryBuffer.record('session_compressed', i % 64, {
    outcome: i % 11 ? 'ok' : 'aborted', abort_reason: i % 11 ? undefined : 'deadline_exceeded',
    tokens_input: i % 17 * 150, tokens_output: i % 23 * 50, cost_usd: 0.0001 * (i % 13),
    duration_ms: i % 127 * 100, compression_ms: i % 5 ? i % 31 * 100 : undefined,
    model: 'model-' + i % 3, ide: 'claude', provider: 'claude', observed_model: 'model-0',
    observed_billing: 'api', count: i % 5, obs_type_discovery: i % 5,
  });
}
const recordMs = performance.now() - started;
Bun.gc(true);
const buffered = process.memoryUsage();
const flushing = performance.now();
telemetryBuffer.drainAllSessions('worker_shutdown');
telemetryBuffer.flush();
const flushMs = performance.now() - flushing;
console.log(JSON.stringify({ count, events: captures.length, recordMs, flushMs, totalMs: recordMs + flushMs,
  retainedHeap: buffered.heapUsed - before.heapUsed, peakRss: process.resourceUsage().maxRSS * 1024,
  checksum: createHash('sha256').update(JSON.stringify(captures)).digest('hex') }));
