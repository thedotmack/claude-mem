import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const WORKER_SPAWNER_PATH = join(import.meta.dir, '../../src/services/worker-spawner.ts');
const source = readFileSync(WORKER_SPAWNER_PATH, 'utf-8');

describe('Worker spawner stale-socket guard (orphaned listener)', () => {
  it('probes real bindability in the parent, before spawning the detached daemon', () => {
    // The check must run in the user-facing parent (ensureWorkerStarted) — a
    // daemon spawned with stdio:'ignore' would fail invisibly and the parent
    // would report 'warming'. The probe must appear before spawnDaemon().
    const probeIdx = source.indexOf('probePortBind(port, workerHost)');
    const spawnIdx = source.indexOf('spawnDaemon(');
    expect(probeIdx).toBeGreaterThan(-1);
    expect(spawnIdx).toBeGreaterThan(-1);
    expect(probeIdx).toBeLessThan(spawnIdx);
  });

  it('only treats EADDRINUSE as a stale socket', () => {
    expect(source).toContain("bindProbe === 'EADDRINUSE'");
  });

  it('preserves non-conflict bind errors (EADDRNOTAVAIL / EACCES) instead of masking them', () => {
    // A genuine bind error must surface as itself, not as stale-socket guidance.
    expect(source).toContain("bindProbe && bindProbe !== 'EADDRINUSE'");
    expect(source).toContain('check CLAUDE_MEM_WORKER_HOST');
  });

  it('retries a bounded number of times and defers to a worker that becomes healthy', () => {
    expect(source).toContain('STALE_SOCKET_RETRIES');
    expect(source).toContain('Worker became healthy while waiting on a busy port');
  });

  it('surfaces the stale socket as a real dead result with actionable guidance', () => {
    expect(source).toContain('held by a stale socket with no healthy worker behind it');
    expect(source).toContain('set CLAUDE_MEM_WORKER_PORT to a');
    // Must return 'dead' (visible failure), not 'warming'.
    const guardIdx = source.indexOf('held by a stale socket with no healthy worker behind it');
    const deadIdx = source.indexOf("return 'dead'", guardIdx);
    expect(deadIdx).toBeGreaterThan(guardIdx);
  });

  it('tries the conservative stale-worker reclaim before giving stale-socket guidance', () => {
    const reclaimIdx = source.indexOf('reclaimStaleWorkerPort(port)');
    const guidanceIdx = source.indexOf('held by a stale socket with no healthy worker behind it');
    const spawnIdx = source.indexOf('spawnDaemon(');
    expect(reclaimIdx).toBeGreaterThan(-1);
    expect(reclaimIdx).toBeLessThan(guidanceIdx);
    expect(reclaimIdx).toBeLessThan(spawnIdx);
  });
});
