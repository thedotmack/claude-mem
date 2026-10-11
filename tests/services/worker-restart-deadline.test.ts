import { expect, it, spyOn } from 'bun:test';
import { verifyRestartedWorker } from '../../src/services/restart-verify.js';

it('does not accept health that arrives after the restart deadline', async () => {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() {
    await Bun.sleep(300);
    return Response.json({ pid: 22222, version: 'deadline-test' });
  } });
  try {
    const start = performance.now();
    const result = await verifyRestartedWorker(server.port!, 11111, 'deadline-test', 60, { requestTimeoutMs: 1000, pollIntervalMs: 10 });
    expect(result.ok).toBe(false);
    expect(performance.now() - start).toBeLessThan(250);
  } finally { server.stop(true); }
});

it('limits the polling sleep to the remaining restart budget', async () => {
  let requested = false;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() {
    requested = true;
    return Response.json({ pid: 11111, version: 'deadline-test' });
  } });
  try {
    const start = performance.now();
    const result = await verifyRestartedWorker(server.port!, 11111, 'deadline-test', 60, { requestTimeoutMs: 1000, pollIntervalMs: 500 });
    expect(requested).toBe(true);
    expect(result.ok).toBe(false);
    expect(performance.now() - start).toBeLessThan(300);
  } finally { server.stop(true); }
});


it('rejects valid health returned after a controlled deadline without a request timeout', async () => {
  let now = 1000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() {
    now = 1061;
    return Response.json({ pid: 22222, version: 'deadline-test' });
  } });
  try {
    const result = await verifyRestartedWorker(server.port!, 11111, 'deadline-test', 60, { requestTimeoutMs: 1000, pollIntervalMs: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expired health was accepted');
    expect(result.lastPollSawHealth).toBe(true);
    expect(result.lastObserved).toContain('22222');
  } finally { server.stop(true); clock.mockRestore(); }
});
